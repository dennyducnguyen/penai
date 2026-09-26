/**
 * API Thư viện file của agent (Dashboard → Thư viện file, 26/09/2026).
 * Quyền operator+, tên file không dấu, chống traversal, thùng rác, hạn mức,
 * scope workspace khác, bật quyền ghi (ws_admin) có audit.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;
let dataDir = "";

const H = (key: string) => ({ authorization: `Bearer ${key}` });
const put = (key: string, scope: string, path: string, body: string | Buffer, overwrite = false) =>
  app.inject({
    method: "PUT",
    url: `/v1/library/${scope}/file?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`,
    headers: { ...H(key), "content-type": "application/octet-stream" },
    payload: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  dataDir = await mkdtemp(join(tmpdir(), "penai-library-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Thư viện file: quyền + liệt kê", () => {
  it("viewer bị từ chối, operator thấy scope chung + agent của workspace mình", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aViewer) })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aOperator) });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { scopes: Array<{ id: string; kind: string }>; canToggleWrite: boolean };
    expect(j.scopes[0]!.id).toBe("shared");
    expect(j.scopes.some((s) => s.id === fx.agentA)).toBe(true);
    expect(j.scopes.some((s) => s.id === fx.agentB)).toBe(false);
    expect(j.canToggleWrite).toBe(false);
  });

  it("scope là agent của workspace khác → 404", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/library/${fx.agentB}/list`, headers: H(fx.keys.aOperator) });
    expect(res.statusCode).toBe(404);
  });
});

describe("Thư viện file: tải lên / thư mục / đổi tên / xóa", () => {
  it("tải lên → tên không dấu, nằm đúng thư mục thư viện của agent, tải về đúng nội dung", async () => {
    const res = await put(fx.keys.aOperator, fx.agentA, "Mẫu Báo Giá 2026.DOCX", "noi dung 1");
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("mau-bao-gia-2026.docx");
    const disk = join(dataDir, "thu-vien", fx.wsA, fx.agentA, "mau-bao-gia-2026.docx");
    expect(await readFile(disk, "utf8")).toBe("noi dung 1");
    const list = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/list`, headers: H(fx.keys.aOperator) });
    const lj = list.json() as { entries: Array<{ name: string }>; agentPath: string };
    expect(lj.entries.map((e) => e.name)).toContain("mau-bao-gia-2026.docx");
    expect(lj.agentPath).toBe("thu-vien");
    const dl = await app.inject({
      method: "GET",
      url: `/v1/library/${fx.agentA}/file?path=mau-bao-gia-2026.docx&dl=1`,
      headers: H(fx.keys.aOperator),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("noi dung 1");
  });

  it("thư mục mới trong đường dẫn tải lên cũng chuyển thành không dấu", async () => {
    const res = await put(fx.keys.aOperator, fx.agentA, "Thư Mục Mới/Tệp A.txt", "a");
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("thu-muc-moi/tep-a.txt");
    const again = await put(fx.keys.aOperator, fx.agentA, "thu-muc-moi/Tệp B.txt", "b");
    expect(again.json().path).toBe("thu-muc-moi/tep-b.txt");
  });

  it("trùng tên → 409; ghi đè → bản cũ vào thùng rác", async () => {
    const dup = await put(fx.keys.aOperator, fx.agentA, "mau-bao-gia-2026.docx", "noi dung 2");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().exists).toBe(true);
    const ow = await put(fx.keys.aOperator, fx.agentA, "mau-bao-gia-2026.docx", "noi dung 2", true);
    expect(ow.statusCode).toBe(200);
    expect(ow.json().overwritten).toBe(true);
    const trash = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/trash`, headers: H(fx.keys.aOperator) });
    const items = (trash.json() as { items: Array<{ path: string; reason: string }> }).items;
    expect(items.some((i) => i.path === "mau-bao-gia-2026.docx" && /ghi đè/.test(i.reason))).toBe(true);
  });

  it("chặn đường dẫn đi ngược ra ngoài", async () => {
    for (const url of [
      `/v1/library/${fx.agentA}/list?path=${encodeURIComponent("../..")}`,
      `/v1/library/${fx.agentA}/file?path=${encodeURIComponent("../../../etc/passwd")}`,
    ]) {
      expect((await app.inject({ method: "GET", url, headers: H(fx.keys.aOperator) })).statusCode).toBe(400);
    }
    expect((await put(fx.keys.aOperator, fx.agentA, "../ra-ngoai.txt", "x")).statusCode).toBe(400);
  });

  it("tạo thư mục con, tải vào, đổi tên, không chuyển thư mục vào chính nó", async () => {
    const mk = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/mkdir`,
      headers: H(fx.keys.aOperator),
      payload: { path: "", name: "Mẫu Hợp Đồng" },
    });
    expect(mk.statusCode).toBe(200);
    expect(mk.json().path).toBe("mau-hop-dong");
    expect((await put(fx.keys.aOperator, fx.agentA, "mau-hop-dong/a.txt", "A")).statusCode).toBe(200);
    const mv = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/move`,
      headers: H(fx.keys.aOperator),
      payload: { from: "mau-hop-dong/a.txt", to: "mau-hop-dong/Hợp đồng B.txt" },
    });
    expect(mv.statusCode).toBe(200);
    expect(mv.json().path).toBe("mau-hop-dong/hop-dong-b.txt");
    const bad = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/move`,
      headers: H(fx.keys.aOperator),
      payload: { from: "mau-hop-dong", to: "mau-hop-dong/con" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("xóa thư mục → thùng rác → khôi phục → xóa hẳn", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/library/${fx.agentA}/entry?path=mau-hop-dong`,
      headers: H(fx.keys.aOperator),
    });
    expect(del.statusCode).toBe(200);
    const id = del.json().trashId as string;
    const list = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/list`, headers: H(fx.keys.aOperator) });
    expect((list.json() as { entries: Array<{ name: string }> }).entries.some((e) => e.name === "mau-hop-dong")).toBe(false);
    const rs = await app.inject({ method: "POST", url: `/v1/library/${fx.agentA}/trash/${id}/restore`, headers: H(fx.keys.aOperator) });
    expect(rs.statusCode).toBe(200);
    expect(await readFile(join(dataDir, "thu-vien", fx.wsA, fx.agentA, "mau-hop-dong", "hop-dong-b.txt"), "utf8")).toBe("A");
    const del2 = await app.inject({ method: "DELETE", url: `/v1/library/${fx.agentA}/entry?path=mau-hop-dong`, headers: H(fx.keys.aOperator) });
    const purge = await app.inject({ method: "DELETE", url: `/v1/library/${fx.agentA}/trash/${del2.json().trashId}`, headers: H(fx.keys.aOperator) });
    expect(purge.statusCode).toBe(200);
  });
});

describe("Thư viện file: thư mục chung, sao chép, lưu từ chat, hạn mức", () => {
  it("shared/: tải lên được; skills/ chỉ xem", async () => {
    expect((await put(fx.keys.aOperator, "shared", "logo-cong-ty.png", "png")).statusCode).toBe(200);
    expect((await put(fx.keys.aOperator, "shared", "skills/hack.txt", "x")).statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: "/v1/library/shared/entry?path=skills", headers: H(fx.keys.aOperator) });
    expect(del.statusCode).toBe(403);
  });

  it("sao chép từ thư viện agent sang thư mục chung", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/library/copy",
      headers: H(fx.keys.aOperator),
      payload: { fromScope: fx.agentA, path: "mau-bao-gia-2026.docx", toScope: "shared", toDir: "mau" },
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(dataDir, fx.wsA, "shared", "mau", "mau-bao-gia-2026.docx"), "utf8")).toBe("noi dung 2");
  });

  it("lưu file trong khung chat vào thư viện agent", async () => {
    const userDir = join(dataDir, fx.wsA, "users", `web-${fx.userId}`);
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "bao-cao-dep.txt"), "ban dep", "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/v1/library/import-chat",
      headers: H(fx.keys.aOperator),
      payload: { p: "bao-cao-dep.txt", toScope: fx.agentA, toDir: "mau-dep" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("mau-dep/bao-cao-dep.txt");
  });

  it("vượt hạn mức → 413", async () => {
    const saved = process.env.PENAI_LIBRARY_QUOTA_MB;
    process.env.PENAI_LIBRARY_QUOTA_MB = "0.0001"; // ~100 byte
    try {
      const res = await put(fx.keys.aOperator, fx.agentA, "lon.bin", Buffer.alloc(4096, 1));
      expect(res.statusCode).toBe(413);
    } finally {
      if (saved === undefined) delete process.env.PENAI_LIBRARY_QUOTA_MB;
      else process.env.PENAI_LIBRARY_QUOTA_MB = saved;
    }
  });
});

describe("Quyền ghi của agent vào thư viện", () => {
  it("operator không bật được; ws_admin bật được và có audit", async () => {
    const op = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: H(fx.keys.aOperator),
      payload: { libraryWritable: true },
    });
    expect(op.statusCode).toBe(403);
    const ad = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: H(fx.keys.aAdmin),
      payload: { libraryWritable: true },
    });
    expect(ad.statusCode).toBe(200);
    expect(ad.json().agent.libraryWritable).toBe(true);
    const rows = await adminQuery<{ action: string }>(
      `SELECT action FROM audit_log WHERE workspace_id = $1 AND action = 'library.agent_write_toggle'`,
      [fx.wsA],
    );
    expect(rows.length).toBe(1);
    const lib = await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aAdmin) });
    const j = lib.json() as { scopes: Array<{ id: string; libraryWritable?: boolean }>; canToggleWrite: boolean };
    expect(j.canToggleWrite).toBe(true);
    expect(j.scopes.find((s) => s.id === fx.agentA)?.libraryWritable).toBe(true);
    const uploads = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = $1 AND action = 'library.upload'`,
      [fx.wsA],
    );
    expect(Number(uploads[0]!.n)).toBeGreaterThan(0);
  });
});
