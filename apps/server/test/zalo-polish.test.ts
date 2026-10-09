import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PenaiConfigSchema, type WorkspaceContext } from "@penai/shared";
import { createChannel, createDb, upsertInboxContacts, upsertInboxObservedPeer, inboxPeerNames, type DbHandle, type EnabledChannel } from "@penai/db";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry, type ChatRequest, type ChatResponse } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import { Scheduler } from "@penai/core";
import { ZaloPersonalChannel, type InboundMessage } from "@penai/channels";
import { buildApp } from "../src/app.js";
import { channelHandlers, makeInboundHandler } from "../src/channels-runtime.js";
import type { RuntimeDeps } from "../src/agent-runtime.js";

let fx: TestFixtures, dbh: DbHandle, rt: RuntimeDeps, channel: EnabledChannel;
let app: ReturnType<typeof buildApp>, dir: string;
const requests: ChatRequest[] = [];
const ctx = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const auth = () => ({ authorization: `Bearer ${fx.keys.aAdmin}` });
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=";
beforeAll(async () => {
  await setupTestDatabase(); fx = await createTestFixtures(); dbh = createDb(TEST_APP_URL);
  dir = await mkdtemp(join(tmpdir(), "penai-zalo-polish-"));
  const config = PenaiConfigSchema.parse({ dataDir: dir, providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:1" } } });
  const providers = createProviderRegistry({});
  const response: ChatResponse = { content: "Đã xem ảnh", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  providers.registerRuntime(fx.wsA, "default", { name: "default", async chat(req) { requests.push(req); return response; },
    async *chatStream(req) { requests.push(req); yield { type: "done", response }; } });
  rt = { db: dbh, config, providers, tools: createDefaultToolRegistry() };
  app = buildApp(rt);
  const row = await createChannel(dbh.db, ctx(), { kind: "zalo_personal", name: "Zalo", agentId: fx.agentA, requirePairing: false });
  channel = { ...row, config: {}, kind: "zalo_personal" };
  const runtime = new ZaloPersonalChannel({ id: row.id, name: row.name, token: "{}", config: {}, requirePairing: false, onInbound: async () => ({ kind: "ignore" }) });
  runtime.listObserved = () => [{ chatKey: "direct:100", threadId: "100", type: "direct", name: "Linh RAM", lastSenderId: "100", lastSenderName: "Linh RAM",
    messageCount: 2, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date(Date.now() + 10000).toISOString(), allowed: true }];
  channelHandlers.set(row.id, { channel: runtime, workspaceId: fx.wsA, handler: makeInboundHandler(rt, new Scheduler(), channel) });
});
afterAll(async () => { channelHandlers.delete(channel.id); await app.close(); await dbh.close(); await rm(dir, { recursive: true, force: true }); });

describe("Zalo pending peers", () => {
  it("applies synced names after RAM merge, updates rename/removal and isolates same UID in other channels/workspaces", async () => {
    await upsertInboxObservedPeer(dbh.db, ctx(), channel.id, { chatKey: "direct:100", threadId: "100", kind: "direct", name: "Linh", lastSenderId: "100", lastSenderName: "Linh", countMessage: true });
    await upsertInboxContacts(dbh.db, ctx(), channel.id, [{ threadId: "100", kind: "direct", name: "Linh", contactAlias: "Khách hàng Linh" }]);
    const other = await createChannel(dbh.db, ctx(), { kind: "zalo_personal", name: "Other", agentId: fx.agentA });
    await upsertInboxContacts(dbh.db, ctx(), other.id, [{ threadId: "100", kind: "direct", name: "Other", contactAlias: "Wrong account" }]);
    const url = `/v1/channels/${channel.id}/personal/observed`;
    const peers = async () => { const res = await app.inject({ method: "GET", url, headers: auth() }); expect(res.statusCode).toBe(200); return res.json().peers; };
    expect((await peers())[0].name).toBe("Khách hàng Linh");
    await upsertInboxContacts(dbh.db, ctx(), channel.id, [{ threadId: "100", kind: "direct", name: "Linh", contactAlias: "Chị Linh" }]);
    expect((await peers())[0].name).toBe("Chị Linh");
    await upsertInboxContacts(dbh.db, ctx(), channel.id, [{ threadId: "100", kind: "direct", name: "Linh", contactAlias: "" }]);
    expect((await peers())[0].name).toBe("Linh");
    expect((await inboxPeerNames(dbh.db, { workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" }, channel.id, ["100"])).size).toBe(0);
  });
});

describe("Zalo photo-only runtime", () => {
  const inbound = (sender = "photos", text = "", photo = true): InboundMessage => ({ channelId: channel.id, channelKind: "zalo_personal", chatKey: `direct:${sender}`, senderId: sender, senderName: "Khách", peerKind: "direct", text,
    ...(photo ? { media: [{ kind: "photo", dataUrl: png }] } : {}) });
  it("saves consecutive images, acknowledges once without running AI, and passes saved images to the later request", async () => {
    const handler = makeInboundHandler(rt, new Scheduler(), channel);
    requests.length = 0;
    expect(await handler(inbound())).toEqual({ kind: "reply", text: "Đã nhận hình ạ." });
    expect(await handler(inbound())).toEqual({ kind: "ignore" });
    expect(requests).toHaveLength(0);
    const result = await handler(inbound("photos", "Xem giúp tôi những ảnh vừa gửi", false));
    expect(result.kind).toBe("reply");
    expect(requests.some((r) => r.messages.some((m) => m.role === "user" && (m.images?.length ?? 0) > 0))).toBe(true);
    expect(await readdir(join(dir, fx.wsA, "users", "zalo_personal-photos"))).not.toHaveLength(0);
    expect(await handler(inbound())).toEqual({ kind: "reply", text: "Đã nhận hình ạ." });
  });
  it("processes a photo with a caption and supports changing acknowledgement to silence without reconnecting", async () => {
    const handler = makeInboundHandler(rt, new Scheduler(), channel);
    requests.length = 0;
    expect((await handler(inbound("caption", "Đọc nội dung ảnh"))).kind).toBe("reply");
    expect(requests.length).toBeGreaterThan(0);
    const settings = await app.inject({ method: "PUT", url: `/v1/inbox/${channel.id}/settings`, headers: auth(), payload: { photoAck: "off" } });
    expect(settings.statusCode).toBe(200); expect(settings.json().photoAck).toBe("off");
    expect(await handler(inbound("silent"))).toEqual({ kind: "ignore" });
  });
});
