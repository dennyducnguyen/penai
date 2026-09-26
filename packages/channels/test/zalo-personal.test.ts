import { describe, expect, it } from "vitest";
import type { Message } from "zca-js";
import {
  chunkZaloText,
  normalizeZaloChatKey,
  parseZaloDemoThreads,
  parseZaloAttachmentParams,
  parseZaloPersonalCredentials,
  shouldHandleZaloGroup,
  trustedZaloMediaUrl,
  zaloMediaKind,
  ZaloPersonalChannel,
} from "../src/zalo-personal.js";
import { supportedChannelKinds } from "../src/manager.js";

function groupData(patch: Record<string, unknown> = {}): Message["data"] {
  return {
    actionId: "1",
    msgId: "m1",
    cliMsgId: "c1",
    msgType: "webchat",
    uidFrom: "user-1",
    idTo: "group-1",
    dName: "Người dùng",
    ts: "1",
    status: 1,
    content: "xin chào",
    notify: "",
    ttl: 0,
    userId: "user-1",
    uin: "",
    topOut: "",
    topOutTimeOut: "",
    topOutImprTimeOut: "",
    propertyExt: undefined,
    paramsExt: { countUnread: 0, containType: 0, platformType: 0 },
    cmd: 0,
    st: 0,
    at: 0,
    realMsgId: "m1",
    quote: undefined,
    ...patch,
  } as Message["data"];
}

describe("Zalo Personal registration", () => {
  it("đăng ký kind riêng, không ghi đè Zalo OA", () => {
    const kinds = supportedChannelKinds();
    expect(kinds).toContain("zalo");
    expect(kinds).toContain("zalo_personal");
  });

  it("khởi động được ở trạng thái chờ QR khi chưa có credential", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-1",
      name: "Zalo test",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    await channel.start();
    expect(channel.status()).toMatchObject({ running: true, connected: false });
    await channel.stop();
    expect(channel.isRunning()).toBe(false);
  });
});

describe("Zalo Personal credentials", () => {
  it("chỉ nhận credential restore đầy đủ", () => {
    expect(parseZaloPersonalCredentials("{}")).toBeNull();
    expect(parseZaloPersonalCredentials("not-json")).toBeNull();
    expect(
      parseZaloPersonalCredentials(
        JSON.stringify({ imei: "imei", userAgent: "ua", cookie: [] }),
      ),
    ).toMatchObject({ imei: "imei", userAgent: "ua" });
  });
});

describe("Zalo Personal group gating", () => {
  it("bỏ tin group thường khi bắt buộc mention", () => {
    expect(shouldHandleZaloGroup(groupData(), "bot-1", true)).toBe(false);
  });

  it("nhận @mention đích danh, không coi @all là mention bot", () => {
    expect(
      shouldHandleZaloGroup(
        groupData({ mentions: [{ uid: "bot-1", pos: 0, len: 4, type: 0 }] }),
        "bot-1",
        true,
      ),
    ).toBe(true);
    expect(
      shouldHandleZaloGroup(
        groupData({ mentions: [{ uid: "-1", pos: 0, len: 4, type: 1 }] }),
        "bot-1",
        true,
      ),
    ).toBe(false);
  });

  it("nhận reply vào tin của bot và lệnh slash", () => {
    expect(
      shouldHandleZaloGroup(groupData({ quote: { ownerId: "bot-1" } }), "bot-1", true),
    ).toBe(true);
    expect(shouldHandleZaloGroup(groupData({ content: "/help" }), "bot-1", true)).toBe(true);
  });
});

