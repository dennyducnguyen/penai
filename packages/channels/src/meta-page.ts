import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { logger } from "@penai/shared";
import type { InboxAccount, InboxCapabilities, InboxChannel, InboxSendSource } from "./inbox-channel.js";
import { stripToPlain } from "./format.js";
import { TypingController } from "./typing.js";
import type { ChannelDeps, ChannelMessageLog, InboundMedia, OutboundMessage } from "./types.js";

/**
 * Kênh Trang Meta: Facebook Fanpage (Messenger) và Instagram Business (Direct).
 *
 * Kết nối qua một "hub" (mặc định chat.hoiai.vn) giữ Meta App: hub lo đăng nhập Facebook,
 * nhận webhook của Meta rồi chuyển tiếp sang PenAI kèm chữ ký HMAC. PenAI gửi tin thẳng lên
 * Graph API bằng Page Access Token. Chi tiết: docs/facebook-instagram.md.
 *
 * token (mã hóa trong DB) = JSON {pageAccessToken, penaiSecret}; config = thông tin Trang + hub.
 * chatKey = threadId = PSID (Facebook) / IGSID (Instagram) của khách.
 */

export const META_CHANNEL_KINDS = ["facebook", "instagram"] as const;
export type MetaChannelKind = (typeof META_CHANNEL_KINDS)[number];

export function isMetaChannelKind(kind: string): kind is MetaChannelKind {
  return kind === "facebook" || kind === "instagram";
}

export const META_GRAPH_BASE = "https://graph.facebook.com/v22.0";

/** Hub mặc định — đổi bằng biến PENAI_META_HUB_URL trong penai.env. */
export const DEFAULT_META_HUB_URL = "https://chat.hoiai.vn";

// ===== Mã kết nối (hfb_… / hig_…) =====

export interface HoiaiConnectPayload {
  v?: number;
  platform: MetaChannelKind;
  page_id: string;
  page_name: string;
  avatar_url?: string | null;
  ig_account_id?: string | null;
  ig_username?: string | null;
  ig_name?: string | null;
  ig_avatar_url?: string | null;
  page_access_token: string;
  penai_secret: string;
  hoiai_url?: string;
  issuer?: string;
  register_webhook_endpoint: string;
  refresh_token_endpoint: string;
  issued_at?: number;
}

export class MetaConnectCodeError extends Error {}

/** Giải mã `hfb_<base64url JSON>` (Fanpage) / `hig_…` (Instagram). Chỉ đọc, chưa gọi mạng. */
export function parseHoiaiConnectCode(code: string): HoiaiConnectPayload {
  const trimmed = String(code ?? "").trim();
  const m = /^h(fb|ig)_([A-Za-z0-9_-]+={0,2})$/.exec(trimmed);
  if (!m) throw new MetaConnectCodeError("Mã kết nối không hợp lệ — phải bắt đầu bằng hfb_ (Fanpage) hoặc hig_ (Instagram).");
  let payload: Partial<HoiaiConnectPayload>;
  try {
    payload = JSON.parse(Buffer.from(m[2]!, "base64url").toString("utf8")) as Partial<HoiaiConnectPayload>;
  } catch {
    throw new MetaConnectCodeError("Mã kết nối bị cắt thiếu hoặc sai — hãy sao chép lại cả mã.");
  }
  return normalizeConnectPayload(payload, m[1] === "ig" ? "instagram" : "facebook");
}

/**
 * Mã dùng một lần (hub bản 2): `hfbx_<chuỗi ngẫu nhiên>` / `higx_…` — không chứa token;
 * PenAI đổi mã lấy thông tin kết nối qua API máy-chủ-tới-máy-chủ của hub.
 */
export function parseExchangeCode(code: string): { platform: MetaChannelKind; code: string } | null {
  const m = /^h(fb|ig)x_([A-Za-z0-9_-]{20,200})$/.exec(String(code ?? "").trim());
  return m ? { platform: m[1] === "ig" ? "instagram" : "facebook", code: String(code).trim() } : null;
}

