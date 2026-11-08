import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MetaPageChannel,
  chunkMetaText,
  exchangeHubCode,
  parseExchangeCode,
  parseHoiaiConnectCode,
  parseMetaWebhook,
  sameOrigin,
  serializeMetaCredentials,
  verifyHubSignature,
  verifyMetaAppSignature,
  type ChannelMessageLog,
  type InboundMessage,
  type RunHooks,
} from "../src/index.js";

const SECRET = "psec_test";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const codePayload = {
  v: 1,
  platform: "facebook",
  page_id: "1065",
  page_name: "Thời Trang KOS",
  page_access_token: "EAA-old",
  penai_secret: SECRET,
  hoiai_url: "https://chat.hoiai.vn",
  register_webhook_endpoint: "https://chat.hoiai.vn/api/facebook/penai/register-webhook",
  refresh_token_endpoint: "https://chat.hoiai.vn/api/facebook/penai/token",
};
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("mã kết nối HoiAI", () => {
  it("giải mã hfb_/hig_ và kiểm trường bắt buộc", () => {
    const p = parseHoiaiConnectCode("hfb_" + b64(codePayload));
    expect(p).toMatchObject({ platform: "facebook", page_id: "1065", page_name: "Thời Trang KOS", penai_secret: SECRET });
    expect(() => parseHoiaiConnectCode("xyz_" + b64(codePayload))).toThrow(/hfb_/);
    expect(() => parseHoiaiConnectCode("hfb_" + b64({ ...codePayload, penai_secret: "" }))).toThrow(/bắt buộc/);
    expect(() => parseHoiaiConnectCode("hig_" + b64({ ...codePayload, platform: "instagram" }))).toThrow(/Instagram/);
    expect(parseHoiaiConnectCode("hig_" + b64({ ...codePayload, platform: "instagram", ig_account_id: "1784" }))).toMatchObject({ platform: "instagram", ig_account_id: "1784" });
    expect(() => parseHoiaiConnectCode("hig_" + b64(codePayload))).toThrow(/mâu thuẫn/);
  });
  it("mã dùng một lần hfbx_ → đổi lấy thông tin qua API của hub", async () => {
    expect(parseExchangeCode("hfbx_short")).toBeNull();
    const code = "hfbx_" + "a".repeat(32);
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, data: codePayload }), { status: 200 });
    });
    try {
      const p = await exchangeHubCode("https://chat.hoiai.vn", code);
      expect(p).toMatchObject({ platform: "facebook", page_id: "1065", penai_secret: SECRET });
      expect(seen[0]).toEqual({ url: "https://chat.hoiai.vn/api/facebook/penai/exchange", body: { code } });
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false, message: "Mã đã dùng" }), { status: 410 }));
      await expect(exchangeHubCode("https://chat.hoiai.vn", code)).rejects.toThrow(/Mã đã dùng/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("chỉ nhận endpoint cùng gốc với hub", () => {
    expect(sameOrigin("https://chat.hoiai.vn/api/x", "https://chat.hoiai.vn")).toBe(true);
    expect(sameOrigin("https://evil.example/api/x", "https://chat.hoiai.vn")).toBe(false);
    expect(sameOrigin("http://chat.hoiai.vn/api/x", "http://chat.hoiai.vn")).toBe(false);
  });
});

describe("chữ ký webhook", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  it("bản 1: HMAC trên body gốc", () => {
    expect(verifyHubSignature(body, { signature: sign(body) }, SECRET)).toBe(true);
    expect(verifyHubSignature(body + " ", { signature: sign(body) }, SECRET)).toBe(false);
    expect(verifyHubSignature(body, { signature: sign(body) }, "khac")).toBe(false);
    expect(verifyHubSignature(body, {}, SECRET)).toBe(false);
  });
  it("bản 2: kèm thời điểm, quá 5 phút thì từ chối", () => {
    const now = Date.UTC(2026, 10, 8, 10, 0, 0);
    const ts = String(Math.floor(now / 1000));
    const v2 = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    expect(verifyHubSignature(body, { signatureV2: v2, timestamp: ts }, SECRET, now)).toBe(true);
    expect(verifyHubSignature(body, { signatureV2: v2, timestamp: ts }, SECRET, now + 10 * 60_000)).toBe(false);
    // Có chữ ký bản 2 sai thì không lùi về bản 1
    expect(verifyHubSignature(body, { signatureV2: "sha256=00", timestamp: ts, signature: sign(body) }, SECRET, now)).toBe(false);
  });
});

