import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PenaiConfigSchema, type PenaiConfig } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import { adminQuery, createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry, type ChatRequest, type ChatResponse, type Provider, type StreamEvent } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import type { RuntimeDeps } from "../src/agent-runtime.js";
import { buildApp } from "../src/app.js";
import { getWsdbService, makeDbToolApi } from "../src/wsdb-service.js";
import { parseCsv } from "../src/wsdb-routes.js";

// CSDL của workspace (0037): API /v1/db/*, bước db + bước secret trong quy trình, tool db_* của agent.

class FakeProvider implements Provider {
  readonly name = "fake";
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return { content: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "done", response: await this.chat(req) };
  }
}

let fx: TestFixtures;
let dbh: DbHandle;
let config: PenaiConfig;
let rt: RuntimeDeps;
let app: FastifyInstance;
const auth = (k: string) => ({ authorization: `Bearer ${k}` });

beforeAll(async () => {
  vi.stubEnv("PENAI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("PENAI_PUBLIC_URL", "https://penai.test");
  await setupTestDatabase();
  fx = await createTestFixtures();
  await adminQuery("INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'ws_admin') ON CONFLICT DO NOTHING", [fx.userId, fx.wsA]);
  dbh = createDb(TEST_APP_URL);
  config = PenaiConfigSchema.parse({ dataDir: await mkdtemp(join(tmpdir(), "penai-wsdb-")), providers: {} });
  const providers = createProviderRegistry(config.providers);
  providers.registerRuntime(fx.wsA, "default", new FakeProvider());
  rt = { db: dbh, providers, tools: createDefaultToolRegistry(), config };
  app = buildApp(rt);
});

afterAll(async () => {
  await app.close();
  await dbh.close();
  vi.unstubAllEnvs();
});

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, key: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(key), ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("API /v1/db", () => {
  it("tạo bảng từ form → thêm / sửa / xóa dòng → đọc có phân trang", async () => {
    const pv = await req("POST", "/v1/db/tables", fx.keys.aOperator, { name: "khach_hang", comment: "Khách", columns: [{ name: "sdt", type: "text", unique: true, notNull: true }, { name: "ten", type: "text" }, { name: "diem", type: "integer", default: 0 }], preview: true });
    expect(pv.json().sql).toMatch(/CREATE TABLE "khach_hang"/);
    const mk = await req("POST", "/v1/db/tables", fx.keys.aOperator, { name: "khach_hang", comment: "Khách", columns: [{ name: "sdt", type: "text", unique: true, notNull: true }, { name: "ten", type: "text" }, { name: "diem", type: "integer", default: 0 }] });
    expect(mk.statusCode).toBe(200);
    const add = await req("POST", "/v1/db/tables/khach_hang/rows", fx.keys.aOperator, { values: { sdt: "0901", ten: "Lan" } });
    expect(add.json().row).toMatchObject({ sdt: "0901", ten: "Lan", diem: "0" });
    const id = add.json().row.id;
    await req("POST", "/v1/db/tables/khach_hang/rows", fx.keys.aOperator, { values: { sdt: "0902", ten: "Minh", diem: 5 } });
    const up = await req("PATCH", "/v1/db/tables/khach_hang/rows", fx.keys.aOperator, { key: { id }, values: { diem: 10 } });
    expect(up.json().row.diem).toBe("10");
    const list = await req("GET", "/v1/db/tables/khach_hang/rows?order=-diem&limit=1", fx.keys.aViewer);
    expect(list.json()).toMatchObject({ total: 2, rows: [{ sdt: "0901" }] });
    const del = await req("DELETE", "/v1/db/tables/khach_hang/rows", fx.keys.aOperator, { key: { id } });
    expect(del.json().deleted).toBe(1);
    const schema = await req("GET", "/v1/db/schema", fx.keys.aViewer);
    expect(schema.json().tables.map((t: { name: string }) => t.name)).toContain("khach_hang");
    expect(schema.json().canWrite).toBe(false);
  });

  it("viewer chỉ đọc; workspace khác không thấy bảng", async () => {
    expect((await req("POST", "/v1/db/tables/khach_hang/rows", fx.keys.aViewer, { values: { sdt: "1" } })).statusCode).toBe(403);
    expect((await req("POST", "/v1/db/query", fx.keys.aViewer, { sql: "DELETE FROM khach_hang WHERE sdt = '0902'" })).statusCode).toBe(403);
    const r = await req("POST", "/v1/db/query", fx.keys.aViewer, { sql: "SELECT count(*)::int AS n FROM khach_hang" });
    expect(r.json().row).toEqual({ n: 1 });
    expect((await req("GET", "/v1/db/tables/khach_hang/rows", fx.keys.bOperator)).statusCode).toBe(404);
    expect((await req("POST", "/v1/db/query", fx.keys.bOperator, { sql: "SELECT * FROM khach_hang" })).statusCode).toBe(400);
  });

  it("xóa bảng cần confirm; nhập + xuất CSV", async () => {
    await req("POST", "/v1/db/query", fx.keys.aOperator, { sql: "CREATE TABLE tam (ma text PRIMARY KEY, so int)" });
    const imp = await req("POST", "/v1/db/tables/tam/import", fx.keys.aOperator, { csv: "ma;so\nA;1\n\"B;x\";2\n" });
    expect(imp.json()).toEqual({ inserted: 2 });
    const csv = await req("GET", "/v1/db/tables/tam/export.csv", fx.keys.aViewer);
    expect(csv.body).toContain('"B;x",2');
    expect((await req("DELETE", "/v1/db/tables/tam", fx.keys.aOperator)).statusCode).toBe(409);
    expect((await req("DELETE", "/v1/db/tables/tam?confirm=1", fx.keys.aOperator)).statusCode).toBe(200);
    const audit = await req("GET", "/v1/db/audit", fx.keys.aViewer);
    expect(audit.json().entries.some((e: { kind: string }) => e.kind === "import")).toBe(true);
  });

  it("parseCsv: ngoặc kép, xuống dòng trong ô, dấu ;", () => {
    expect(parseCsv('a,b\n"x, y","dòng 1\ndòng 2"\n')).toEqual([["a", "b"], ["x, y", "dòng 1\ndòng 2"]]);
    expect(parseCsv("﻿a;b\r\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("Quy trình dùng CSDL + khóa bí mật", () => {
  const def = (steps: unknown[]) => ({ name: "CSDL thử", triggers: [{ type: "manual" }], steps });
  const create = async (d: unknown) => req("POST", "/v1/workflows", fx.keys.aOperator, { definition: d });

  it("bước db: upsert trong vòng lặp (dạng chọn) + SELECT có tham số; chạy thử không lưu", async () => {
    await req("POST", "/v1/db/query", fx.keys.aOperator, { sql: "CREATE TABLE don (ma text PRIMARY KEY, tong numeric NOT NULL, lan int NOT NULL DEFAULT 1)" });
    const c = await create(
      def([
        { id: "nguon", type: "code", code: "return [{ id: 'D1', total: 100 }, { id: 'D2', total: 50 }];" },
        {
          id: "lap",
          type: "loop",
          over: "steps.nguon.output",
          as: "d",
          body: [{ id: "luu", type: "db", op: "upsert", table: "don", match: ["ma"], values: { ma: "{{ d.id }}", tong: "{{ d.total }}", lan: { $inc: 1 } } }],
        },
        { id: "tong", type: "db", sql: "SELECT count(*)::int AS n, sum(tong)::int AS s, max(lan) AS lan FROM don WHERE tong >= $1", params: ["{{ 10 }}"] },
      ]),
    );
    expect(c.statusCode).toBe(201);
    const id = c.json().workflow.id;
    const dry = await req("POST", `/v1/workflows/${id}/test`, fx.keys.aOperator, { dryRun: true, wait: true });
    expect(dry.json().run.status).toBe("success");
    expect((await adminQuery<{ n: number }>(`SELECT count(*)::int AS n FROM wsdb_${fx.wsA.replace(/-/g, "")}.don`))[0]!.n).toBe(0);
    const r1 = await req("POST", `/v1/workflows/${id}/run`, fx.keys.aOperator, { wait: true });
    expect(r1.json().run.status).toBe("success");
    const r2 = await req("POST", `/v1/workflows/${id}/run`, fx.keys.aOperator, { wait: true });
    const tong = (r2.json().steps as Array<{ stepId: string; output: { row: unknown } }>).find((s) => s.stepId === "tong")!;
    expect(tong.output.row).toEqual({ n: 2, s: 150, lan: 2 });
    const audit = await req("GET", "/v1/db/audit", fx.keys.aViewer);
    expect(audit.json().entries.some((e: { via: string; workflowId: string }) => e.via === "workflow" && e.workflowId === id)).toBe(true);
  });

  it("lưu quy trình: SQL có {{ }} hoặc xóa mọi dòng không confirm → lỗi; SQL bị chặn → lỗi", async () => {
    const a = await create(def([{ id: "x", type: "db", sql: "SELECT * FROM don WHERE ma = '{{ inputs.ma }}'" }]));
    expect(a.statusCode).toBe(400);
    expect(JSON.stringify(a.json().issues)).toMatch(/\$1/);
    const b = await create(def([{ id: "x", type: "db", sql: "DELETE FROM don" }]));
    expect(b.statusCode).toBe(400);
    expect(JSON.stringify(b.json().issues)).toMatch(/confirm/);
    const c = await create(def([{ id: "x", type: "db", sql: "SELECT * FROM public.users" }]));
    expect(c.statusCode).toBe(400);
    const d = await create(def([{ id: "x", type: "db", op: "delete", table: "don" }]));
    expect(d.statusCode).toBe(400);
  });

  it("bước secret: lưu token mới, che trong mọi nhật ký (kể cả bước trước), info không lộ giá trị", async () => {
    const token = "tok_" + randomBytes(12).toString("hex");
    const c = await create(
      def([
        { id: "lay", type: "code", code: `return { access_token: '${token}', expires_in: 3600 };` },
        { id: "luu", type: "secret", op: "set", name: "SHOP_TOKEN", value: "{{ steps.lay.output.access_token }}", expiresIn: "{{ steps.lay.output.expires_in }}" },
        { id: "han", type: "secret", op: "info", name: "SHOP_TOKEN" },
        { id: "dung", type: "code", code: "return 'token=' + steps.lay.output.access_token;" },
      ]),
    );
    expect(c.statusCode).toBe(201);
    const run = await req("POST", `/v1/workflows/${c.json().workflow.id}/run`, fx.keys.aOperator, { wait: true });
    const body = run.json() as { run: { id: string; status: string }; steps: Array<{ stepId: string; output: Record<string, unknown> }> };
    expect(body.run.status).toBe("success");
    const han = body.steps.find((s) => s.stepId === "han")!.output;
    expect(han).toMatchObject({ exists: true, expired: false, writable: true });
    expect(Number(han.expiresInSec)).toBeGreaterThan(3500);
    const logs = await adminQuery<{ t: string }>("SELECT coalesce(input::text, '') || coalesce(output::text, '') || coalesce(error, '') AS t FROM workflow_run_steps WHERE run_id = $1", [body.run.id]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.t.includes(token))).toBe(false);
    const sec = await req("GET", "/v1/secrets", fx.keys.aOperator);
    expect(sec.json().secrets.find((s: { name: string }) => s.name === "SHOP_TOKEN")).toMatchObject({ workflowWritable: true, updatedVia: "workflow" });
    expect(JSON.stringify(sec.json())).not.toContain(token);
  });

  it("bước secret không ghi đè khóa nhập tay; lock chờ lượt rồi tự nhả", async () => {
    await req("POST", "/v1/secrets", fx.keys.aOperator, { name: "MANUAL", value: "abc123456" });
    const c = await create(def([{ id: "ghi", type: "secret", op: "set", name: "MANUAL", value: "moi" }]));
    const run = await req("POST", `/v1/workflows/${c.json().workflow.id}/run`, fx.keys.aOperator, { wait: true });
    expect(run.json().run.status).toBe("failed");
    expect(run.json().run.error).toMatch(/Quy trình được ghi/);
    const l = await create(def([{ id: "k", type: "secret", op: "lock", name: "SHOP_TOKEN", wait: "5s" }, { id: "x", type: "code", code: "return 1" }]));
    const r1 = await req("POST", `/v1/workflows/${l.json().workflow.id}/run`, fx.keys.aOperator, { wait: true });
    expect(r1.json().run.status).toBe("success");
    const left = await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM workflow_locks");
    expect(left[0]!.n).toBe(0);
  });
});

describe("Tool db_* của agent", () => {
  it("viewer chỉ đọc; operator ghi được; kết quả gọn", async () => {
    const svc = getWsdbService(rt);
    const viewer = makeDbToolApi(svc, { workspaceId: fx.wsA, userId: fx.userId, role: "viewer" }, { role: "viewer" });
    await expect(viewer.query({ sql: "INSERT INTO khach_hang (sdt) VALUES ('x')", confirm: false, dryRun: false })).rejects.toThrow(/quyền/);
    const op = makeDbToolApi(svc, { workspaceId: fx.wsA, userId: fx.userId, role: "operator" }, { role: "operator" });
    expect(await op.query({ sql: "SELECT sdt FROM khach_hang", confirm: false, dryRun: false })).toMatch(/1 dòng/);
    expect(await op.schema()).toMatch(/TABLE khach_hang/);
  });
});
