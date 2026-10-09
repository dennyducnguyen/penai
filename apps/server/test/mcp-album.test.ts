import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenaiConfigSchema } from "@penai/shared";
import type { Db } from "@penai/db";

const state = vi.hoisted(() => ({ channel: "", scopes: ["zalo:send"], sends: new Map<string, Record<string, unknown>>(), send: vi.fn(), find: vi.fn() }));
vi.mock("@penai/db", async (original) => ({
  ...await original<typeof import("@penai/db")>(),
  getMcpOauthToken: async () => ({ kind: "access", grantId: "grant", expiresAt: new Date(Date.now() + 60000), scopes: state.scopes }),
  getMcpOauthGrant: async () => ({ id: "grant", clientId: "client", userId: "user", workspaceId: "workspace", passwordVersion: "1" }),
  lookupMcpGrantPrincipal: async () => ({ isActive: true, passwordVersion: "1", role: "ws_admin" }),
  touchMcpOauthGrant: async () => {},
  listChannels: async () => [{ id: state.channel, kind: "zalo_personal", name: "Test", config: {} }],
  getInboxThread: async () => null,
  getMcpServerSend: async (_db: unknown, _ctx: unknown, _principal: unknown, id: string) => state.sends.get(id),
  insertMcpServerSend: async (_db: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    state.sends.set(String(input.requestId), { ...input, status: "pending", updatedAt: new Date() }); return true;
  },
  finishMcpServerSend: async (_db: unknown, _ctx: unknown, _principal: unknown, id: string, status: string, result: unknown) => {
    Object.assign(state.sends.get(id)!, { status, result });
  },
}));
vi.mock("../src/inbox.js", async (original) => ({
  ...await original<typeof import("../src/inbox.js")>(),
  allowedInboxChannelIds: async () => [state.channel],
  inboxRuntimeFor: () => ({ isConnected: () => true, findUserByPhone: state.find }),
  sendInbox: state.send,
}));
import { registerMcpServerRoutes } from "../src/mcp-server.js";
let app: ReturnType<typeof Fastify>, dir: string;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
beforeEach(async () => {
  vi.stubEnv("PENAI_PUBLIC_URL", "https://test.example");
  state.channel = randomUUID(); state.scopes = ["zalo:send"]; state.sends.clear(); state.send.mockReset(); state.find.mockReset();
  state.send.mockResolvedValue({ msgIds: ["1", "2"] }); state.find.mockResolvedValue({ uid: "123", name: "Test user" });
  dir = await mkdtemp(join(tmpdir(), "penai-mcp-album-")); app = Fastify();
  registerMcpServerRoutes(app, { db: {} as Db, dataDir: dir, config: PenaiConfigSchema.parse({}) });
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function rpc(method: string, params: unknown = {}) {
  const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer pmcp_test", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    payload: { jsonrpc: "2.0", id: 1, method, params } });
  expect(res.statusCode).toBe(200); return res.json();
}
const call = async (args: Record<string, unknown>, name = "zalo_send_message") => (await rpc("tools/call", { name, arguments: args })).result;
describe("MCP Zalo albums through HTTP", () => {
  it("advertises image_urls and sends 20 images once in source order; replay does not send again", async () => {
    const tools = (await rpc("tools/list")).result.tools;
    expect(tools.find((t: { name: string }) => t.name === "zalo_send_message").inputSchema.properties.image_urls.maxItems).toBe(20);
    const images = Array.from({ length: 20 }, (_, i) => "data:image/png;base64," + Buffer.concat([Buffer.from(png.split(",")[1]!, "base64"), Buffer.from([i])]).toString("base64"));
    const args = { to: "123", image_urls: images, request_id: "album-test-123" };
    const result = await call(args); expect(result.isError).not.toBe(true); expect(state.send).toHaveBeenCalledTimes(1);
    const sent = state.send.mock.calls[0]![1]; expect(sent.filePaths).toHaveLength(20); expect(sent.source).toBe("mcp");
    expect(new Set(sent.filePaths).size).toBe(20);
    for (let i = 0; i < sent.filePaths.length; i++) expect(await readFile(sent.filePaths[i])).toEqual(Buffer.from(images[i]!.split(",")[1]!, "base64"));
    expect(await call(args)).toEqual(result); expect(state.send).toHaveBeenCalledTimes(1);
    const conflict = await call({ ...args, image_urls: images.slice().reverse(), message: "different" });
    expect(conflict.structuredContent.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("supports phone lookup and legacy single image", async () => {
    expect((await call({ phone: "0937620222", image_urls: [png, png] }, "zalo_send_message_by_phone")).isError).not.toBe(true);
    expect(state.find).toHaveBeenCalledWith("0937620222"); expect(state.send.mock.calls[0]![1]).toMatchObject({ threadId: "123", filePaths: expect.any(Array) });
    state.channel = randomUUID();
    expect((await call({ to: "123", image_url: png })).isError).not.toBe(true);
    expect(state.send.mock.calls[1]![1].filePaths).toHaveLength(1);
  });
  it("rejects invalid album, oversized/empty array, conflicting inputs and missing scope before sending", async () => {
    expect((await call({ to: "123", image_urls: [png, "http://127.0.0.1/private"] })).structuredContent.error).toMatchObject({ code: "IMAGE_INVALID", message: expect.stringContaining("Ảnh 2/2") });
    expect((await readdir(dir, { recursive: true })).filter(p => p.endsWith(".png"))).toHaveLength(0);
    for (const image_urls of [[], Array(21).fill(png)]) expect((await call({ to: "123", image_urls })).isError).toBe(true);
    expect((await call({ to: "123", image_url: png, image_urls: [png] })).structuredContent.error.code).toBe("IMAGE_INPUT_CONFLICT");
    state.scopes = [];
    expect((await call({ to: "123", image_urls: [png] })).structuredContent.error.code).toBe("INSUFFICIENT_SCOPE");
    expect(state.send).not.toHaveBeenCalled();
  });
  it("retains confirmed IDs on partial failure and replays the unknown result without retrying", async () => {
    state.send.mockRejectedValueOnce(Object.assign(new Error("partial album"), { sentMsgIds: ["111"] }));
    const args = { to: "123", image_urls: [png, png], request_id: "partial-album-123" };
    const result = await call(args);
    expect(result.structuredContent.error).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN", sent_message_ids: ["111"] });
    expect(await call(args)).toEqual(result); expect(state.send).toHaveBeenCalledTimes(1);
  });
});
