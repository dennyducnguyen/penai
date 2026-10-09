import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import { ZaloPersonalChannel, isZaloCallSignal } from "../src/zalo-personal.js";
import { ZaloSendGate, isZaloSendRequest } from "../src/zalo-send-gate.js";
import type { ChannelMessageLog, InboundMessage } from "../src/types.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(max = 50) {
  const logs: ChannelMessageLog[] = [];
  const inbound = vi.fn(async (_msg: InboundMessage) => ({ kind: "reply" as const, text: "ok" }));
  const channel = new ZaloPersonalChannel({ id: "album", name: "Album", config: { auto_reaction: "heart" }, token: "{}", requirePairing: false,
    onInbound: inbound, onMessageLog: (e) => logs.push(e) });
  let id = 0;
  const send = vi.fn(async (input: { attachments?: string[] }) => ({ message: null,
    attachment: (input.attachments ?? []).map(() => ({ msgId: String(++id) })) }));
  const reaction = vi.fn();
  Object.assign(channel, { api: { sendMessage: send, addReaction: reaction,
    getContext: () => ({ settings: { features: { sharefile: { max_file: max } } } }) }, account: { id: "self", name: "Shop" } });
  const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
  return { channel, send, logs, inbound, reaction, handle };
}

describe("Zalo album delivery", () => {
  it.each([10, 20])("sends %i photos as one native album and logs each photo with its own ID", async (count) => {
    const { channel, send, logs } = setup();
    const paths = Array.from({ length: count }, (_, i) => `/image-${i}.jpg`);
    const ids = await channel.sendManual({ threadId: "1", peerKind: "direct", source: "web", filePaths: paths });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].attachments).toEqual(paths);
    expect(ids).toHaveLength(count);
    expect(logs).toHaveLength(count);
    expect(logs.map((l) => l.media?.localPath)).toEqual(paths);
    expect(logs[9]?.media).toMatchObject({ albumSize: count, albumIndex: 9 });
  });
  it("respects the account limit and keeps GIF/documents separate without reordering", async () => {
    const { channel, send } = setup(2);
    await channel.sendManual({ threadId: "1", peerKind: "group", source: "mcp", filePaths: ["1.jpg", "2.png", "3.webp", "x.pdf", "x.gif", "4.jpg"] });
    expect(send.mock.calls.map((c) => c[0].attachments)).toEqual([["1.jpg", "2.png"], ["3.webp"], ["x.pdf"], ["x.gif"], ["4.jpg"]]);
  });
  it("stops after an uncertain album failure and never claims the whole album was rejected", async () => {
    const { channel, send } = setup();
    send.mockRejectedValueOnce(Object.assign(new Error("network"), { name: "ZcaApiError" }));
    await expect(channel.sendManual({ threadId: "1", peerKind: "direct", source: "web", filePaths: ["1.jpg", "2.jpg", "later.pdf"] }))
      .rejects.toMatchObject({ sentMsgIds: [] });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records confirmed photos from a partial native album before returning an error, without retrying", async () => {
    const { channel, send, logs } = setup();
    const c = channel as unknown as { fetchZalo: typeof fetch; decodeSendResponse: (r: Response) => Promise<{ msgId: string }>; sendGate: ZaloSendGate };
    c.sendGate = new ZaloSendGate(0); c.decodeSendResponse = async (r) => { if (!r.ok) throw new Error("rejected"); return r.json() as Promise<{ msgId: string }>; };
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const id = ++calls; return new Response(JSON.stringify({ msgId: String(id) }), { status: id === 2 ? 400 : 200 });
    });
    send.mockImplementation(async (input) => {
      const attachment = await Promise.all(input.attachments!.map(async () => {
        const r = await c.fetchZalo("https://file.zalo.me/api/message/photo_original/send", { method: "POST" });
        if (!r.ok) throw Object.assign(new Error("rejected"), { name: "ZcaApiError" });
        return r.json() as Promise<{ msgId: string }>;
      }));
      return { message: null, attachment };
    });
    const err = await channel.sendManual({ threadId: "1", peerKind: "direct", source: "web", filePaths: ["1.jpg", "2.jpg", "3.jpg", "later.pdf"] }).catch((e) => e);
    expect(err.sentMsgIds).toEqual(["1", "3"]); expect(err.zaloRejected).toBeUndefined();
    expect(logs.map((l) => l.media?.localPath)).toEqual(["1.jpg", "3.jpg"]);
    expect(calls).toBe(3); expect(send).toHaveBeenCalledOnce();
  });
});

describe("Zalo system call bubble", () => {
  it("ignores the call before media parsing, reactions and AI; subsequent text still works", async () => {
    const { handle, inbound, reaction, logs } = setup();
    const base = { type: ThreadType.User, threadId: "1", isSelf: false };
    await handle({ ...base, data: { msgId: "call", content: { title: "sendBubbleMessage" }, msgType: "chat.recommended" } });
    expect(inbound).not.toHaveBeenCalled(); expect(reaction).not.toHaveBeenCalled(); expect(logs).toHaveLength(0);
    await handle({ ...base, data: { msgId: "text", content: "chào", msgType: "webchat", uidFrom: "1" } });
    expect(inbound).toHaveBeenCalledOnce();
    expect(isZaloCallSignal({ title: "sendBubbleMessage" }, "chat.photo")).toBe(false);
    expect(isZaloCallSignal({ title: "a link" }, "chat.recommended")).toBe(false);
  });
  it("accepts a real captioned photo after a call bubble", async () => {
    const { handle, inbound } = setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from("photo"), { headers: { "content-type": "image/png" } }));
    const base = { type: ThreadType.User, threadId: "1", isSelf: false };
    await handle({ ...base, data: { msgId: "call", content: { title: "sendBubbleMessage" }, msgType: "chat.recommended" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    await handle({ ...base, data: { msgId: "photo", uidFrom: "1", content: { href: "https://photo.zdn.vn/a.png", title: "Đọc chữ trên ảnh" }, msgType: "chat.photo" } });
    expect(inbound.mock.calls[0]?.[0]).toMatchObject({ text: "Đọc chữ trên ảnh", media: [{ kind: "photo" }] });
  });
});

describe("Native Zalo request pacing", () => {
  it("serializes concurrent native requests and waits between them even after a failure", async () => {
    vi.useFakeTimers();
    const gate = new ZaloSendGate(500), times: number[] = [];
    const first = gate.run(async () => { times.push(Date.now()); throw new Error("rejected"); }).catch(() => {});
    const second = gate.run(async () => { times.push(Date.now()); });
    const third = gate.run(async () => { times.push(Date.now()); });
    await vi.runAllTimersAsync(); await Promise.all([first, second, third]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(500);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(500);
    expect(isZaloSendRequest("https://chat.zalo.me/api/message/photo_original/send?x=1", { method: "POST" })).toBe(true);
    expect(isZaloSendRequest("https://chat.zalo.me/api/message/upfile", { method: "POST" })).toBe(false);
  });
});
