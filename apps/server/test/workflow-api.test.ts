import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PenaiConfigSchema, type PenaiConfig, type WorkspaceContext } from "@penai/shared";
import { createChannel, createDb, type DbHandle } from "@penai/db";
import { adminQuery, createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry, type ChatRequest, type ChatResponse, type Provider, type StreamEvent } from "@penai/providers";
import type { Channel, OutboundMessage } from "@penai/channels";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildLoopDeps, type RuntimeDeps } from "../src/agent-runtime.js";
import { buildApp } from "../src/app.js";
import { channelHandlers } from "../src/channels-runtime.js";
import { getWorkflowService } from "../src/workflow-service.js";

// Quy trình tự động (0036): API /v1/workflows, webhook, khóa bí mật, phiên bản, tool workflow_* của agent

class FakeProvider implements Provider {
  readonly name = "fake";
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return { content: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "done", response: await this.chat(req) };
  }
}

class FakeChannel implements Channel {
  readonly kind = "telegram";
  readonly name = "Bot";
  sent: OutboundMessage[] = [];
  constructor(readonly id: string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  isRunning(): boolean {
    return true;
  }
}

let fx: TestFixtures;
let dbh: DbHandle;
let config: PenaiConfig;
let rt: RuntimeDeps;
let app: FastifyInstance;
let channel: FakeChannel;
let channelId: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const sys = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "operator" });

beforeAll(async () => {
  vi.stubEnv("PENAI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("PENAI_PUBLIC_URL", "https://penai.test");
  await setupTestDatabase();
  fx = await createTestFixtures();
  // Người tạo khóa API phải là thành viên workspace (lần chạy mang quyền người sở hữu)
  await adminQuery("INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'ws_admin') ON CONFLICT DO NOTHING", [fx.userId, fx.wsA]);
  dbh = createDb(TEST_APP_URL);
  config = PenaiConfigSchema.parse({ dataDir: await mkdtemp(join(tmpdir(), "penai-wf-")), providers: {} });
  const providers = createProviderRegistry(config.providers);
  providers.registerRuntime(fx.wsA, "default", new FakeProvider());
  rt = { db: dbh, providers, tools: createDefaultToolRegistry(), config };
  app = buildApp(rt);
  const ch = await createChannel(dbh.db, sys(), { kind: "telegram", name: "Bot", agentId: fx.agentA, requirePairing: false });
  channelId = ch.id;
  channel = new FakeChannel(ch.id);
  channelHandlers.set(ch.id, { handler: async () => ({ kind: "ignore" }), channel, workspaceId: fx.wsA });
});

afterAll(async () => {
  channelHandlers.delete(channelId);
  await app.close();
  await dbh.close();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  // Webhook "wait" trả kết quả ngay ở bước respond trong khi lần chạy còn ghi nốt nhật ký —
  // chờ mọi lần chạy dở xong hẳn rồi mới dọn bảng (xóa song song với ghi gây deadlock).
  for (let i = 0; i < 100; i++) {
    const r = await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM workflow_runs WHERE status = 'running'");
    if (!r[0]?.n) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  await adminQuery("DELETE FROM workflows");
  await adminQuery("DELETE FROM workspace_secrets");
  channel.sent = [];
});

const baseDef = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ name: "Thử quy trình", triggers: [{ type: "manual" }], steps, ...extra });

async function create(def: unknown, key = fx.keys.aOperator) {
  const r = await app.inject({ method: "POST", url: "/v1/workflows", headers: auth(key), payload: { definition: def } });
  return { status: r.statusCode, body: r.json() as { workflow: { id: string; version: number; webhook?: { url: string; hmacSecret: string } }; warnings: unknown[]; error?: string; issues?: Array<{ path: string; message: string }> } };
}

