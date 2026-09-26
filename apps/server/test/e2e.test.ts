import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema } from "@penai/shared";
import { createChannel, createDb, createPairing, type DbHandle } from "@penai/db";
import {
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

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  const dataDir = await mkdtemp(join(tmpdir(), "penai-e2e-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: {
      default: { kind: "openai-compat", baseURL: mock.url },
    },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("E2E server (spec-workspace-rbac + spec-agent-loop)", () => {
  it("healthz không cần auth", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("không có API key → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("key rác → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: auth("psk_khong_ton_tai"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("AC-4: viewer bị chặn tạo agent (403), ws_admin tạo được (201)", async () => {
    const body = {
      key: "agent-moi",
      name: "Agent mới",
      provider: "default",
      model: "mock-model",
    };
    const asViewer = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: auth(fx.keys.aViewer),
      payload: body,
    });
    expect(asViewer.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: auth(fx.keys.aAdmin),
      payload: body,
    });
    expect(asAdmin.statusCode).toBe(201);
  });

  it("GET /v1/agents chỉ thấy agent workspace mình", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: auth(fx.keys.bOperator),
    });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json() as { agents: Array<{ workspaceId: string }> };
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) expect(a.workspaceId).toBe(fx.wsB);
  });

  it("chat end-to-end qua mock LLM: tool call + persist + trả lời", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth(fx.keys.aOperator),
      payload: { agentKey: "tro-ly" },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth(fx.keys.aOperator),
      payload: { sessionId, message: "bây giờ là mấy giờ?" },
    });
    expect(chat.statusCode).toBe(200);
    const result = chat.json() as {
      finalText: string;
      iterations: number;
      toolCalls: Array<{ name: string }>;
    };
    expect(result.toolCalls.map((t) => t.name)).toContain("current_time");
    expect(result.finalText).toMatch(/^Kết quả tool:/);
    expect(result.iterations).toBe(1);

    const msgs = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: auth(fx.keys.aViewer),
    });
    const { messages } = msgs.json() as { messages: Array<{ role: string }> };
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    // Cách ly: operator workspace B không thấy session của A
    const crossWs = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: auth(fx.keys.bOperator),
    });
    expect(crossWs.statusCode).toBe(404);
  });

  it("chat stream=true trả SSE events + [DONE]", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth(fx.keys.aOperator),
      payload: { agentKey: "tro-ly" },
    });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat`, {
      method: "POST",
      headers: {
        ...auth(fx.keys.aOperator),
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, message: "xin chào", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"type":"done"');
    expect(body).toContain("data: [DONE]");
  });

  it("viewer không được chat (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth(fx.keys.aViewer),
      payload: {
        sessionId: "00000000-0000-0000-0000-000000000000",
        message: "hi",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("pairing chờ duyệt chỉ hiện trong workspace và chỉ ws_admin được xem", async () => {
    const ctxA = { workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" as const };
    const channel = await createChannel(dbh.db, ctxA, {
      kind: "telegram",
      name: "Bot pairing test",
      agentId: fx.agentA,
      tokenEncrypted: "v1.fake",
    });
    await createPairing(dbh.db, ctxA, channel.id, "PAIR2345", "telegram-user-1");

    const asViewer = await app.inject({
      method: "GET",
      url: "/v1/channel-pairings/pending",
      headers: auth(fx.keys.aViewer),
    });
    expect(asViewer.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: "GET",
      url: "/v1/channel-pairings/pending",
      headers: auth(fx.keys.aAdmin),
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json()).toMatchObject({
      pending: [{
        channelId: channel.id,
        channelName: "Bot pairing test",
        channelKind: "telegram",
        code: "PAIR2345",
        externalUserId: "telegram-user-1",
      }],
    });

    const otherWorkspace = await app.inject({
      method: "GET",
      url: "/v1/channel-pairings/pending",
      headers: auth(fx.keys.bOperator),
    });
    expect(otherWorkspace.statusCode).toBe(403);
  });
});