describe("đọc sự kiện", () => {
  const payload = {
    object: "page",
    entry: [
      {
        id: "1065",
        messaging: [
          { sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 1, message: { mid: "m1", text: "Chào shop" } },
          { sender: { id: "1065" }, recipient: { id: "u1" }, timestamp: 2, message: { mid: "m2", text: "Dạ", is_echo: true, app_id: 263902037430900 } },
          { sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 3, postback: { title: "Xem giá", payload: "PRICE" } },
          { sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 4, read: { watermark: 1 } },
          { sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 5, message: { mid: "m3", attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/a.jpg" } }] } },
        ],
      },
      { id: "9999", messaging: [{ sender: { id: "u2" }, recipient: { id: "9999" }, message: { mid: "x", text: "trang khác" } }] },
    ],
  };
  it("tách tin khách, tin dội lại, bấm nút; bỏ trang khác + sự kiện đã đọc", () => {
    const ev = parseMetaWebhook(payload, "facebook", "1065");
    expect(ev.map((e) => e.type)).toEqual(["message", "echo", "postback", "message"]);
    expect(ev[1]).toMatchObject({ type: "echo", customerId: "u1", appId: "263902037430900" });
    expect(ev[3]).toMatchObject({ attachments: [{ type: "image", url: "https://scontent.xx.fbcdn.net/a.jpg" }] });
  });
  it("kênh Facebook bỏ qua sự kiện Instagram và ngược lại", () => {
    expect(parseMetaWebhook({ ...payload, object: "instagram" }, "facebook", "1065")).toEqual([]);
    expect(parseMetaWebhook(payload, "instagram", "1065")).toEqual([]);
  });
  it("cắt đoạn văn bản dài", () => {
    const parts = chunkMetaText(("câu dài ".repeat(400)).trim(), 1000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(("câu dài ".repeat(400)).trim());
  });
});

describe("MetaPageChannel", () => {
  type Call = { url: string; method: string; body: unknown };
  let calls: Call[];
  let logs: ChannelMessageLog[];
  let inbound: InboundMessage[];
  let reply: (m: InboundMessage, h?: RunHooks) => Promise<{ kind: "reply"; text: string; media?: string[] } | { kind: "ignore" }>;
  let secretSaved: string[];
  let graphFail: ((c: Call) => Response | null) | null;
  let midN: number;
  let dir: string;

  function make(kind: "facebook" | "instagram" = "facebook") {
    const ch = new MetaPageChannel(kind, {
      id: "ch1",
      name: "KOS",
      token: serializeMetaCredentials({ pageAccessToken: "EAA-old", penaiSecret: SECRET }),
      config: { pageId: "1065", pageName: "Thời Trang KOS", igAccountId: "1784", igUsername: "kos", refreshEndpoint: codePayload.refresh_token_endpoint },
      requirePairing: false,
      onInbound: async (m, h) => {
        inbound.push(m);
        return reply(m, h);
      },
      onMessageLog: (e) => logs.push(e),
      onSecretChanged: async (s) => void secretSaved.push(s),
      publishFile: async (_p, name) => `https://penai.test/f/${name}`,
    });
    ch.echoGraceMs = 30;
    return ch;
  }

  beforeEach(async () => {
    calls = [];
    logs = [];
    inbound = [];
    secretSaved = [];
    graphFail = null;
    midN = 0;
    reply = async () => ({ kind: "reply", text: "**Dạ** shop chào bạn" });
    dir = await mkdtemp(join(tmpdir(), "penai-meta-"));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") body = JSON.parse(body);
      const call = { url, method, body };
      calls.push(call);
      if (url.startsWith("https://chat.hoiai.vn/api/facebook/penai/token")) {
        return new Response(JSON.stringify({ success: true, data: { page_access_token: "EAA-new" } }), { status: 200 });
      }
      if (url.includes("scontent.xx.fbcdn.net")) {
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      const failed = graphFail?.(call);
      if (failed) return failed;
      if (url.includes("/messages") && method === "POST") {
        const b = body as { sender_action?: string } | FormData;
        if (b && !(b instanceof FormData) && b.sender_action) return new Response(JSON.stringify({ recipient_id: "u1" }), { status: 200 });
        return new Response(JSON.stringify({ recipient_id: "u1", message_id: `mid.out${++midN}` }), { status: 200 });
      }
      if (/\/u1\?/.test(url)) return new Response(JSON.stringify({ name: "Nguyễn Văn A", profile_pic: "https://scontent.xx.fbcdn.net/p.jpg" }), { status: 200 });
      return new Response(JSON.stringify({ id: "1065", name: "Thời Trang KOS" }), { status: 200 });
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const hook = (ch: MetaPageChannel, payload: unknown) => {
    const raw = JSON.stringify(payload);
    return ch.handleWebhook(raw, { signature: sign(raw) });
  };
  const msg = (text: string, mid = "m1") => ({ object: "page", entry: [{ id: "1065", messaging: [{ sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 1000, message: { mid, text } }] }] });
  const sentMessages = () => calls.filter((c) => c.url.includes("/1065/messages") && !(c.body as { sender_action?: string })?.sender_action);

  it("từ chối chữ ký sai / kênh tắt", async () => {
    const ch = make();
    const raw = JSON.stringify(msg("hi"));
    expect(ch.handleWebhook(raw, { signature: sign(raw) }).status).toBe(503);
    await ch.start();
    expect(ch.handleWebhook(raw, { signature: "sha256=abc" }).status).toBe(401);
    expect(ch.handleWebhook(raw, { signature: sign(raw) }).status).toBe(200);
    await ch.idle();
  });

  it("nhận tin → ghi Inbox, AI trả lời chữ trơn, ghi tin AI; gửi trùng mid không xử lý lại", async () => {
    const ch = make();
    await ch.start();
    hook(ch, msg("Áo còn size M không?"));
    hook(ch, msg("Áo còn size M không?"));
    await ch.idle();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ chatKey: "u1", senderName: "Nguyễn Văn A", text: "Áo còn size M không?", peerKind: "direct" });
    const sent = sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ recipient: { id: "u1" }, messaging_type: "RESPONSE", message: { text: "Dạ shop chào bạn" } });
    expect(sent[0]!.url).toContain("access_token=EAA-old");
    expect(logs.map((l) => [l.direction, l.source, l.msgId])).toEqual([["in", "peer", "m1"], ["out", "agent", "mid.out1"]]);
  });

  it("bật Đã xem + đang soạn khi AI bắt đầu chạy", async () => {
    reply = async (_m, h) => { h?.onStatus?.("thinking"); return { kind: "reply", text: "ok" }; };
    const ch = make();
    await ch.start();
    hook(ch, msg("hi"));
    await ch.idle();
    await new Promise((r) => setTimeout(r, 20));
    const actions = calls.map((c) => (c.body as { sender_action?: string })?.sender_action).filter(Boolean);
    expect(actions).toEqual(expect.arrayContaining(["mark_seen", "typing_on", "typing_off"]));
  });

  it("AI tạm im (runtime trả ignore) → không gửi gì, không 'đã xem'", async () => {
    reply = async () => ({ kind: "ignore" });
    const ch = make();
    await ch.start();
    hook(ch, msg("hi"));
    await ch.idle();
    expect(calls.filter((c) => c.url.includes("/messages"))).toHaveLength(0);
    expect(logs).toHaveLength(1);
  });

  it("tin dội lại của chính PenAI bỏ qua; người trả lời trên Meta Business Suite → ghi 'app' kèm nguồn", async () => {
    const ch = make();
    await ch.start();
    hook(ch, msg("hi"));
    await ch.idle();
    const echo = (mid: string, appId?: number) => ({ object: "page", entry: [{ id: "1065", messaging: [{ sender: { id: "1065" }, recipient: { id: "u1" }, timestamp: 2000, message: { mid, text: "Nhân viên trả lời", is_echo: true, ...(appId ? { app_id: appId } : {}) } }] }] });
    hook(ch, echo("mid.out1", 123));
    hook(ch, echo("mid.human", 263902037430900));
    hook(ch, echo("mid.human", 263902037430900));
    await ch.idle();
    const human = logs.filter((l) => l.source === "app");
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ direction: "out", threadId: "u1", msgId: "mid.human", text: "Nhân viên trả lời", meta: { via: "Meta Business Suite / hộp thư Trang" } });
    expect(inbound).toHaveLength(1);
  });

  it("ảnh của khách: tải từ CDN Meta, đưa cho AI xem và lưu Inbox", async () => {
    const ch = new MetaPageChannel("facebook", {
      id: "ch1", name: "KOS", token: serializeMetaCredentials({ pageAccessToken: "t", penaiSecret: SECRET }),
      config: { pageId: "1065" }, requirePairing: false,
      onInbound: async (m) => { inbound.push(m); return { kind: "ignore" }; },
      onMessageLog: (e) => logs.push(e),
      saveInboxFile: async (_b, ext) => join(dir, `x.${ext}`),
    });
    await ch.start();
    hook(ch, { object: "page", entry: [{ id: "1065", messaging: [{ sender: { id: "u1" }, recipient: { id: "1065" }, timestamp: 1, message: { mid: "img1", attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/a.jpg" } }, { type: "image", payload: { url: "https://evil.example/b.jpg" } }] } }] }] });
    await ch.idle();
    expect(inbound[0]!.media?.[0]).toMatchObject({ kind: "photo" });
    expect(inbound[0]!.media?.[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(inbound[0]!.media?.[1]).toMatchObject({ kind: "photo", note: expect.stringContaining("không được") });
    expect(logs[0]).toMatchObject({ contentType: "photo", media: { localPath: join(dir, "x.jpg"), albumSize: 2, albumIndex: 0 } });
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("token hết hạn (190) → xin token mới từ hub, lưu lại, gửi lại", async () => {
    let first = true;
    graphFail = (c) => {
      if (c.url.includes("/messages") && c.url.includes("EAA-old") && first) {
        first = false;
        return new Response(JSON.stringify({ error: { message: "Session has expired", code: 190 } }), { status: 400 });
      }
      return null;
    };
    const ch = make();
    await ch.start();
    const ids = await ch.sendManual({ threadId: "u1", peerKind: "direct", text: "Chào", source: "web", webUserId: "w1" });
    expect(ids).toEqual(["mid.out1"]);
    expect(JSON.parse(secretSaved[0]!)).toEqual({ pageAccessToken: "EAA-new", penaiSecret: SECRET });
    expect(calls.at(-1)!.url).toContain("access_token=EAA-new");
    expect(logs.at(-1)).toMatchObject({ source: "web", webUserId: "w1", text: "Chào" });
  });

  it("nhân viên trả lời khi quá 24 giờ → thử lại bằng HUMAN_AGENT; vẫn lỗi thì báo rõ", async () => {
    graphFail = (c) => {
      const b = c.body as { messaging_type?: string };
      if (c.url.includes("/messages") && b?.messaging_type === "RESPONSE") {
        return new Response(JSON.stringify({ error: { message: "(#10) This message is sent outside of allowed window.", code: 10, error_subcode: 2018278 } }), { status: 400 });
      }
      return null;
    };
    const ch = make();
    await ch.start();
    await ch.sendManual({ threadId: "u1", peerKind: "direct", text: "Chào lại", source: "web" });
    expect(calls.at(-1)!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    graphFail = (c) => (c.url.includes("/messages") ? new Response(JSON.stringify({ error: { message: "outside of allowed window", code: 10 } }), { status: 400 }) : null);
    await expect(ch.sendManual({ threadId: "u1", peerKind: "direct", text: "x", source: "web" })).rejects.toThrow(/24 giờ/);
    await expect(ch.sendManual({ threadId: "u1", peerKind: "direct", text: "x", source: "agent" })).rejects.toThrow(/24 giờ/);
  });

  it("gửi file: Facebook tải thẳng (multipart), Instagram gửi bằng link công khai", async () => {
    const img = join(dir, "san-pham.jpg");
    const pdf = join(dir, "bang-gia.pdf");
    await writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(pdf, "%PDF-1.4");
    const fb = make("facebook");
    await fb.start();
    await fb.send({ chatKey: "u1", text: "Mẫu đây ạ", media: [img] });
    const multipart = calls.find((c) => c.body instanceof FormData)!;
    expect((multipart.body as FormData).get("message")).toContain('"type":"image"');
    expect(logs.find((l) => l.contentType === "photo")).toMatchObject({ source: "agent", media: { name: "san-pham.jpg" } });

    calls = [];
    const ig = make("instagram");
    await ig.start();
    await ig.send({ chatKey: "u1", text: "", media: [img, pdf] });
    const bodies = sentMessages().map((c) => c.body as { message: Record<string, unknown> });
    expect(bodies[0]!.message).toEqual({ attachment: { type: "image", payload: { url: "https://penai.test/f/san-pham.jpg" } } });
    expect(bodies[1]!.message).toEqual({ text: "📎 bang-gia.pdf: https://penai.test/f/bang-gia.pdf" });
  });
});

describe("Bình luận, app riêng, thao tác Trang", () => {
  type Call = { url: string; method: string; body: unknown };
  let calls: Call[];
  let logs: ChannelMessageLog[];
  let inbound: InboundMessage[];
  let reply: (m: InboundMessage) => Promise<{ kind: "reply"; text: string } | { kind: "ignore" }>;
  let n: number;
  let dir: string;
  const APP_SECRET = "abcdef0123456789abcdef0123456789";

  function make(kind: "facebook" | "instagram" = "facebook", config: Record<string, unknown> = {}) {
    const ch = new MetaPageChannel(kind, {
      id: "chA",
      name: "KOS",
      token: serializeMetaCredentials({ pageAccessToken: "EAA-app", penaiSecret: "", appSecret: APP_SECRET }),
      config: { mode: "app", metaAppId: "app-row", pageId: "1065", pageName: "Thời Trang KOS", igAccountId: "1784", igUsername: "kos", ...config },
      requirePairing: false,
      onInbound: async (m) => {
        inbound.push(m);
        return reply(m);
      },
      onMessageLog: (e) => logs.push(e),
      publishFile: async (_p, name) => `https://penai.test/f/${name}`,
    });
    ch.echoGraceMs = 20;
    return ch;
  }
  const feed = (value: Record<string, unknown>) => ({
    object: "page",
    entry: [{ id: "1065", time: 1700000000, changes: [{ field: "feed", value: { item: "comment", verb: "add", post_id: "1065_99", created_time: 1700000000, ...value } }] }],
  });

  beforeEach(async () => {
    calls = [];
    logs = [];
    inbound = [];
    n = 0;
    reply = async () => ({ kind: "reply", text: "Dạ áo còn size M ạ" });
    dir = await mkdtemp(join(tmpdir(), "penai-meta2-"));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") body = JSON.parse(body);
      calls.push({ url, method, body });
      const path = new URL(url).pathname.replace("/v22.0", "");
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (method === "GET" && path === "/1065_99") return json({ message: "Áo thun trắng giảm 20% cuối tuần", permalink_url: "https://facebook.com/p/99" });
      if (method === "POST" && /\/comments$|\/replies$/.test(path)) return json({ id: `c.ai${++n}` });
      if (method === "POST" && path === "/1065/messages") return json({ recipient_id: "psid-77", message_id: `mid.p${++n}` });
      if (method === "POST" && path === "/1065/feed") return json({ id: "1065_500" });
      if (method === "POST" && path === "/1065/photos") return json({ id: `ph${++n}`, post_id: "1065_501" });
      if (method === "POST" && path === "/1784/media") return json({ id: `cont${++n}` });
      if (method === "POST" && path === "/1784/media_publish") return json({ id: "ig-post-1" });
      if (method === "GET" && path === "/1065/posts")
        return json({ data: [{ id: "1065_99", message: "Áo", created_time: "2026-11-08T00:00:00+0000", permalink_url: "https://fb/p", comments: { summary: { total_count: 3 } }, reactions: { summary: { total_count: 9 } } }] });
      if (method === "GET" && path === "/1065/insights") return json({ data: [{ name: "page_impressions_unique", title: "Reach", values: [{ value: 12, end_time: "2026-11-07T08:00:00+0000" }] }] });
      return json({ id: "x", permalink_url: "https://fb/x" });
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("đọc sự kiện bình luận Facebook + Instagram; bỏ sự kiện không phải bình luận", () => {
    const fb = parseMetaWebhook(feed({ comment_id: "99_1", message: "Còn size M?", from: { id: "u9", name: "Lan" } }), "facebook", "1065");
    expect(fb[0]).toMatchObject({ type: "comment", commentId: "99_1", postId: "1065_99", fromName: "Lan", verb: "add" });
    expect(parseMetaWebhook(feed({ item: "reaction" }), "facebook", "1065")).toEqual([]);
    const ig = parseMetaWebhook(
      { object: "instagram", entry: [{ id: "1784", time: 1700000000, changes: [{ field: "comments", value: { id: "ig_c1", text: "Giá?", from: { id: "igu", username: "linh" }, media: { id: "ig_m1" } } }] }] },
      "instagram",
      "1784",
    );
    expect(ig[0]).toMatchObject({ type: "comment", commentId: "ig_c1", postId: "ig_m1", fromName: "@linh" });
  });

  it("khách bình luận → Inbox (hội thoại bài viết), AI trả lời công khai + nhắn riêng, ghi đúng nguồn", async () => {
    const ch = make();
    await ch.start();
    ch.ingest(feed({ comment_id: "99_1", message: "Còn size M không shop?", from: { id: "u9", name: "Lan" } }));
    await ch.idle();
    expect(inbound[0]).toMatchObject({ chatKey: "cmt:1065_99:u9", inboxThreadId: "post:1065_99", senderName: "Lan" });
    expect(inbound[0]!.text).toContain("Áo thun trắng giảm 20%");
    expect(logs[0]).toMatchObject({
      threadId: "post:1065_99",
      peerKind: "group",
      direction: "in",
      text: "Còn size M không shop?",
      meta: { commentId: "99_1" },
      threadName: "📝 Áo thun trắng giảm 20% cuối tuần",
    });
    const pub = calls.find((c) => c.method === "POST" && c.url.includes("/99_1/comments"))!;
    expect(pub.body).toEqual({ message: "Dạ áo còn size M ạ" });
    expect(pub.url).toContain("appsecret_proof=" + createHmac("sha256", APP_SECRET).update("EAA-app").digest("hex"));
    const priv = calls.find((c) => c.method === "POST" && c.url.includes("/1065/messages"))!;
    expect(priv.body).toEqual({ recipient: { comment_id: "99_1" }, message: { text: "Dạ áo còn size M ạ" } });
    expect(logs.filter((l) => l.direction === "out").map((l) => [l.threadId, l.source])).toEqual([
      ["post:1065_99", "agent"],
      ["psid-77", "agent"],
    ]);
    // Meta báo lại bình luận của chính Trang (do AI vừa đăng) → không ghi trùng
    ch.ingest(feed({ comment_id: "c.ai1", message: "Dạ áo còn size M ạ", from: { id: "1065", name: "Thời Trang KOS" } }));
    await ch.idle();
    expect(logs.filter((l) => l.direction === "out")).toHaveLength(2);
  });

  it("tắt từng kiểu trả lời; bình luận Trang viết ở Meta Business Suite → ghi người trả lời ngoài PenAI", async () => {
    const ch = make("facebook", { comment_ai_private: false });
    await ch.start();
    ch.ingest(feed({ comment_id: "99_2", message: "Ship Hà Nội không?", from: { id: "u8", name: "Minh" } }));
    await ch.idle();
    expect(calls.some((c) => c.url.includes("/1065/messages"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/99_2/comments"))).toBe(true);
    ch.updateOptions({ comment_ai_public: false, comment_ai_private: false });
    calls = [];
    ch.ingest(feed({ comment_id: "99_3", message: "Còn màu đen?", from: { id: "u8", name: "Minh" } }));
    ch.ingest(feed({ comment_id: "99_4", message: "Dạ còn ạ", from: { id: "1065", name: "KOS" } }));
    await ch.idle();
    expect(inbound).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(logs.at(-1)).toMatchObject({ direction: "out", source: "app", meta: { via: expect.stringContaining("Meta Business Suite") } });
    ch.updateOptions({ comments: false });
    const before = logs.length;
    ch.ingest(feed({ comment_id: "99_5", message: "?", from: { id: "u1", name: "A" } }));
    await ch.idle();
    expect(logs).toHaveLength(before);
  });

  it("Inbox: trả lời bình luận / nhắn riêng / bình luận vào bài", async () => {
    const ch = make();
    await ch.start();
    await ch.sendManual({ threadId: "post:1065_99", peerKind: "group", text: "Có ạ", source: "web", webUserId: "w1", comment: { id: "99_1" } });
    await ch.sendManual({ threadId: "post:1065_99", peerKind: "group", text: "Chi tiết", source: "web", comment: { id: "99_1", private: true } });
    await ch.sendManual({ threadId: "post:1065_99", peerKind: "group", text: "Cảm ơn mọi người", source: "web" });
    const posts = calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname.replace("/v22.0", ""));
    expect(posts).toEqual(["/99_1/comments", "/1065/messages", "/1065_99/comments"]);
    expect(logs[0]).toMatchObject({ threadId: "post:1065_99", source: "web", webUserId: "w1", meta: { parentId: "99_1" } });
  });

  it("app riêng: token hỏng (190) không gọi hub, báo đăng nhập lại", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      calls.push({ url: String(input), method: "POST", body: null });
      return new Response(JSON.stringify({ error: { message: "expired", code: 190 } }), { status: 400 });
    });
    const ch = make();
    await ch.start();
    await expect(ch.sendManual({ threadId: "123", peerKind: "direct", text: "x", source: "web" })).rejects.toThrow();
    expect(calls.some((c) => c.url.includes("hoiai"))).toBe(false);
    expect(ch.status().authError).toMatch(/Đăng nhập Facebook lại/);
  });

  it("đăng bài Facebook: chữ + link, 1 ảnh (multipart), hẹn giờ; Instagram: carousel qua container", async () => {
    const img = join(dir, "a.jpg");
    const img2 = join(dir, "b.jpg");
    await writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(img2, Buffer.from([0xff, 0xd8, 0xff]));
    const fb = make();
    await fb.start();
    expect(await fb.createPost({ message: "Xin chào", link: "https://shop.vn" })).toMatchObject({ id: "1065_500" });
    expect(calls.find((c) => c.url.includes("/1065/feed"))!.body).toEqual({ message: "Xin chào", link: "https://shop.vn" });
    const one = await fb.createPost({ message: "Ảnh mới", filePaths: [img] });
    expect(one.id).toBe("1065_501");
    const form = calls.find((c) => c.url.includes("/1065/photos"))!.body as FormData;
    expect(form.get("caption")).toBe("Ảnh mới");
    const when = new Date(Date.now() + 3600_000);
    calls = [];
    await fb.createPost({ message: "Hẹn giờ", scheduledAt: when });
    expect(calls.find((c) => c.url.includes("/1065/feed"))!.body).toMatchObject({ published: false, scheduled_publish_time: Math.floor(when.getTime() / 1000) });
    await expect(fb.createPost({ message: "x", scheduledAt: new Date(Date.now() + 60_000) })).rejects.toThrow(/10 phút/);

    calls = [];
    const ig = make("instagram");
    await ig.start();
    expect(await ig.createPost({ message: "Bộ sưu tập", filePaths: [img, img2] })).toMatchObject({ id: "ig-post-1" });
    const media = calls.filter((c) => c.url.includes("/1784/media") && !c.url.includes("publish")).map((c) => c.body);
    expect(media.slice(0, 2)).toEqual([
      { image_url: "https://penai.test/f/a.jpg", is_carousel_item: true },
      { image_url: "https://penai.test/f/b.jpg", is_carousel_item: true },
    ]);
    expect(media[2]).toMatchObject({ media_type: "CAROUSEL", caption: "Bộ sưu tập" });
    await expect(ig.createPost({ message: "chỉ chữ" })).rejects.toThrow(/ít nhất 1 ảnh/);
    await expect(ig.deletePost("x")).rejects.toThrow(/Instagram không cho xóa/);
  });

  it("đọc bài viết, số liệu, ẩn bình luận", async () => {
    const ch = make();
    await ch.start();
    expect(await ch.listPosts(5)).toEqual([{ id: "1065_99", text: "Áo", createdAt: "2026-11-08T00:00:00+0000", permalink: "https://fb/p", comments: 3, likes: 9 }]);
    expect((await ch.insights({ days: 3 }))[0]).toMatchObject({ metric: "page_impressions_unique", values: [{ date: "2026-11-07", value: 12 }] });
    await ch.hideComment("99_1", true);
    expect(calls.at(-1)!.body).toEqual({ is_hidden: true });
  });

  it("chữ ký webhook gửi thẳng từ Meta (X-Hub-Signature-256)", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
    expect(verifyMetaAppSignature(body, sig, APP_SECRET)).toBe(true);
    expect(verifyMetaAppSignature(body + " ", sig, APP_SECRET)).toBe(false);
    expect(verifyMetaAppSignature(body, undefined, APP_SECRET)).toBe(false);
  });
});