describe("API /v1/workflows", () => {
  it("tạo → chạy (chờ kết quả) → nhật ký từng bước; gửi tin thật qua kênh", async () => {
    const { status, body } = await create(
      baseDef([
        { id: "tinh", type: "code", code: "return [{ kho: 'A', n: 2 }, { kho: 'B', n: 1 }];" },
        { id: "lap", type: "loop", over: "steps.tinh.output", as: "k", max: 10, body: [{ id: "bao", type: "send", channel: "telegram:Bot", to: "-100", text: "Kho {{ k.kho }}: {{ k.n }}" }] },
      ]),
    );
    expect(status).toBe(201);
    const id = body.workflow.id;
    const run = await app.inject({ method: "POST", url: `/v1/workflows/${id}/run`, headers: auth(fx.keys.aOperator), payload: { wait: true } });
    expect(run.statusCode).toBe(200);
    const r = run.json() as { finished: boolean; run: { status: string }; steps: Array<{ stepId: string; status: string }> };
    expect(r.finished).toBe(true);
    expect(r.run.status).toBe("success");
    expect(r.steps.filter((s) => s.stepId === "bao")).toHaveLength(2);
    expect(channel.sent.map((m) => m.text)).toEqual(["Kho A: 2", "Kho B: 1"]);
    const list = (await app.inject({ method: "GET", url: "/v1/workflows", headers: auth(fx.keys.aViewer) })).json() as { workflows: Array<{ id: string; lastRunStatus: string }> };
    expect(list.workflows.find((w) => w.id === id)?.lastRunStatus).toBe("success");
  });

  it("định nghĩa sai → 400 kèm danh sách lỗi có đường dẫn + gợi ý tên kênh", async () => {
    const { status, body } = await create(baseDef([{ id: "g", type: "send", channel: "zalo:khong-co", to: "1", text: "x" }]));
    expect(status).toBe(400);
    expect(body.issues?.[0]?.path).toContain("steps[0] (g).channel");
    expect(body.issues?.[0]?.message).toContain("telegram:Bot");
  });

  it("viewer chỉ xem; workspace khác không thấy", async () => {
    const { body } = await create(baseDef([]));
    expect((await app.inject({ method: "POST", url: "/v1/workflows", headers: auth(fx.keys.aViewer), payload: { definition: baseDef([]) } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/workflows/${body.workflow.id}`, headers: auth(fx.keys.bOperator) })).statusCode).toBe(404);
  });

  it("sửa = phiên bản mới; ops nhỏ; hoàn về bản cũ; chặn ghi đè khi bản đã đổi", async () => {
    const { body } = await create(baseDef([{ id: "a", type: "code", code: "return 1" }]));
    const id = body.workflow.id;
    const put = await app.inject({ method: "PUT", url: `/v1/workflows/${id}`, headers: auth(fx.keys.aOperator), payload: { definition: baseDef([{ id: "a", type: "code", code: "return 2" }]), expectVersion: 1 } });
    expect(put.json().workflow.version).toBe(2);
    const stale = await app.inject({ method: "PUT", url: `/v1/workflows/${id}`, headers: auth(fx.keys.aOperator), payload: { definition: baseDef([]), expectVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/workflows/${id}`,
      headers: auth(fx.keys.aOperator),
      payload: { ops: [{ op: "insert", step: { id: "b", type: "code", code: "return steps.a.output + 1" }, after: "a" }] },
    });
    expect(patch.json().workflow.version).toBe(3);
    expect(patch.json().diff).toEqual([{ kind: "added", id: "b", type: "code" }]);
    const restore = await app.inject({ method: "POST", url: `/v1/workflows/${id}/versions/1/restore`, headers: auth(fx.keys.aOperator) });
    expect(restore.json().workflow.version).toBe(4);
    expect(restore.json().workflow.definition.steps).toEqual([{ id: "a", type: "code", code: "return 1" }]);
    const versions = (await app.inject({ method: "GET", url: `/v1/workflows/${id}/versions`, headers: auth(fx.keys.aViewer) })).json().versions as Array<{ version: number; changeVia: string }>;
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions[0]!.changeVia).toBe("restore");
  });

  it("chạy thử bản nháp chưa lưu, dry run không gửi tin", async () => {
    const { body } = await create(baseDef([]));
    const test = await app.inject({
      method: "POST",
      url: `/v1/workflows/${body.workflow.id}/test`,
      headers: auth(fx.keys.aOperator),
      payload: { dryRun: true, definition: baseDef([{ id: "g", type: "send", channel: "telegram:Bot", to: "1", text: "xin chào" }]) },
    });
    const r = test.json() as { run: { status: string; isTest: boolean }; steps: Array<{ status: string }> };
    expect(r.run).toMatchObject({ status: "success", isTest: true });
    expect(r.steps[0]!.status).toBe("dry_run");
    expect(channel.sent).toHaveLength(0);
  });

  it("khóa bí mật: không trả giá trị, che *** trong nhật ký", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/secrets", headers: auth(fx.keys.aOperator), payload: { name: "KHOA_THU", value: "gia-tri-bi-mat-123" } });
    expect(s.statusCode).toBe(200);
    expect(JSON.stringify((await app.inject({ method: "GET", url: "/v1/secrets", headers: auth(fx.keys.aOperator) })).json())).not.toContain("gia-tri-bi-mat-123");
    // http tới địa chỉ nội bộ bị chặn — vẫn đủ để kiểm che khóa trong đầu vào của bước
    const { body } = await create(baseDef([{ id: "goi", type: "http", url: "http://127.0.0.1:9/?k={{ secrets.KHOA_THU }}", onError: "continue" }]));
    const run = (await app.inject({ method: "POST", url: `/v1/workflows/${body.workflow.id}/run`, headers: auth(fx.keys.aOperator), payload: { wait: true } })).json();
    const dump = JSON.stringify(run);
    expect(dump).not.toContain("gia-tri-bi-mat-123");
    expect(dump).toContain("***");
    expect(dump).toContain("địa chỉ nội bộ");
  });
});

