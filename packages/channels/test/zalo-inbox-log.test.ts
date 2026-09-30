import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import type { ChannelContact, ChannelMessageLog, ChannelReaction } from "../src/types.js";
import { describeZaloContent, parseAutoReaction, ZALO_REACTIONS, ZaloPersonalChannel } from "../src/zalo-personal.js";

describe("describeZaloContent — nội dung tin cho Inbox", () => {
  it("text thường", () => {
    expect(describeZaloContent("xin chào", "webchat")).toEqual({ contentType: "text", text: "xin chào" });
  });

  it("ảnh từ CDN Zalo giữ link, link lạ bị bỏ", () => {
    const ok = describeZaloContent(
      { href: "https://f47-photo.talk.zdn.vn/a.jpg", thumb: "https://f47-photo.talk.zdn.vn/t.jpg", title: "chú thích" },
      "chat.photo",
    );
    expect(ok.contentType).toBe("photo");
    expect(ok.text).toBe("chú thích");
    expect(ok.media?.url).toBe("https://f47-photo.talk.zdn.vn/a.jpg");
    const bad = describeZaloContent({ href: "https://evil.example/a.jpg" }, "chat.photo");
    expect(bad.media?.url).toBeUndefined();
  });

  it("file giữ tên + đuôi + dung lượng", () => {
    const f = describeZaloContent(
      { href: "https://f18-zpg.zdn.vn/x", title: "bao-gia", params: JSON.stringify({ fileExt: "xlsx", fileSize: 1234 }) },
      "share.file",
    );
    expect(f).toMatchObject({ contentType: "file", media: { name: "bao-gia.xlsx", size: 1234 } });
  });

  it("sticker / voice / nội dung lạ", () => {
    expect(describeZaloContent({ id: 1 }, "chat.sticker").contentType).toBe("sticker");
    expect(describeZaloContent({ href: "https://a.zdn.vn/v.aac" }, "chat.voice").contentType).toBe("voice");
    expect(describeZaloContent({ foo: 1 }, "chat.xyz").contentType).toBe("other");
  });
});

