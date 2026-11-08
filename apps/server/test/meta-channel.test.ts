import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PenaiConfigSchema } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry, type ChatResponse } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import type { ChannelManager } from "@penai/channels";
import { buildApp } from "../src/app.js";
import { startChannels } from "../src/channels-runtime.js";
import type { RuntimeDeps } from "../src/agent-runtime.js";

const SECRET = "psec_server_test";
const HUB = "https://chat.hoiai.vn";
const code = (over: Record<string, unknown> = {}, prefix = "hfb_") =>
  prefix +
  Buffer.from(
    JSON.stringify({
      v: 1,
      platform: prefix === "hig_" ? "instagram" : "facebook",
      page_id: "555000",
      page_name: "Shop Thử",
      page_access_token: "EAA-page",
      penai_secret: SECRET,
      register_webhook_endpoint: `${HUB}/api/facebook/penai/register-webhook`,
      refresh_token_endpoint: `${HUB}/api/facebook/penai/token`,
      ...over,
    }),
  ).toString("base64url");
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

let fx: TestFixtures, dbh: DbHandle, rt: RuntimeDeps, dir: string, manager: ChannelManager;
let app: ReturnType<typeof buildApp>;
const hubCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const graphSends: Array<Record<string, unknown>> = [];
let aiCalls = 0;
const realFetch = globalThis.fetch;
const auth = () => ({ authorization: `Bearer ${fx.keys.aAdmin}` });

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  dir = await mkdtemp(join(tmpdir(), "penai-meta-server-"));
  vi.stubEnv("PENAI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("PENAI_PUBLIC_URL", "https://penai.test");
  delete process.env.PENAI_META_HUB_URL;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.startsWith(HUB)) {
      hubCalls.push({ url, body });
      if (body["penai_secret"] !== SECRET) return new Response(JSON.stringify({ success: false, message: "Xác thực penai_secret không hợp lệ" }), { status: 401 });
      return new Response(JSON.stringify({ success: true, data: { page_id: body["page_id"], webhook_subscribed: true } }), { status: 200 });
    }
    if (url.startsWith("https://graph.facebook.com/")) {
      if (url.includes("/messages")) {
        if (body["sender_action"]) return new Response(JSON.stringify({ recipient_id: "7001" }), { status: 200 });
        graphSends.push(body);
        return new Response(JSON.stringify({ recipient_id: "7001", message_id: `mid.ai${graphSends.length}` }), { status: 200 });
      }
      if (url.includes("/7001?")) return new Response(JSON.stringify({ name: "Khách Một" }), { status: 200 });
      return new Response(JSON.stringify({ id: "555000", name: "Shop Thử" }), { status: 200 });
    }
    return realFetch(input, init);
  });
  const config = PenaiConfigSchema.parse({ dataDir: dir, providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:1" } } });
  const providers = createProviderRegistry({});
  const response: ChatResponse = { content: "Dạ **còn** size M ạ", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  providers.registerRuntime(fx.wsA, "default", {
    name: "default",
    async chat() { aiCalls++; return response; },
    async *chatStream() { aiCalls++; yield { type: "done", response }; },
  });
  rt = { db: dbh, config, providers, tools: createDefaultToolRegistry() };
  app = buildApp(rt);
  manager = await startChannels(rt);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await manager.stopAll();
  await app.close();
  await dbh.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Kênh Facebook qua hub", () => {
  let channelId = "";
  const post = (payload: unknown, signature?: string) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: `/webhooks/meta/${channelId}`,
      headers: { "content-type": "application/json", "x-penai-signature": signature ?? sign(raw) },
      payload: raw,
    });
  };
  const messages = async () => {
    const res = await app.inject({ method: "GET", url: `/v1/inbox/${channelId}/threads/7001/messages?limit=50`, headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json() as { thread: { pausedUntil: string | null; name: string } | null; messages: Array<{ direction: string; source: string; text: string; meta: Record<string, unknown> | null }> };
  };

  it("từ chối mã của hub khác và mã thiếu agent", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/channels/meta/connect", headers: auth(), payload: { code: code({ register_webhook_endpoint: "https://evil.example/r", refresh_token_endpoint: "https://evil.example/t" }), agentKey: "tro-ly" } });
    expect(other.statusCode).toBe(400);
    const noAgent = await app.inject({ method: "POST", url: "/v1/channels/meta/connect", headers: auth(), payload: { code: code() } });
    expect(noAgent.statusCode).toBe(400);
  });

  it("hub từ chối secret → không để lại kênh", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/channels/meta/connect", headers: auth(), payload: { code: code({ penai_secret: "sai" }), agentKey: "tro-ly" } });
    expect(res.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/v1/channels", headers: auth() });
    expect(list.json().channels.some((c: { kind: string }) => c.kind === "facebook")).toBe(false);
  });

  it("kết nối bằng mã → tạo kênh, đăng ký địa chỉ nhận tin với hub, có trong Inbox", async () => {
    hubCalls.length = 0;
    const res = await app.inject({ method: "POST", url: "/v1/channels/meta/connect", headers: auth(), payload: { code: code(), agentKey: "tro-ly" } });
    expect(res.statusCode).toBe(201);
    const j = res.json();
    expect(j).toMatchObject({ created: true, registered: true, channel: { kind: "facebook", name: "Shop Thử" } });
    channelId = j.channel.id;
    expect(hubCalls[0]!.body).toMatchObject({ page_id: "555000", platform: "facebook", webhook_url: `https://penai.test/webhooks/meta/${channelId}` });
    const list = await app.inject({ method: "GET", url: "/v1/channels", headers: auth() });
    const row = list.json().channels.find((c: { id: string }) => c.id === channelId);
    expect(row.requirePairing).toBe(false);
    expect(JSON.stringify(row.config)).not.toContain(SECRET);
    expect(JSON.stringify(row.config)).not.toContain("EAA-page");
    const ibx = await app.inject({ method: "GET", url: "/v1/inbox/channels", headers: auth() });
    const ch = ibx.json().channels.find((c: { id: string }) => c.id === channelId);
    expect(ch).toMatchObject({ platform: "Facebook", capabilities: { newConversation: false, groups: false } });
  });

  it("webhook sai chữ ký → 401; đúng → lưu Inbox, AI trả lời, ghi tin AI", async () => {
    const payload = { object: "page", entry: [{ id: "555000", messaging: [{ sender: { id: "7001" }, recipient: { id: "555000" }, timestamp: Date.now(), message: { mid: "m.in1", text: "Áo còn size M không?" } }] }] };
    expect((await post(payload, "sha256=00")).statusCode).toBe(401);
    expect((await post(payload)).statusCode).toBe(200);
    const got = await until(async () => {
      const m = await messages();
      return m.messages.some((x) => x.source === "agent") ? m : null;
    });
    expect(got.messages.map((x) => [x.direction, x.source])).toEqual([["in", "peer"], ["out", "agent"]]);
    expect(got.thread?.name).toBe("Khách Một");
    expect(graphSends.at(-1)).toMatchObject({ recipient: { id: "7001" }, message: { text: "Dạ còn size M ạ" } });
  });

  it("nhân viên trả lời trên Meta Business Suite → hiện trong Inbox, AI tạm im", async () => {
    const echo = { object: "page", entry: [{ id: "555000", messaging: [{ sender: { id: "555000" }, recipient: { id: "7001" }, timestamp: Date.now(), message: { mid: "m.human1", text: "Chị chờ em kiểm kho nhé", is_echo: true, app_id: 263902037430900 } }] }] };
    // tin dội lại của chính AI → bỏ qua (đã ghi lúc gửi)
    const own = { object: "page", entry: [{ id: "555000", messaging: [{ sender: { id: "555000" }, recipient: { id: "7001" }, timestamp: Date.now(), message: { mid: "mid.ai1", text: "Dạ còn size M ạ", is_echo: true, app_id: 1 } }] }] };
    expect((await post(own)).statusCode).toBe(200);
    expect((await post(echo)).statusCode).toBe(200);
    const got = await until(async () => {
      const m = await messages();
      return m.messages.some((x) => x.source === "app") ? m : null;
    });
    const human = got.messages.filter((x) => x.source === "app");
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ direction: "out", text: "Chị chờ em kiểm kho nhé", meta: { via: "Meta Business Suite / hộp thư Trang" } });
    expect(got.messages.filter((x) => x.source === "agent")).toHaveLength(1);
    expect(got.thread?.pausedUntil && new Date(got.thread.pausedUntil).getTime()).toBeGreaterThan(Date.now());

    const before = aiCalls;
    const sendsBefore = graphSends.length;
    const next = { object: "page", entry: [{ id: "555000", messaging: [{ sender: { id: "7001" }, recipient: { id: "555000" }, timestamp: Date.now(), message: { mid: "m.in2", text: "Ok em" } }] }] };
    expect((await post(next)).statusCode).toBe(200);
    await until(async () => (await messages()).messages.some((x) => x.text === "Ok em"));
    await new Promise((r) => setTimeout(r, 500));
    expect(aiCalls).toBe(before);
    expect(graphSends.length).toBe(sendsBefore);
  });

  it("nhân viên trả lời từ Inbox PenAI → gửi qua Graph, ghi nguồn web", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/inbox/${channelId}/threads/7001/send`, headers: auth(), payload: { text: "Em gửi chị mẫu nhé" } });
    expect(res.statusCode).toBe(200);
    expect(graphSends.at(-1)).toMatchObject({ message: { text: "Em gửi chị mẫu nhé" } });
    const m = await until(async () => (await messages()).messages.find((x) => x.text === "Em gửi chị mẫu nhé"));
    expect(m.source).toBe("web");
    const nw = await app.inject({ method: "POST", url: `/v1/inbox/${channelId}/new`, headers: auth(), payload: { to: "123", text: "x" } });
    expect(nw.statusCode).toBe(400);
  });

  it("dán lại mã của cùng Trang → cập nhật đúng kênh cũ, không tạo kênh mới", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/channels/meta/connect", headers: auth(), payload: { code: code({ page_access_token: "EAA-page-2" }) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false, channel: { id: channelId } });
    const status = await app.inject({ method: "GET", url: `/v1/channels/${channelId}/meta`, headers: auth() });
    expect(status.json()).toMatchObject({ kind: "facebook", page: { id: "555000" }, webhookUrl: `https://penai.test/webhooks/meta/${channelId}` });
  });

  it("đổi token qua PATCH bị chặn; xóa kênh không gỡ hub khi hub chưa hỗ trợ gỡ có điều kiện", async () => {
    const patch = await app.inject({ method: "PATCH", url: `/v1/channels/${channelId}`, headers: auth(), payload: { token: "abc" } });
    expect(patch.statusCode).toBe(400);
    hubCalls.length = 0;
    const del = await app.inject({ method: "DELETE", url: `/v1/channels/${channelId}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    expect(hubCalls).toHaveLength(0);
    expect((await post({ object: "page", entry: [] })).statusCode).toBe(404);
  });
});