describe("webhook công khai", () => {
  it("token sai → 404; async → 202 + tra kết quả; wait → bước respond", async () => {
    const { body } = await create(
      baseDef(
        [
          { id: "kt", type: "code", code: "return { tong: inputs.a + inputs.b };" },
          { id: "tra", type: "respond", status: 201, body: { ok: true, tong: "{{ steps.kt.output.tong }}" } },
        ],
        { triggers: [{ type: "webhook", respond: "wait" }], inputs: { a: { type: "number" }, b: { type: "number", default: 1 } } },
      ),
    );
    const url = body.workflow.webhook!.url.replace("https://penai.test", "");
    expect((await app.inject({ method: "POST", url: url.replace(/\/[^/]+$/, "/sai-token"), payload: {} })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url, payload: { a: 4 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, tong: 5 });
    const q = await app.inject({ method: "GET", url: `${url}?a=10&b=2` });
    expect(q.json()).toEqual({ ok: true, tong: 12 });
  });

  it("async trả runId, tra kết quả qua statusUrl; HMAC bắt buộc chữ ký đúng + chống gửi lại", async () => {
    const { body } = await create(baseDef([{ id: "x", type: "code", code: "return trigger.body" }], { triggers: [{ type: "webhook", auth: "hmac" }] }));
    const url = body.workflow.webhook!.url.replace("https://penai.test", "");
    const secret = body.workflow.webhook!.hmacSecret;
    expect((await app.inject({ method: "POST", url, payload: { a: 1 } })).statusCode).toBe(401);
    const raw = JSON.stringify({ a: 1 });
    const ts = String(Date.now());
    const nonce = randomUUID();
    const sig = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
    const headers = { "content-type": "application/json", "x-penai-signature": sig, "x-penai-timestamp": ts, "x-penai-nonce": nonce };
    const ok = await app.inject({ method: "POST", url, headers, payload: raw });
    expect(ok.statusCode).toBe(202);
    const runId = ok.json().runId as string;
    expect((await app.inject({ method: "POST", url, headers, payload: raw })).statusCode).toBe(409);
    for (let i = 0; i < 50; i++) {
      const st = (await app.inject({ method: "GET", url: `${url}/runs/${runId}` })).json();
      if (st.status !== "running") {
        expect(st).toMatchObject({ status: "success", output: { a: 1 } });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("lần chạy không xong");
  });
});

describe("lịch + tool workflow_* của agent", () => {
  it("quy trình có lịch tới hạn → bộ chạy lịch chạy và tính lần kế", async () => {
    const { body } = await create(baseDef([{ id: "a", type: "code", code: "return 'theo lịch'" }], { triggers: [{ type: "schedule", cron: "*/5 * * * *" }] }));
    await adminQuery("UPDATE workflows SET next_run_at = now() - interval '1 minute' WHERE id = $1", [body.workflow.id]);
    const svc = getWorkflowService(rt);
    const runs = await svc.tick();
    expect(runs).toHaveLength(1);
    await Promise.all(runs);
    const rows = await adminQuery<{ status: string; trigger_type: string }>("SELECT status, trigger_type FROM workflow_runs WHERE workflow_id = $1", [body.workflow.id]);
    expect(rows).toEqual([{ status: "success", trigger_type: "schedule" }]);
    const wf = await adminQuery<{ next_run_at: Date }>("SELECT next_run_at FROM workflows WHERE id = $1", [body.workflow.id]);
    expect(wf[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("operator chat web: tạo → chạy thử → sửa; người dùng kênh chỉ thấy quy trình cho phép từ chat", async () => {
    const web = await buildLoopDeps(rt, sys(), "default", {
      agentId: fx.agentA,
      userKey: `web-${fx.userId}`,
      sourceKind: "api",
      accessRole: "operator",
      cronOrigin: { kind: "web", deliver: true, userId: fx.userId, userName: "Test" },
    });
    expect(web.tools.has("workflow_create")).toBe(true);
    const created = await web.workflows!.create({ definition: baseDef([{ id: "a", type: "code", code: "return 7" }]), enabled: true });
    expect(created).toContain("Đã tạo quy trình");
    const id = /id ([0-9a-f-]{36})/.exec(created)![1]!;
    expect(await web.workflows!.test({ id, dryRun: true })).toContain("success");
    const upd = await web.workflows!.update({ id, ops: [{ op: "update_step", id: "a", fields: { code: "return 8" } }] });
    expect(upd).toContain("bản 2");
    const row = await adminQuery<{ last_change_via: string }>("SELECT last_change_via FROM workflows WHERE id = $1", [id]);
    expect(row[0]!.last_change_via).toBe("agent");
    // agent không tự duyệt bước shell
    await web.workflows!.update({ id, ops: [{ op: "insert", step: { id: "sh", type: "shell", command: "echo hi", approved: true } }] });
    const def = await adminQuery<{ definition: { steps: Array<{ id: string; approved?: boolean }> } }>("SELECT definition FROM workflows WHERE id = $1", [id]);
    expect(def[0]!.definition.steps.find((s) => s.id === "sh")!.approved).toBe(false);

    const chan = await buildLoopDeps(rt, sys(), "default", {
      agentId: fx.agentA,
      userKey: "telegram-1",
      sourceKind: "channel",
      accessRole: null,
      cronOrigin: { kind: "channel", deliver: true, channelId, channelKind: "telegram", channelName: "Bot", chatKey: "1", peerKind: "direct", senderId: "1", senderName: "An" },
    });
    expect(chan.tools.has("workflow_create")).toBe(false);
    expect(chan.tools.has("workflow_run")).toBe(true);
    expect(await chan.workflows!.list()).toContain("không có quy trình nào");
    await expect(chan.workflows!.create({ definition: baseDef([]), enabled: true })).rejects.toThrow(/Chỉ quản trị viên/);

    const inCron = await buildLoopDeps(rt, sys(), "default", { agentId: fx.agentA, userKey: "telegram-1", sourceKind: "cron", cronOrigin: { kind: "web", deliver: true, userId: fx.userId } });
    expect(inCron.workflows).toBeUndefined();
    expect(inCron.tools.has("workflow_list")).toBe(false);
  });
});