describe("Inbox: ghi tin đi/đến + bỏ bản dội lại", () => {
  function setup() {
    const logs: ChannelMessageLog[] = [];
    const contacts: ChannelContact[][] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-inbox",
      name: "Zalo inbox",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (e) => logs.push(e),
      onContactsSynced: (items) => contacts.push(items),
    });
    let n = 100;
    const sent: Array<{ msg: unknown; threadId: string; type: unknown }> = [];
    const fakeApi = {
      sendMessage: async (msg: unknown, threadId: string, type: unknown) => {
        sent.push({ msg, threadId, type });
        n += 1;
        return { message: { msgId: String(n) }, attachment: [] };
      },
      findUser: async (phone: string) => (phone === "0900000001" ? { uid: "u-1", display_name: "Chị A", avatar: "" } : null),
    };
    const c = channel as unknown as Record<string, unknown>;
    c.api = fakeApi;
    c.account = { id: "me-1", name: "Shop" };
    return { channel, logs, sent, contacts };
  }

  it("sendManual gửi text không qua cổng demo, ghi 1 log nguồn web", async () => {
    const { channel, logs, sent } = setup();
    const ids = await channel.sendManual({ threadId: "u-9", peerKind: "direct", text: "chào anh", source: "web", webUserId: "user-1" });
    expect(ids).toEqual(["101"]);
    expect(sent[0]).toMatchObject({ threadId: "u-9", type: ThreadType.User });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ direction: "out", source: "web", webUserId: "user-1", msgId: "101", text: "chào anh" });
  });

  it("tin dội lại (isSelf) của tin PenAI vừa gửi không bị ghi lần 2; tin gửi từ điện thoại thì ghi nguồn app", async () => {
    const { channel, logs } = setup();
    await channel.sendManual({ threadId: "g-1", peerKind: "group", text: "thông báo", source: "mcp" });
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    const base = { type: ThreadType.Group, threadId: "g-1", isSelf: true };
    await handle({ ...base, data: { msgId: "101", uidFrom: "0", content: "thông báo", msgType: "webchat", ts: String(Date.now()) } });
    expect(logs).toHaveLength(1);
    await handle({ ...base, data: { msgId: "555", uidFrom: "0", content: "gõ từ điện thoại", msgType: "webchat", ts: String(Date.now()) } });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ direction: "out", source: "app", text: "gõ từ điện thoại", peerKind: "group" });
  }, 10_000);

  it("tin khách gửi tới ghi nguồn zalo kèm tên người gửi (kể cả khi agent không được trả lời)", async () => {
    const { channel, logs } = setup();
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({
      type: ThreadType.User,
      threadId: "u-5",
      isSelf: false,
      data: { msgId: "900", uidFrom: "u-5", dName: "Anh B", content: "còn hàng không?", msgType: "webchat", ts: String(Date.now()) },
    });
    expect(logs[0]).toMatchObject({ direction: "in", source: "zalo", senderName: "Anh B", threadName: "Anh B", threadId: "u-5" });
  });

  it("findUserByPhone trả null khi không có", async () => {
    const { channel } = setup();
    expect(await channel.findUserByPhone("0900000001")).toMatchObject({ uid: "u-1", name: "Chị A" });
    expect(await channel.findUserByPhone("0900000002")).toBeNull();
  });

  it("chưa đăng nhập → sendManual báo NOT_CONNECTED", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-x",
      name: "x",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    await expect(channel.sendManual({ threadId: "1", peerKind: "direct", text: "a", source: "web" })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("Reaction: tự thả cảm xúc + thả tay", () => {
  afterEach(() => vi.useRealTimers());

  function setup(config: Record<string, unknown>) {
    const logs: ChannelMessageLog[] = [];
    const reactions: ChannelReaction[] = [];
    const calls: Array<{ icon: unknown; dest: { data: { msgId: string; cliMsgId: string }; threadId: string; type: unknown } }> = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-rx",
      name: "Zalo rx",
      token: "{}",
      config,
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (e) => logs.push(e),
      onReaction: (r) => reactions.push(r),
    });
    const c = channel as unknown as Record<string, unknown>;
    c.api = { addReaction: async (icon: unknown, dest: never) => (calls.push({ icon, dest }), { msgIds: [1] }) };
    c.account = { id: "me-1", name: "Shop" };
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    const inbound = (threadId: string, msgId: string, group = false) =>
      handle({
        type: group ? 1 : 0,
        threadId,
        isSelf: false,
        data: { msgId, cliMsgId: "c" + msgId, uidFrom: "u-7", dName: "Khách", content: "alo", msgType: "webchat", ts: String(Date.now()) },
      });
    return { channel, logs, reactions, calls, inbound };
  }

  it("parseAutoReaction: chỉ heart/like, còn lại = tắt", () => {
    expect(parseAutoReaction({})).toBeNull();
    expect(parseAutoReaction({ auto_reaction: "heart" })).toBe("heart");
    expect(parseAutoReaction({ auto_reaction: "like" })).toBe("like");
    expect(parseAutoReaction({ auto_reaction: "off" })).toBeNull();
    expect(ZALO_REACTIONS.heart).toBe("/-heart");
    expect(ZALO_REACTIONS.none).toBe("");
  });

  it("bản dội lại của tin PenAI gửi → báo cliMsgId để bổ sung (thả cảm xúc được)", async () => {
    const ids: Array<[string, string]> = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-cli", name: "x", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: () => {},
      onMessageCliId: (m, c) => ids.push([m, c]),
    });
    const c = channel as unknown as Record<string, unknown>;
    c.api = { sendMessage: async () => ({ message: { msgId: 777 }, attachment: [] }) };
    c.account = { id: "me-1", name: "Shop" };
    await channel.sendManual({ threadId: "g-1", peerKind: "group", text: "hi", source: "mcp" });
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({ type: 1, threadId: "g-1", isSelf: true, data: { msgId: "777", cliMsgId: "c777", uidFrom: "0", content: "hi", msgType: "webchat", ts: "1" } });
    expect(ids).toEqual([["777", "c777"]]);
  });

  it("tin khách lưu kèm cliMsgId (để thả cảm xúc về sau)", async () => {
    const { logs, inbound } = setup({});
    await inbound("u-7", "m1");
    expect(logs[0]?.meta).toMatchObject({ cliMsgId: "cm1" });
  });

  it("mặc định TẮT: không tự thả", async () => {
    vi.useFakeTimers();
    const { calls, inbound } = setup({});
    await inbound("u-7", "m1");
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(0);
  });

  it("bật ❤️: khách nhắn dồn → chỉ thả tin cuối; nhóm cũng thả; báo onReaction nguồn auto", async () => {
    vi.useFakeTimers();
    const { calls, reactions, inbound } = setup({ auto_reaction: "heart" });
    await inbound("u-7", "m1");
    await vi.advanceTimersByTimeAsync(500);
    await inbound("u-7", "m2");
    await inbound("g-1", "m3", true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.map((c) => c.dest.data.msgId).sort()).toEqual(["m2", "m3"]);
    expect(calls.every((c) => c.icon === "/-heart")).toBe(true);
    expect(calls.find((c) => c.dest.data.msgId === "m3")?.dest.type).toBe(1);
    expect(reactions.map((r) => [r.targetMsgId, r.source, r.reactorId])).toContainEqual(["m2", "auto", "me-1"]);
  });

  it("tắt nóng: hẹn giờ đang chờ bị hủy", async () => {
    vi.useFakeTimers();
    const { channel, calls, inbound } = setup({ auto_reaction: "like" });
    await inbound("u-7", "m1");
    channel.setAutoReaction(null);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(0);
  });

  it("thả tay (web) + gỡ; thiếu cliMsgId thì báo lỗi rõ", async () => {
    const { channel, calls, reactions } = setup({});
    await channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "c9", reaction: "wow", source: "web", webUserId: "user-1" });
    expect(calls[0]).toMatchObject({ icon: ":o", dest: { data: { msgId: "m9", cliMsgId: "c9" }, threadId: "u-7", type: 0 } });
    expect(reactions[0]).toMatchObject({ source: "web", webUserId: "user-1", icon: ":o" });
    await channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "c9", reaction: "none", source: "web" });
    expect(calls[1]?.icon).toBe("");
    await expect(
      channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "", reaction: "heart", source: "web" }),
    ).rejects.toThrow(/thiếu mã/);
  }, 10_000);
});