describe("Zalo Personal safe mode", () => {
  const makeChannel = (config: Record<string, unknown> = {}) =>
    new ZaloPersonalChannel({
      id: "zp-safe",
      name: "Zalo safe",
      token: "{}",
      config,
      requirePairing: false,
      onInbound: async () => ({ kind: "ignore" }),
    });

  it("chuẩn hóa chatKey và đọc demo_threads từ config", () => {
    expect(normalizeZaloChatKey("group:123")).toBe("group:123");
    expect(normalizeZaloChatKey("987")).toBe("direct:987");
    expect(
      parseZaloDemoThreads({ demo_threads: ["group:1", "group:1", 42, "direct:2"] }),
    ).toEqual(["group:1", "direct:2"]);
    expect(parseZaloDemoThreads({})).toEqual([]);
    expect(parseZaloDemoThreads({ demo_threads: "group:1" })).toEqual([]);
  });

  it("mặc định không có thread demo — status báo safe mode, danh sách trống", () => {
    const channel = makeChannel();
    expect(channel.status()).toMatchObject({
      safeMode: true,
      demoThreads: [],
      observedCount: 0,
    });
    expect(channel.listObserved()).toEqual([]);
  });

  it("chặn test message ngoài thread demo, cho thread được chỉ định", async () => {
    const channel = makeChannel({ demo_threads: ["group:g-demo"] });
    await expect(
      channel.sendTestMessage("g-khac", "group", "xin chào"),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
    // Thread demo hợp lệ: vượt qua gate an toàn, chỉ dừng ở bước chưa đăng nhập
    await expect(
      channel.sendTestMessage("g-demo", "group", "xin chào"),
    ).rejects.toThrow(/chưa đăng nhập/);
  });

  it("send() kiểm tra allowlist trước cả trạng thái đăng nhập (fail-closed)", async () => {
    const channel = makeChannel({ demo_threads: ["group:g-demo"] });
    await expect(
      channel.send({ chatKey: "group:g-khac", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
    await expect(
      channel.send({ chatKey: "group:g-demo", text: "hi" }),
    ).rejects.toThrow(/chưa đăng nhập/);
  });

  it("tắt yêu cầu pairing → DM mở (openDirect), nhóm ngoài demo vẫn chặn", async () => {
    const channel = makeChannel(); // requirePairing: false
    expect(channel.status().openDirect).toBe(true);
    // DM người lạ: vượt gate an toàn, chỉ dừng ở bước chưa đăng nhập
    await expect(
      channel.send({ chatKey: "direct:nguoi-la", text: "hi" }),
    ).rejects.toThrow(/chưa đăng nhập/);
    // Nhóm lạ: vẫn fail-closed — không mở nhóm tự do
    await expect(
      channel.send({ chatKey: "group:nhom-la", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
  });

  it("bật yêu cầu pairing → DM ngoài demo vẫn bị chặn fail-closed", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-pair",
      name: "Zalo pairing",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    expect(channel.status().openDirect).toBe(false);
    await expect(
      channel.send({ chatKey: "direct:nguoi-la", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
  });

  it("setDemoThreads cập nhật nóng và bỏ entry sai định dạng", () => {
    const channel = makeChannel();
    channel.setDemoThreads(["group:abc", "direct:xyz", "  ", "raw-id"]);
    // "raw-id" được chuẩn hóa thành direct:raw-id; chuỗi rỗng bị loại
    expect(channel.demoThreads()).toEqual(["direct:raw-id", "direct:xyz", "group:abc"]);
  });
});

describe("Zalo Personal output", () => {
  it("bỏ markdown và chia tin không vượt giới hạn", () => {
    const chunks = chunkZaloText(`**Tiêu đề**\n${"nội dung ".repeat(500)}`, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => part.length <= 200)).toBe(true);
    expect(chunks[0]).toContain("Tiêu đề");
    expect(chunks[0]).not.toContain("**");
  });
});

describe("Zalo Personal inbound media", () => {
  it("tin cậy CDN file/ảnh chat (*.zdn.vn) và avatar (*.zadn.vn), chỉ https", () => {
    expect(trustedZaloMediaUrl("https://f18-zpg.zdn.vn/123/bao-cao.xlsx?x=1")?.hostname).toBe(
      "f18-zpg.zdn.vn",
    );
    expect(trustedZaloMediaUrl("https://f47-photo.talk.zdn.vn/a.jpg")).not.toBeNull();
    expect(trustedZaloMediaUrl("https://s120-ava-talk.zadn.vn/a.jpg")).not.toBeNull();
    expect(trustedZaloMediaUrl("http://f18-zpg.zdn.vn/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("https://evil.example.com/zdn.vn/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("https://zdn.vn.evil.com/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("not a url")).toBeNull();
  });

  it("phân loại theo msgType của Zalo, content.type rỗng vẫn đúng", () => {
    expect(zaloMediaKind("chat.file", "")).toBe("document");
    expect(zaloMediaKind("chat.photo", "")).toBe("photo");
    expect(zaloMediaKind("chat.gif", "")).toBe("photo");
    expect(zaloMediaKind("chat.voice", "")).toBe("voice");
    expect(zaloMediaKind("chat.video.msg", "")).toBe("video");
    expect(zaloMediaKind("chat.sticker", "")).toBe("sticker");
    expect(zaloMediaKind("", "")).toBe("unknown");
    expect(zaloMediaKind("", "photo")).toBe("photo");
  });

  it("đọc fileExt/fileSize từ params JSON, bỏ qua params hỏng", () => {
    expect(parseZaloAttachmentParams('{"fileExt":"xlsx","fileSize":"12345","checksum":"x"}')).toEqual({
      fileExt: "xlsx",
      fileSize: 12345,
    });
    expect(parseZaloAttachmentParams("{oops")).toEqual({});
    expect(parseZaloAttachmentParams(undefined)).toEqual({});
  });
});
