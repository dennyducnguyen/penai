import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PenaiConfigSchema, encryptSecret } from "@penai/shared";
import { createChannel, createDb, type DbHandle } from "@penai/db";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry, type ChatResponse } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import { serializeMetaCredentials, type ChannelManager } from "@penai/channels";
import { buildApp } from "../src/app.js";
import { applyChannelChange, startChannels } from "../src/channels-runtime.js";
import { McpManager } from "../src/mcp-manager.js";
import { createInternalMcpServer } from "../src/mcp-server.js";
import type { RuntimeDeps } from "../src/agent-runtime.js";

const APP_SECRET = "0123456789abcdef0123456789abcdef";
const PAGE = "880001";
let fx: TestFixtures, dbh: DbHandle, rt: RuntimeDeps, dir: string, manager: ChannelManager;
let app: ReturnType<typeof buildApp>;
let appRowId = "", verifyToken = "", channelId = "";
const graph: Array<{ method: string; path: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
const auth = () => ({ authorization: `Bearer ${fx.keys.aAdmin}` });
const sign = (raw: string) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");

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
  dir = await mkdtemp(join(tmpdir(), "penai-meta-app-"));
  vi.stubEnv("PENAI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("PENAI_PUBLIC_URL", "https://penai.test");
  let n = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://graph.facebook.com/")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace("/v22.0", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    graph.push({ method, path, body });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (path === `/${PAGE}/messages`) return json({ recipient_id: "psid-1", message_id: `mid.${++n}` });
    if (/\/comments$/.test(path) && method === "POST") return json({ id: `cmt.${++n}` });
    if (path === `/${PAGE}/feed` && method === "POST") return json({ id: `${PAGE}_777` });
    if (path === `/${PAGE}_55`) return json({ message: "Váy hoa mùa hè", permalink_url: "https://fb.test/55" });
    return json({ id: PAGE, name: "Shop App", permalink_url: "https://fb.test/x" });
  });
  const config = PenaiConfigSchema.parse({ dataDir: dir, providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:1" } } });
  const providers = createProviderRegistry({});
  const response: ChatResponse = { content: "Dạ còn ạ", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  providers.registerRuntime(fx.wsA, "default", { name: "default", async chat() { return response; }, async *chatStream() { yield { type: "done", response }; } });
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

describe("App Meta riêng", () => {
  it("thêm app: kiểm App ID/Secret, trả địa chỉ chuyển về + webhook + verify token; không lộ secret", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/meta-apps", headers: auth(), payload: { appId: "abc", appSecret: APP_SECRET } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: "/v1/meta-apps", headers: auth(), payload: { appId: "1234567890", appSecret: APP_SECRET, name: "App shop" } });
    expect(res.statusCode).toBe(201);
    const a = res.json().app;
    appRowId = a.id;
    verifyToken = a.verifyToken;
    expect(a).toMatchObject({ redirectUri: "https://penai.test/oauth/meta/callback", webhookUrl: `https://penai.test/webhooks/meta-app/${a.id}`, loggedIn: false });
    expect(JSON.stringify(res.json())).not.toContain(APP_SECRET);
    const login = await app.inject({ method: "POST", url: `/v1/meta-apps/${a.id}/login`, headers: auth(), payload: {} });
    const u = new URL(login.json().url);
    expect(u.searchParams.get("client_id")).toBe("1234567890");
    expect(u.searchParams.get("redirect_uri")).toBe("https://penai.test/oauth/meta/callback");
    expect(u.searchParams.get("scope")).toContain("pages_messaging");
    // state lạ → quay về Dashboard báo lỗi, không cần đăng nhập
    const cb = await app.inject({ method: "GET", url: "/oauth/meta/callback?code=x&state=khong-co" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("login=error");
  });

  it("Meta kiểm địa chỉ webhook: đúng verify token thì trả challenge", async () => {
    const ok = await app.inject({ method: "GET", url: `/webhooks/meta-app/${appRowId}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const no = await app.inject({ method: "GET", url: `/webhooks/meta-app/${appRowId}?hub.mode=subscribe&hub.verify_token=sai&hub.challenge=1` });
    expect(no.statusCode).toBe(403);
  });

  it("webhook thẳng từ Meta: kiểm chữ ký App Secret, chia đúng kênh, tin vào Inbox, AI trả lời", async () => {
    const ctx = { workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" as const };
    const row = await createChannel(dbh.db, ctx, {
      kind: "facebook",
      name: "Shop App",
      agentId: fx.agentA,
      requirePairing: false,
      tokenEncrypted: encryptSecret(serializeMetaCredentials({ pageAccessToken: "EAA-p", penaiSecret: "", appSecret: APP_SECRET })),
      config: { platform: "facebook", mode: "app", metaAppId: appRowId, pageId: PAGE, pageName: "Shop App", agent_reply: true },
    });
    channelId = row.id;
    await applyChannelChange(row.id, { ...row, config: row.config as Record<string, unknown> });
    const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, messaging: [{ sender: { id: "5001" }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: "m.app1", text: "Còn váy hoa không?" } }] }] });
    const bad = await app.inject({ method: "POST", url: `/webhooks/meta-app/${appRowId}`, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, payload: raw });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: `/webhooks/meta-app/${appRowId}`, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, payload: raw });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toBe(1);
    const msgs = await until(async () => {
      const r = await app.inject({ method: "GET", url: `/v1/inbox/${channelId}/threads/5001/messages`, headers: auth() });
      const list = (r.json().messages ?? []) as Array<{ source: string }>;
      return list.some((m) => m.source === "agent") ? list : null;
    });
    expect(msgs.map((m) => m.source)).toEqual(["peer", "agent"]);
    const send = graph.find((g) => g.path === `/${PAGE}/messages` && (g.body as { message?: { text?: string } })?.message?.text === "Dạ còn ạ");
    expect(send).toBeTruthy();
  });

  it("bình luận: vào Inbox hội thoại bài viết, AI trả lời công khai + nhắn riêng; nhân viên trả lời bình luận từ Inbox", async () => {
    const raw = JSON.stringify({
      object: "page",
      entry: [{ id: PAGE, time: Math.floor(Date.now() / 1000), changes: [{ field: "feed", value: { item: "comment", verb: "add", post_id: `${PAGE}_55`, comment_id: "55_1", message: "Giá bao nhiêu?", from: { id: "u77", name: "Hoa" }, created_time: Math.floor(Date.now() / 1000) } }] }],
    });
    expect((await app.inject({ method: "POST", url: `/webhooks/meta-app/${appRowId}`, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, payload: raw })).statusCode).toBe(200);
    const thread = `post:${PAGE}_55`;
    const msgs = await until<{ thread: { name: string }; messages: Array<{ id: string; source: string; direction: string }> }>(async () => {
      const r = await app.inject({ method: "GET", url: `/v1/inbox/${channelId}/threads/${encodeURIComponent(thread)}/messages`, headers: auth() });
      const j = r.json() as { thread: { name: string }; messages: Array<{ id: string; source: string; direction: string }> };
      return (j.messages ?? []).some((m) => m.source === "agent") ? j : null;
    });
    expect(msgs.thread.name).toBe("📝 Váy hoa mùa hè");
    expect(graph.some((g) => g.path === "/55_1/comments" && g.method === "POST")).toBe(true);
    expect(graph.some((g) => g.path === `/${PAGE}/messages` && (g.body as { recipient?: { comment_id?: string } })?.recipient?.comment_id === "55_1")).toBe(true);
    const commentMsg = msgs.messages.find((m) => m.direction === "in")!;
    const r = await app.inject({ method: "POST", url: `/v1/inbox/${channelId}/threads/${encodeURIComponent(thread)}/send`, headers: auth(), payload: { text: "Dạ 350k ạ", replyTo: commentMsg.id } });
    expect(r.statusCode).toBe(200);
    expect(graph.filter((g) => g.path === "/55_1/comments").at(-1)!.body).toEqual({ message: "Dạ 350k ạ" });
    const settings = await app.inject({ method: "PUT", url: `/v1/inbox/${channelId}/settings`, headers: auth(), payload: { commentAiPrivate: false } });
    expect(settings.json()).toMatchObject({ comments: true, commentAiPublic: true, commentAiPrivate: false });
  });

  it("xóa app đang có kênh bị chặn", async () => {
    const del = await app.inject({ method: "DELETE", url: `/v1/meta-apps/${appRowId}`, headers: auth() });
    expect(del.statusCode).toBe(409);
  });
});

describe("MCP PenAI Kênh (nội bộ)", () => {
  it("tạo MCP nội bộ: chặn quyền lạ", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/mcp", headers: auth(), payload: { name: "penai-kenh", transport: "internal", args: ["root:all"] } });
    expect(bad.statusCode).toBe(400);
  });

  it("agent gọi công cụ chung qua kết nối trong tiến trình: liệt kê kênh, gửi tin, đăng bài; quyền và giới hạn kênh được tôn trọng", async () => {
    const mgr = new McpManager({ internalServer: (srv) => createInternalMcpServer({ db: dbh.db, dataDir: dir, brandName: () => "PenAI" }, srv) });
    const st = await mgr.connectServer({ id: "11111111-1111-1111-1111-111111111111", workspaceId: fx.wsA, name: "penai-kenh", transport: "internal", command: null, args: [], url: null, envEncrypted: null, visibility: "workspace", oauthEncrypted: null });
    expect(st.connected).toBe(true);
    expect(st.tools).toEqual(expect.arrayContaining(["channels_list", "message_send", "page_post_create", "page_comment_reply", "page_insights"]));
    expect(st.tools.some((t) => t.startsWith("zalo_"))).toBe(false);
    const tool = (name: string) => mgr.toolsFor(fx.wsA).find((t) => t.name === `mcp__penai-kenh__${name}`)!;
    const ctx = { workspaceId: fx.wsA, workspaceDataDir: dir } as never;
    const list = JSON.parse(await tool("channels_list").execute({}, ctx));
    expect(list.channels.find((c: { channel_id: string }) => c.channel_id === channelId)).toMatchObject({ platform: "Facebook", connected: true, features: { comments: true, posts: true } });
    const sent = JSON.parse(await tool("message_send").execute({ channel_id: channelId, to: "5001", message: "Shop gửi bạn mã giảm giá" }, ctx));
    expect(sent.success).toBe(true);
    const post = JSON.parse(await tool("page_post_create").execute({ channel_id: channelId, message: "Khai trương!" }, ctx));
    expect(post).toMatchObject({ success: true, post_id: `${PAGE}_777` });
    expect(graph.find((g) => g.path === `/${PAGE}/feed`)!.body).toMatchObject({ message: "Khai trương!" });
    const r = await app.inject({ method: "GET", url: `/v1/inbox/${channelId}/threads/5001/messages`, headers: auth() });
    expect((r.json().messages as Array<{ text: string; source: string }>).find((m) => m.text === "Shop gửi bạn mã giảm giá")?.source).toBe("agent");

    // Chỉ quyền đọc + giới hạn sang kênh khác → không gửi được, không thấy kênh này
    const st2 = await mgr.connectServer({ id: "22222222-2222-2222-2222-222222222222", workspaceId: fx.wsA, name: "doc", transport: "internal", command: null, args: ["channels:read", "channel:33333333-3333-3333-3333-333333333333"], url: null, envEncrypted: null, visibility: "workspace", oauthEncrypted: null });
    expect(st2.connected).toBe(true);
    const t2 = (name: string) => mgr.toolsFor(fx.wsA).find((t) => t.name === `mcp__doc__${name}`)!;
    expect(JSON.parse(await t2("channels_list").execute({}, ctx)).channels).toEqual([]);
    expect(await t2("message_send").execute({ channel_id: channelId, to: "5001", message: "x" }, ctx)).toContain("INSUFFICIENT_SCOPE");
    await mgr.stopAll();
  });
});