/** POST <hub>/api/facebook/penai/exchange {code} → thông tin kết nối (như trong mã hfb_/hig_). */
export async function exchangeHubCode(hubUrl: string, code: string): Promise<HoiaiConnectPayload> {
  const ex = parseExchangeCode(code);
  if (!ex) throw new MetaConnectCodeError("Mã kết nối không hợp lệ.");
  let res: Response;
  try {
    res = await fetch(`${hubUrl}/api/facebook/penai/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: ex.code }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new MetaConnectCodeError(`Không gọi được hub để đổi mã: ${(err as Error).message}`);
  }
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: unknown };
  if (!res.ok || j.success === false || !j.data || typeof j.data !== "object") {
    throw new MetaConnectCodeError(`Hub không chấp nhận mã (${j.message || `HTTP ${res.status}`}) — mã chỉ dùng được một lần và có hạn, hãy lấy mã mới.`);
  }
  return normalizeConnectPayload(j.data as Partial<HoiaiConnectPayload>, ex.platform);
}

function normalizeConnectPayload(payload: Partial<HoiaiConnectPayload>, platform: MetaChannelKind): HoiaiConnectPayload {
  if (payload.platform && payload.platform !== platform) {
    throw new MetaConnectCodeError("Mã kết nối mâu thuẫn (tiền tố và nền tảng bên trong khác nhau).");
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const out: HoiaiConnectPayload = {
    ...(payload as HoiaiConnectPayload),
    platform,
    page_id: str(payload.page_id),
    page_name: str(payload.page_name),
    page_access_token: str(payload.page_access_token),
    penai_secret: str(payload.penai_secret),
    register_webhook_endpoint: str(payload.register_webhook_endpoint),
    refresh_token_endpoint: str(payload.refresh_token_endpoint),
    ig_account_id: str(payload.ig_account_id) || null,
  };
  if (!/^\d{3,30}$/.test(out.page_id) || !out.page_access_token || !out.penai_secret) {
    throw new MetaConnectCodeError("Mã kết nối thiếu thông tin bắt buộc (page_id, page_access_token, penai_secret).");
  }
  if (platform === "instagram" && !/^\d{3,30}$/.test(out.ig_account_id ?? "")) {
    throw new MetaConnectCodeError("Trang này chưa liên kết tài khoản Instagram Business (mã thiếu ig_account_id).");
  }
  if (!out.register_webhook_endpoint || !out.refresh_token_endpoint) {
    throw new MetaConnectCodeError("Mã kết nối thiếu địa chỉ API của hub (register_webhook_endpoint / refresh_token_endpoint).");
  }
  return out;
}

/** URL phải cùng gốc (scheme + host + cổng) với hub đã cấu hình — chặn mã giả dẫn bí mật ra nơi khác. */
export function sameOrigin(url: string, hubUrl: string): boolean {
  try {
    const a = new URL(url), b = new URL(hubUrl);
    return a.protocol === b.protocol && a.host === b.host && (a.protocol === "https:" || a.hostname === "localhost" || a.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

// ===== Thông tin kênh =====

export interface MetaCredentials {
  pageAccessToken: string;
  penaiSecret: string;
}

export function parseMetaCredentials(token: string): MetaCredentials {
  try {
    const j = JSON.parse(token) as Partial<MetaCredentials>;
    return { pageAccessToken: String(j.pageAccessToken ?? ""), penaiSecret: String(j.penaiSecret ?? "") };
  } catch {
    return { pageAccessToken: "", penaiSecret: "" };
  }
}

export function serializeMetaCredentials(c: MetaCredentials): string {
  return JSON.stringify({ pageAccessToken: c.pageAccessToken, penaiSecret: c.penaiSecret });
}

export interface MetaPageConfig {
  platform: MetaChannelKind;
  pageId: string;
  pageName: string;
  pageAvatar?: string;
  igAccountId?: string;
  igUsername?: string;
  igName?: string;
  igAvatar?: string;
  hubUrl?: string;
  registerEndpoint?: string;
  refreshEndpoint?: string;
}

export function readMetaConfig(kind: MetaChannelKind, config: Record<string, unknown>): MetaPageConfig {
  const s = (k: string) => (typeof config[k] === "string" ? (config[k] as string) : "");
  return {
    platform: kind,
    pageId: s("pageId"),
    pageName: s("pageName"),
    pageAvatar: s("pageAvatar"),
    igAccountId: s("igAccountId"),
    igUsername: s("igUsername"),
    igName: s("igName"),
    igAvatar: s("igAvatar"),
    hubUrl: s("hubUrl"),
    registerEndpoint: s("registerEndpoint"),
    refreshEndpoint: s("refreshEndpoint"),
  };
}

// ===== Chữ ký webhook từ hub =====

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Kiểm chữ ký của hub trên ĐÚNG chuỗi body nhận được.
 * - Bản 2 (khuyên dùng): `X-HoiAI-Timestamp` (giây) + `X-HoiAI-Signature: sha256=HMAC(secret, "<ts>.<body>")`,
 *   lệch giờ tối đa 5 phút → chống gửi lại gói cũ.
 * - Bản 1 (hub hiện tại): `X-PenAI-Signature: sha256=HMAC(secret, body)`.
 */
export function verifyHubSignature(
  rawBody: string,
  headers: { signature?: string | undefined; signatureV2?: string | undefined; timestamp?: string | undefined },
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!secret) return false;
  if (headers.signatureV2) {
    const ts = Number(headers.timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(`${headers.timestamp}.${rawBody}`).digest("hex");
    return safeEqual(headers.signatureV2.trim(), expected);
  }
  if (!headers.signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(headers.signature.trim(), expected);
}

// ===== Đọc sự kiện webhook =====

export interface MetaAttachment {
  type: string;
  url?: string;
  title?: string;
  stickerId?: string;
}

export type MetaEvent =
  | {
      type: "message";
      senderId: string;
      mid: string;
      text: string;
      attachments: MetaAttachment[];
      quickReply?: string;
      replyToMid?: string;
      storyUrl?: string;
      timestamp: number;
    }
  | { type: "postback"; senderId: string; mid: string; title: string; payload: string; timestamp: number }
  | { type: "echo"; customerId: string; mid: string; text: string; attachments: MetaAttachment[]; appId?: string; timestamp: number };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function readAttachments(raw: unknown): MetaAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const o = obj(a), p = obj(o.payload);
    const out: MetaAttachment = { type: str(o.type) || "file" };
    const url = str(p.url) || str(o.url);
    if (url) out.url = url;
    const title = str(p.title) || str(o.title) || str(p.name);
    if (title) out.title = title;
    if (p.sticker_id !== undefined) out.stickerId = str(p.sticker_id);
    return out;
  });
}

/**
 * Payload webhook (đã kiểm chữ ký) → danh sách sự kiện cho ĐÚNG kênh này.
 * Kênh Facebook bỏ qua object "instagram" và ngược lại (hub có thể đẩy nhầm khi Trang
 * chưa gắn webhook Instagram riêng); entry khác Trang/tài khoản của kênh cũng bỏ qua.
 */
export function parseMetaWebhook(payload: unknown, kind: MetaChannelKind, ownId: string): MetaEvent[] {
  const p = obj(payload);
  const wantObject = kind === "instagram" ? "instagram" : "page";
  if (p.object !== wantObject || !Array.isArray(p.entry)) return [];
  const out: MetaEvent[] = [];
  for (const entryRaw of p.entry) {
    const entry = obj(entryRaw);
    if (ownId && str(entry.id) && str(entry.id) !== ownId) continue;
    for (const evRaw of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const ev = obj(evRaw);
      const sender = str(obj(ev.sender).id), recipient = str(obj(ev.recipient).id);
      const timestamp = Number(ev.timestamp) || Date.now();
      const message = ev.message ? obj(ev.message) : null;
      if (message) {
        if (message.is_deleted || message.is_unsupported) continue;
        const mid = str(message.mid);
        if (message.is_echo) {
          if (!recipient) continue;
          out.push({
            type: "echo",
            customerId: recipient,
            mid,
            text: str(message.text),
            attachments: readAttachments(message.attachments),
            ...(message.app_id !== undefined ? { appId: str(message.app_id) } : {}),
            timestamp,
          });
          continue;
        }
        if (!sender || sender === ownId) continue;
        const replyTo = obj(message.reply_to);
        const story = obj(replyTo.story);
        out.push({
          type: "message",
          senderId: sender,
          mid,
          text: str(message.text),
          attachments: readAttachments(message.attachments),
          ...(obj(message.quick_reply).payload !== undefined ? { quickReply: str(obj(message.quick_reply).payload) } : {}),
          ...(str(replyTo.mid) ? { replyToMid: str(replyTo.mid) } : {}),
          ...(str(story.url) ? { storyUrl: str(story.url) } : {}),
          timestamp,
        });
        continue;
      }
      if (ev.postback && sender && sender !== ownId) {
        const pb = obj(ev.postback);
        out.push({ type: "postback", senderId: sender, mid: str(pb.mid), title: str(pb.title), payload: str(pb.payload), timestamp });
      }
      // read / delivery / reaction / referral: chưa dùng
    }
  }
  return out;
}

// ===== Chia đoạn văn bản =====

/** Cắt văn bản thành đoạn ≤ max ký tự, ưu tiên cắt ở xuống dòng rồi dấu cách. */
export function chunkMetaText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let at = rest.lastIndexOf("\n", max);
    if (at < max * 0.4) at = rest.lastIndexOf(" ", max);
    if (at < max * 0.4) at = max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ===== Graph API =====

export class MetaGraphError extends Error {
  readonly platformRejected = true;
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
  /** Quá 24 giờ kể từ tin cuối của khách — Meta không cho Trang nhắn chủ động. */
  get outsideWindow(): boolean {
    return this.code === 10 || this.subcode === 2018278 || this.subcode === 2534022 || /outside of allowed window/i.test(this.message);
  }
}

/** Ảnh/video/file từ CDN của Meta — chỉ tải về từ các tên miền này. */
const META_CDN = /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|cdninstagram\.com|instagram\.com)$/i;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus"]);
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".pdf": "application/pdf",
};

export function metaAttachmentType(path: string): "image" | "video" | "audio" | "file" {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "file";
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "audio/wav": "wav", "audio/ogg": "ogg", "application/pdf": "pdf",
};

/** App ID của hộp thư Trang (Meta Business Suite / ứng dụng Trang) trong tin dội lại. */
const PAGE_INBOX_APP_IDS = new Set(["263902037430900"]);

const FB_TEXT_MAX = 2000;
const IG_TEXT_MAX = 1000;
const DOWNLOAD_MAX = 25 * 1024 * 1024;
const VISION_MAX = 8 * 1024 * 1024;
/** Chờ kết quả gửi về trước khi coi một tin dội lại là do người khác gửi. */
export const ECHO_GRACE_MS = 2500;

type GraphInit = { method?: "GET" | "POST" | "DELETE"; json?: unknown; form?: () => FormData; query?: Record<string, string>; timeoutMs?: number };

export class MetaPageChannel implements InboxChannel {
  readonly kind: MetaChannelKind;
  readonly id: string;
  readonly name: string;
  private creds: MetaCredentials;
  private cfg: MetaPageConfig;
  private running = false;
  private authError: string | null = null;
  private lastError: string | null = null;
  private lastWebhookAt: Date | null = null;
  private refreshing: Promise<boolean> | null = null;
  private lastRefreshAt = 0;
  /** mid đã xử lý (chống trùng khi hub gửi lại) */
  private seen = new Map<string, number>();
  /** mid PenAI vừa gửi (để nhận ra tin dội lại của chính mình) */
  private sent = new Map<string, number>();
  private profiles = new Map<string, { name: string; avatar: string; at: number }>();
  /** Xử lý tuần tự theo từng khách */
  private chains = new Map<string, Promise<void>>();
  /** Chờ trước khi coi tin dội lại là người khác gửi — test chỉnh nhỏ lại. */
  echoGraceMs = ECHO_GRACE_MS;

  constructor(kind: MetaChannelKind, private readonly deps: ChannelDeps) {
    this.kind = kind;
    this.id = deps.id;
    this.name = deps.name;
    this.creds = parseMetaCredentials(deps.token);
    this.cfg = readMetaConfig(kind, deps.config);
  }

  // ----- vòng đời -----

  async start(): Promise<void> {
    this.running = true;
    if (!this.creds.pageAccessToken) {
      this.authError = "Thiếu Page Access Token — kết nối lại Trang.";
      return;
    }
    // Kiểm token nền, không chặn khởi động
    void this.graph(`/${this.cfg.pageId}`, { query: { fields: "id,name" }, timeoutMs: 15_000 })
      .then(() => { this.authError = null; })
      .catch((err: unknown) => {
        if (err instanceof MetaGraphError && (err.code === 190 || err.status === 401)) {
          this.authError = `Token Trang không còn hiệu lực: ${err.message}`;
        }
        logger.warn(`meta.start_check (${this.name}): ${(err as Error).message}`);
      });
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  isConnected(): boolean {
    return this.running && !!this.creds.pageAccessToken && !this.authError;
  }

  /** Mã của tài khoản nhận tin: Page ID (Facebook) / Instagram account ID. */
  get ownId(): string {
    return this.kind === "instagram" ? (this.cfg.igAccountId ?? "") : this.cfg.pageId;
  }

  accountInfo(): InboxAccount | null {
    const ig = this.kind === "instagram";
    const name = ig ? (this.cfg.igUsername ? `@${this.cfg.igUsername}` : this.cfg.igName || this.cfg.pageName) : this.cfg.pageName;
    const avatar = ig ? this.cfg.igAvatar : this.cfg.pageAvatar;
    return { id: this.ownId, name: name || this.name, ...(avatar ? { avatar } : {}) };
  }

  inboxCapabilities(): InboxCapabilities {
    return { groups: false, phoneLookup: false, syncContacts: false, reactions: false, newConversation: false, mcp: false, files: true, photoAi: true };
  }

  status(): { running: boolean; connected: boolean; error: string | null; authError: string | null; lastWebhookAt: string | null; account: InboxAccount | null } {
    return {
      running: this.running,
      connected: this.isConnected(),
      error: this.lastError,
      authError: this.authError,
      lastWebhookAt: this.lastWebhookAt ? this.lastWebhookAt.toISOString() : null,
      account: this.accountInfo(),
    };
  }

  // ----- nhận webhook -----

  /**
   * Webhook do hub chuyển tới. Kiểm chữ ký trên body gốc → trả mã HTTP ngay;
   * xử lý tin chạy nền (Meta/hub cần phản hồi nhanh).
   */
  handleWebhook(
    rawBody: string,
    headers: { signature?: string | undefined; signatureV2?: string | undefined; timestamp?: string | undefined },
  ): { status: number; error?: string; events?: number } {
    if (!this.running) return { status: 503, error: "Kênh đang tạm dừng" };
    if (!verifyHubSignature(rawBody, headers, this.creds.penaiSecret)) return { status: 401, error: "Sai chữ ký" };
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, error: "Body không phải JSON" };
    }
    this.lastWebhookAt = new Date();
    const events = parseMetaWebhook(payload, this.kind, this.ownId);
    for (const ev of events) {
      const key = ev.type === "echo" ? ev.customerId : ev.senderId;
      if (ev.mid && ev.type !== "echo") {
        if (this.seen.has(ev.mid)) continue;
        this.remember(this.seen, ev.mid);
      }
      const prev = this.chains.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => (ev.type === "echo" ? this.onEcho(ev) : this.onCustomerEvent(ev)))
        .catch((err: unknown) => {
          this.lastError = (err as Error).message;
          this.deps.onError?.(err as Error);
        })
        .finally(() => {
          if (this.chains.get(key) === next) this.chains.delete(key);
        });
      this.chains.set(key, next);
    }
    return { status: 200, events: events.length };
  }

  /** Chờ mọi tin đang xử lý xong (test). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private remember(map: Map<string, number>, key: string): void {
    map.set(key, Date.now());
    if (map.size > 3000) {
      const cut = Date.now() - 6 * 3600_000;
      for (const [k, at] of map) if (at < cut || map.size > 2500) map.delete(k);
    }
  }

  private async onCustomerEvent(ev: Extract<MetaEvent, { type: "message" | "postback" }>): Promise<void> {
    const threadId = ev.senderId;
    const profile = await this.profile(threadId);
    const senderName = profile?.name || threadId;
    let text: string;
    const media: InboundMedia[] = [];
    let logContent: Pick<ChannelMessageLog, "contentType" | "text" | "media">;
    const meta: Record<string, unknown> = {};

    if (ev.type === "postback") {
      text = ev.title || ev.payload;
      logContent = { contentType: "text", text: ev.title ? `[Bấm nút] ${ev.title}` : `[Bấm nút] ${ev.payload}` };
      if (ev.payload) meta.postback = ev.payload.slice(0, 500);
    } else {
      text = ev.text;
      if (ev.quickReply) meta.quickReply = ev.quickReply.slice(0, 500);
      if (ev.replyToMid) meta.replyToMid = ev.replyToMid;
      if (ev.storyUrl) {
        meta.story = ev.storyUrl;
        text = text ? `[Khách trả lời story của Trang] ${text}` : "[Khách trả lời story của Trang]";
      }
      const first = await this.collectInbound(ev.attachments, media);
      logContent = { contentType: first?.contentType ?? "text", text: ev.text, ...(first?.media ? { media: first.media } : {}) };
      if (!logContent.text && first?.contentType === "other") logContent.text = first.label;
    }

    this.deps.onMessageLog?.({
      threadId,
      peerKind: "direct",
      msgId: ev.mid,
      direction: "in",
      source: "peer",
      senderId: threadId,
      senderName,
      ...logContent,
      ...(Object.keys(meta).length ? { meta } : {}),
      sentAt: new Date(ev.timestamp),
      threadName: senderName,
    });

    if (!text.trim() && !media.length) return;

    let typing: TypingController | null = null;
    const startTyping = () => {
      if (typing) return;
      void this.senderAction(threadId, "mark_seen").catch(() => {});
      typing = new TypingController({
        start: () => this.senderAction(threadId, "typing_on"),
        stop: () => this.senderAction(threadId, "typing_off"),
        keepaliveMs: 15_000,
        maxDurationMs: 180_000,
      });
      typing.start();
    };
    try {
      const result = await this.deps.onInbound(
        {
          channelId: this.id,
          channelKind: this.kind,
          chatKey: threadId,
          senderId: threadId,
          senderName,
          text,
          peerKind: "direct",
          ...(media.length ? { media } : {}),
        },
        {
          onStatus: (s) => {
            if (s === "queued" || s === "thinking" || s === "tool" || s === "web" || s === "coding") startTyping();
          },
          onBlockReply: (block) => {
            if (block.trim()) void this.sendTextLogged(threadId, block, "agent").catch((e: unknown) => this.deps.onError?.(e as Error));
          },
        },
      );
      (typing as TypingController | null)?.markRunComplete();
      if (result.kind === "reply" || result.kind === "pairing") {
        if (result.text.trim()) await this.sendTextLogged(threadId, result.text, "agent");
        if (result.kind === "reply" && result.media?.length) await this.sendFilesLogged(threadId, result.media, "agent");
      }
    } catch (err) {
      this.deps.onError?.(err as Error);
      await this.sendTextLogged(threadId, "Xin lỗi, hệ thống đang bận. Bạn vui lòng nhắn lại sau ít phút nhé.", "agent").catch(() => {});
    } finally {
      (typing as TypingController | null)?.stopNow();
    }
  }

  /** Tin dội lại: Trang vừa gửi đi. Không phải PenAI gửi → người trả lời ở nơi khác. */
  private async onEcho(ev: Extract<MetaEvent, { type: "echo" }>): Promise<void> {
    if (ev.mid && this.sent.has(ev.mid)) return;
    if (ev.mid) await new Promise((r) => setTimeout(r, this.echoGraceMs));
    if (ev.mid && this.sent.has(ev.mid)) return;
    if (ev.mid && this.seen.has(`echo:${ev.mid}`)) return;
    if (ev.mid) this.remember(this.seen, `echo:${ev.mid}`);
    const via = !ev.appId
      ? `Trang ${this.kind === "instagram" ? "Instagram" : "Facebook"}`
      : PAGE_INBOX_APP_IDS.has(ev.appId)
        ? "Meta Business Suite / hộp thư Trang"
        : `ứng dụng khác (app ${ev.appId})`;
    const first = describeAttachments(ev.attachments);
    const account = this.accountInfo();
    this.deps.onMessageLog?.({
      threadId: ev.customerId,
      peerKind: "direct",
      msgId: ev.mid,
      direction: "out",
      source: "app",
      senderId: account?.id ?? "",
      senderName: account?.name ?? "",
      contentType: first?.contentType ?? "text",
      text: ev.text || (first && !first.media ? first.label : ""),
      ...(first?.media ? { media: first.media } : {}),
      meta: { via, ...(ev.appId ? { appId: ev.appId } : {}) },
      sentAt: new Date(ev.timestamp),
    });
  }

  /** Tải đính kèm của khách: ảnh → cho AI xem + lưu Inbox; file → AI đọc; video/âm thanh → ghi chú. */
  private async collectInbound(
    atts: MetaAttachment[],
    media: InboundMedia[],
  ): Promise<{ contentType: ChannelMessageLog["contentType"]; media?: ChannelMessageLog["media"]; label: string } | null> {
    let first: { contentType: ChannelMessageLog["contentType"]; media?: ChannelMessageLog["media"]; label: string } | null = null;
    let index = 0;
    for (const a of atts) {
      const d = describeAttachments([a]);
      if (!d) continue;
      let localPath: string | undefined;
      if (a.url && ["image", "video", "audio", "file"].includes(a.type) && !a.stickerId) {
        const got = await this.download(a.url).catch(() => null);
        if (got) {
          if (this.deps.saveInboxFile) localPath = await this.deps.saveInboxFile(got.buf, got.ext).catch(() => undefined);
          if (a.type === "image" && got.buf.length <= VISION_MAX && got.mime.startsWith("image/")) {
            media.push({ kind: "photo", dataUrl: `data:${got.mime};base64,${got.buf.toString("base64")}`, name: `anh.${got.ext}` });
          } else if (a.type === "file") {
            media.push({ kind: "document", dataB64: got.buf.toString("base64"), name: a.title || `tep.${got.ext}` });
          } else if (a.type === "video") {
            media.push({ kind: "video", note: "[Khách gửi một video — AI chưa xem được video, hãy hỏi khách cần gì]" });
          } else if (a.type === "audio") {
            media.push({ kind: "voice", note: "[Khách gửi tin nhắn thoại — AI chưa nghe được, hãy nhờ khách nhắn chữ]" });
          }
        } else if (a.type === "image") {
          media.push({ kind: "photo", note: "[Khách gửi một ảnh nhưng tải về không được]" });
        }
      } else if (a.type === "share" || a.type === "ig_reel" || a.type === "reel" || a.type === "story_mention") {
        media.push({ kind: "document", note: `[Khách chia sẻ ${d.label}${a.url ? `: ${a.url}` : ""}]` });
      }
      if (!first) {
        first = { ...d, ...(d.media ? { media: { ...d.media, ...(localPath ? { localPath } : {}), ...(atts.length > 1 ? { albumSize: atts.length, albumIndex: index } : {}) } } : {}) };
      }
      index++;
    }
    return first;
  }

  private async download(url: string): Promise<{ buf: Buffer; mime: string; ext: string } | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || !META_CDN.test(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > DOWNLOAD_MAX) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > DOWNLOAD_MAX) return null;
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const fromPath = extname(u.pathname).replace(".", "").toLowerCase();
    const ext = EXT_BY_MIME[mime] ?? (/^[a-z0-9]{1,5}$/.test(fromPath) ? fromPath : "bin");
    return { buf, mime, ext };
  }

  /** Tên + ảnh đại diện của khách (lưu tạm 6 giờ). */
  private async profile(userId: string): Promise<{ name: string; avatar: string } | null> {
    const cached = this.profiles.get(userId);
    if (cached && Date.now() - cached.at < 6 * 3600_000) return cached;
    const fieldSets = this.kind === "instagram" ? ["name,username,profile_pic"] : ["name,profile_pic", "first_name,last_name,profile_pic"];
    for (const fields of fieldSets) {
      try {
        const j = obj(await this.graph(`/${userId}`, { query: { fields }, timeoutMs: 6_000 }));
        const name = str(j.name) || [str(j.last_name), str(j.first_name)].filter(Boolean).join(" ") || (str(j.username) ? `@${str(j.username)}` : "");
        const p = { name, avatar: str(j.profile_pic), at: Date.now() };
        this.profiles.set(userId, p);
        if (this.profiles.size > 5000) this.profiles.delete(this.profiles.keys().next().value!);
        if (name) this.deps.onPeerProfile?.({ threadId: userId, name, ...(p.avatar ? { avatar: p.avatar } : {}) });
        return p;
      } catch {
        // thử bộ trường khác / bỏ qua
      }
    }
    this.profiles.set(userId, { name: cached?.name ?? "", avatar: cached?.avatar ?? "", at: Date.now() - 5 * 3600_000 });
    return cached ?? null;
  }

  // ----- gửi -----

  /** Runtime gửi chủ động (lịch hẹn, quy trình, pairing…). */
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.text.trim()) await this.sendTextLogged(msg.chatKey, msg.text, "agent");
    if (msg.media?.length) await this.sendFilesLogged(msg.chatKey, msg.media, "agent");
  }

  /** Inbox (nhân viên), REST… */
  async sendManual(input: {
    threadId: string;
    peerKind: "direct" | "group";
    text?: string;
    filePaths?: string[];
    source: InboxSendSource;
    webUserId?: string;
    threadName?: string;
  }): Promise<string[]> {
    if (!this.isConnected()) {
      throw Object.assign(new Error(this.authError ?? "Kênh chưa kết nối"), { code: "NOT_CONNECTED" });
    }
    const ids: string[] = [];
    if (input.filePaths?.length) ids.push(...(await this.sendFilesLogged(input.threadId, input.filePaths, input.source, input.webUserId)));
    if (input.text?.trim()) ids.push(...(await this.sendTextLogged(input.threadId, input.text, input.source, input.webUserId)));
    return ids;
  }

  private async sendTextLogged(threadId: string, text: string, source: InboxSendSource, webUserId?: string): Promise<string[]> {
    // Messenger/Instagram không hiển thị Markdown
    const plain = source === "agent" ? stripToPlain(text) : text;
    const max = this.kind === "instagram" ? IG_TEXT_MAX : FB_TEXT_MAX;
    const ids: string[] = [];
    for (const chunk of chunkMetaText(plain, max)) {
      const mid = await this.sendMessage(threadId, { text: chunk }, source);
      ids.push(mid);
      this.logOut(threadId, mid, source, webUserId, { contentType: "text", text: chunk });
    }
    return ids;
  }

  private async sendFilesLogged(threadId: string, paths: string[], source: InboxSendSource, webUserId?: string): Promise<string[]> {
    const ids: string[] = [];
    let index = 0;
    for (const path of paths) {
      const type = metaAttachmentType(path);
      const name = basename(path);
      const album = paths.length > 1 ? { albumSize: paths.length, albumIndex: index } : {};
      index++;
      const size = await stat(path).then((s) => s.size).catch(() => -1);
      if (size < 0) throw new Error(`Không tìm thấy file ${name}`);
      if (size > DOWNLOAD_MAX) {
        const note = `(File ${name} vượt 25 MB — không gửi qua ${this.kind === "instagram" ? "Instagram" : "Messenger"} được)`;
        const mid = await this.sendMessage(threadId, { text: note }, source);
        ids.push(mid);
        this.logOut(threadId, mid, source, webUserId, { contentType: "text", text: note });
        continue;
      }
      let mid: string;
      if (this.kind === "instagram") {
        // Instagram nhận đính kèm bằng URL công khai; tài liệu (PDF…) gửi dạng link
        const url = this.deps.publishFile ? await this.deps.publishFile(path, name, 7 * 24 * 3600).catch(() => null) : null;
        if (!url) {
          const note = `(Không gửi được file ${name}: máy chủ thiếu PENAI_PUBLIC_URL)`;
          mid = await this.sendMessage(threadId, { text: note }, source);
          ids.push(mid);
          this.logOut(threadId, mid, source, webUserId, { contentType: "text", text: note });
          continue;
        }
        if (type === "file") {
          const text = `📎 ${name}: ${url}`;
          mid = await this.sendMessage(threadId, { text }, source);
          ids.push(mid);
          this.logOut(threadId, mid, source, webUserId, { contentType: "file", text: "", media: { name, localPath: path, size, ...album } });
          continue;
        }
        mid = await this.sendMessage(threadId, { attachment: { type, payload: { url } } }, source);
      } else {
        mid = await this.sendFile(threadId, path, type, source);
      }
      ids.push(mid);
      this.logOut(threadId, mid, source, webUserId, {
        contentType: type === "image" ? "photo" : type === "video" ? "video" : type === "audio" ? "voice" : "file",
        text: "",
        media: { name, localPath: path, size, ...album },
      });
    }
    return ids;
  }

  private logOut(
    threadId: string,
    mid: string,
    source: InboxSendSource,
    webUserId: string | undefined,
    content: Pick<ChannelMessageLog, "contentType" | "text" | "media">,
  ): void {
    const account = this.accountInfo();
    try {
      this.deps.onMessageLog?.({
        threadId,
        peerKind: "direct",
        msgId: mid,
        direction: "out",
        source,
        senderId: account?.id ?? "",
        senderName: account?.name ?? "",
        ...(webUserId ? { webUserId } : {}),
        ...content,
        sentAt: new Date(),
      });
    } catch (err) {
      logger.warn(`meta.inbox_log_fail: ${(err as Error).message}`);
    }
  }

  private markSent(mid: string): void {
    if (mid) this.remember(this.sent, mid);
  }

  /**
   * Gửi 1 tin (JSON). Nhân viên trả lời khi đã quá 24 giờ → thử lại bằng thẻ HUMAN_AGENT
   * (Meta cho người thật trả lời trong 7 ngày nếu app được cấp quyền Human Agent).
   */
  private async sendMessage(recipientId: string, message: Record<string, unknown>, source: InboxSendSource): Promise<string> {
    const body = (humanTag: boolean) => ({
      recipient: { id: recipientId },
      ...(humanTag ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }),
      message,
    });
    try {
      const j = obj(await this.graph(`/${this.cfg.pageId}/messages`, { method: "POST", json: body(false) }));
      const mid = str(j.message_id);
      this.markSent(mid);
      return mid;
    } catch (err) {
      if (source === "web" && err instanceof MetaGraphError && err.outsideWindow) {
        try {
          const j = obj(await this.graph(`/${this.cfg.pageId}/messages`, { method: "POST", json: body(true) }));
          const mid = str(j.message_id);
          this.markSent(mid);
          return mid;
        } catch (err2) {
          throw windowError(err2);
        }
      }
      throw windowError(err);
    }
  }

  /** Facebook: tải file thẳng từ máy chủ lên Messenger (multipart). */
  private async sendFile(recipientId: string, path: string, type: "image" | "video" | "audio" | "file", source: InboxSendSource): Promise<string> {
    const buf = await readFile(path);
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
    const form = (humanTag: boolean) => () => {
      const f = new FormData();
      f.append("recipient", JSON.stringify({ id: recipientId }));
      if (humanTag) {
        f.append("messaging_type", "MESSAGE_TAG");
        f.append("tag", "HUMAN_AGENT");
      } else f.append("messaging_type", "RESPONSE");
      f.append("message", JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
      f.append("filedata", new Blob([new Uint8Array(buf)], { type: mime }), basename(path));
      return f;
    };
    try {
      const j = obj(await this.graph(`/${this.cfg.pageId}/messages`, { method: "POST", form: form(false), timeoutMs: 120_000 }));
      const mid = str(j.message_id);
      this.markSent(mid);
      return mid;
    } catch (err) {
      if (source === "web" && err instanceof MetaGraphError && err.outsideWindow) {
        const j = obj(await this.graph(`/${this.cfg.pageId}/messages`, { method: "POST", form: form(true), timeoutMs: 120_000 }).catch((e: unknown) => { throw windowError(e); }));
        const mid = str(j.message_id);
        this.markSent(mid);
        return mid;
      }
      throw windowError(err);
    }
  }

  private async senderAction(recipientId: string, action: "mark_seen" | "typing_on" | "typing_off"): Promise<void> {
    await this.graph(`/${this.cfg.pageId}/messages`, { method: "POST", json: { recipient: { id: recipientId }, sender_action: action }, timeoutMs: 10_000 });
  }

  /** Gọi Graph API; lỗi 190 (token hết hạn/đổi) → xin token mới từ hub rồi thử lại 1 lần. */
  private async graph(path: string, init: GraphInit, retried = false): Promise<unknown> {
    const url = new URL(`${META_GRAPH_BASE}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    url.searchParams.set("access_token", this.creds.pageAccessToken);
    const headers: Record<string, string> = {};
    let body: FormData | string | undefined;
    if (init.form) body = init.form();
    else if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let j: Obj = {};
    try {
      j = obj(JSON.parse(text));
    } catch {
      // không phải JSON
    }
    if (res.ok && !j.error) return j;
    const e = obj(j.error);
    const code = Number(e.code) || undefined;
    const sub = Number(e.error_subcode) || undefined;
    if (!retried && (code === 190 || code === 102)) {
      if (await this.refreshToken()) return this.graph(path, init, true);
      this.authError = `Token Trang không còn hiệu lực (${str(e.message) || res.status}) — kết nối lại Trang trên hub.`;
    }
    throw new MetaGraphError(str(e.message) || `Graph API lỗi HTTP ${res.status}`, res.status, code, sub);
  }

  /** Xin Page Access Token mới nhất từ hub (bằng penai_secret). Tối đa 1 lần/phút. */
  private refreshToken(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastRefreshAt < 60_000 || !this.cfg.refreshEndpoint) return Promise.resolve(false);
    this.lastRefreshAt = Date.now();
    this.refreshing = (async () => {
      try {
        const res = await fetch(this.cfg.refreshEndpoint!, {
          method: "POST",
          headers: { "content-type": "application/json", "x-penai-secret": this.creds.penaiSecret },
          body: JSON.stringify({
            page_id: this.cfg.pageId,
            ...(this.cfg.igAccountId ? { ig_account_id: this.cfg.igAccountId } : {}),
            penai_secret: this.creds.penaiSecret,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = obj(await res.json().catch(() => ({})));
        const token = str(obj(j.data).page_access_token);
        if (!res.ok || j.success === false || !token) {
          logger.warn(`meta.token_refresh (${this.name}): hub trả ${res.status} ${str(j.message)}`);
          return false;
        }
        if (token === this.creds.pageAccessToken) return false;
        this.creds = { ...this.creds, pageAccessToken: token };
        this.authError = null;
        await this.deps.onSecretChanged?.(serializeMetaCredentials(this.creds));
        logger.info(`meta.token_refresh (${this.name}): đã nhận token mới từ hub`);
        return true;
      } catch (err) {
        logger.warn(`meta.token_refresh (${this.name}): ${(err as Error).message}`);
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

function windowError(err: unknown): unknown {
  if (err instanceof MetaGraphError && err.outsideWindow) {
    return new MetaGraphError(
      "Đã quá 24 giờ kể từ tin cuối của khách — Meta không cho Trang nhắn tiếp cho tới khi khách nhắn lại.",
      err.status,
      err.code,
      err.subcode,
    );
  }
  return err;
}

/** Nhãn + loại nội dung cho Inbox từ đính kèm đầu tiên. */
function describeAttachments(
  atts: MetaAttachment[],
): { contentType: ChannelMessageLog["contentType"]; media?: ChannelMessageLog["media"]; label: string } | null {
  const a = atts[0];
  if (!a) return null;
  const withUrl = a.url ? { url: a.url } : {};
  if (a.stickerId) return { contentType: "sticker", media: { ...withUrl }, label: "[Sticker]" };
  switch (a.type) {
    case "image":
      return { contentType: "photo", media: { ...withUrl }, label: "[Hình ảnh]" };
    case "video":
      return { contentType: "video", media: { ...withUrl }, label: "[Video]" };
    case "audio":
      return { contentType: "voice", media: { ...withUrl }, label: "[Tin nhắn thoại]" };
    case "file":
      return { contentType: "file", media: { ...withUrl, ...(a.title ? { name: a.title } : {}) }, label: "[Tệp]" };
    case "share":
    case "ig_reel":
    case "reel":
      return { contentType: "link", media: { ...withUrl }, label: a.type === "share" ? "bài viết/liên kết" : "reel" };
    case "story_mention":
      return { contentType: "link", media: { ...withUrl }, label: "story nhắc tới Trang" };
    case "fallback":
      return { contentType: "link", media: { ...withUrl }, label: a.title || "liên kết" };
    default:
      return { contentType: "other", label: `[${a.type}]` };
  }
}

// ===== Gọi hub =====

export interface HubRegisterResult {
  ok: boolean;
  /** 4xx của hub = mã/secret sai hoặc đã bị thu hồi */
  rejected: boolean;
  status: number;
  message: string;
  data: Record<string, unknown>;
}

/** Đăng ký (hoặc gỡ, webhookUrl rỗng) địa chỉ nhận tin của kênh trên hub. */
export async function registerHubWebhook(
  endpoint: string,
  input: { pageId: string; igAccountId?: string; penaiSecret: string; platform: MetaChannelKind; webhookUrl: string; expectedWebhookUrl?: string },
): Promise<HubRegisterResult> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-penai-secret": input.penaiSecret },
      body: JSON.stringify({
        page_id: input.pageId,
        ...(input.igAccountId ? { ig_account_id: input.igAccountId } : {}),
        penai_secret: input.penaiSecret,
        platform: input.platform,
        webhook_url: input.webhookUrl,
        ...(input.expectedWebhookUrl !== undefined ? { expected_webhook_url: input.expectedWebhookUrl } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = obj(await res.json().catch(() => ({})));
    const ok = res.ok && j.success !== false;
    return {
      ok,
      rejected: !ok && res.status >= 400 && res.status < 500,
      status: res.status,
      message: str(j.message) || (ok ? "OK" : `HTTP ${res.status}`),
      data: obj(j.data),
    };
  } catch (err) {
    return { ok: false, rejected: false, status: 0, message: `Không gọi được hub: ${(err as Error).message}`, data: {} };
  }
}
