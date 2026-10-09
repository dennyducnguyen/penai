import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { imageDimensionsFromData } from "image-dimensions";
import { logger } from "@penai/shared";
import {
  API,
  LoginQRCallbackEventType,
  ThreadType,
  Zalo,
  type Credentials,
  type LoginQRCallbackEvent,
  type Message,
} from "zca-js";
import { BoundedRunner } from "./bounded-runner.js";
import { stripToPlain } from "./format.js";
import type {
  Channel,
  ChannelContact,
  ChannelDeps,
  ChannelMessageLog,
  ChannelReaction,
  InboundMedia,
  OutboundMessage,
} from "./types.js";

const ZALO_MAX_TEXT = 2_000;
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const QR_MAX_EXPIRED_RETRIES = 3;
const QR_MAX_DECLINED_RETRIES = 2;

type QrState = "waiting" | "scanned" | "success" | "failed";

export interface ZaloPersonalAccount {
  id: string;
  name: string;
  avatar?: string;
  phone?: string;
}

export interface ZaloPersonalStatus {
  running: boolean;
  connected: boolean;
  listening: boolean;
  account: ZaloPersonalAccount | null;
  error: string | null;
  unofficialWarning: string;
  /** Chế độ an toàn LUÔN bật với zalo_personal: chỉ tương tác trong demo threads. */
  safeMode: true;
  demoThreads: string[];
  observedCount: number;
  /** Kênh tắt "yêu cầu pairing" → mọi tin nhắn RIÊNG (DM) được trả lời liền; nhóm vẫn phải chỉ định demo. */
  openDirect: boolean;
}

export interface ZaloPersonalQrStatus {
  id: string;
  status: QrState;
  qrDataUrl: string | null;
  scannedName: string | null;
  error: string | null;
  account: ZaloPersonalAccount | null;
}

export interface ZaloPersonalTarget {
  id: string;
  type: "direct" | "group";
  name: string;
  contactAlias?: string;
  avatar?: string;
  phone?: string;
  memberCount?: number;
}

/** Người/nhóm đã nhắn tới tài khoản — chỉ metadata, không lưu nội dung tin. */
export interface ZaloObservedPeer {
  chatKey: string;
  threadId: string;
  type: "direct" | "group";
  name: string;
  lastSenderId: string;
  lastSenderName: string;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  allowed: boolean;
}

const OBSERVED_MAX = 1_000;

/** Return only a complete list, so a failed page cannot erase saved aliases. */
export async function loadZaloContactAliases(api: Pick<API, "getAliasList">): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  for (let page = 1; page <= 1000; page++) {
    const result = await api.getAliasList(100, page);
    for (const item of result.items) aliases.set(String(item.userId), item.alias);
    if (result.items.length < 100) return aliases;
  }
  throw new Error("Danh sách tên danh bạ vượt giới hạn phân trang");
}

/** Chuẩn hóa chatKey allowlist: "group:<id>" | "direct:<id>"; id trần coi là direct. */
export function normalizeZaloChatKey(raw: string): string {
  const value = raw.trim();
  if (/^(group|direct):.+$/.test(value)) return value;
  return value ? `direct:${value}` : value;
}

/** Đọc danh sách thread demo từ config channel (an toàn với dữ liệu bẩn). */
export function parseZaloDemoThreads(config: Record<string, unknown>): string[] {
  const raw = config["demo_threads"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const key = normalizeZaloChatKey(item);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

interface QrAttempt {
  id: string;
  status: QrState;
  qrDataUrl: string | null;
  scannedName: string | null;
  error: string | null;
  createdAt: number;
  abort?: () => unknown;
}

interface ZaloContentObject {
  type?: unknown;
  href?: unknown;
  thumb?: unknown;
  title?: unknown;
  description?: unknown;
  /** JSON string (chat.file: fileExt, fileSize, checksum...; chat.photo: width/height...). */
  params?: unknown;
  action?: unknown;
}

/** Thông tin file rút từ `params` của tin Zalo (JSON string, có thể thiếu). */
interface ZaloAttachmentParams {
  fileExt?: string;
  fileSize?: number;
  title?: string;
}

export function parseZaloAttachmentParams(raw: unknown): ZaloAttachmentParams {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const out: ZaloAttachmentParams = {};
    if (typeof value.fileExt === "string" && value.fileExt.trim()) out.fileExt = value.fileExt.trim();
    const size = Number(value.fileSize);
    if (Number.isFinite(size) && size > 0) out.fileSize = size;
    if (typeof value.title === "string" && value.title.trim()) out.title = value.title.trim();
    return out;
  } catch {
    return {};
  }
}

/**
 * Phân loại media theo `msgType` của tin Zalo (chat.file, chat.photo, chat.voice,
 * chat.video.msg, chat.sticker, chat.gif...). `contentType` là `content.type`
 * (thường rỗng) dùng làm dự phòng.
 */
export function zaloMediaKind(
  msgType: string,
  contentType = "",
): "photo" | "document" | "voice" | "video" | "sticker" | "unknown" {
  const probe = `${msgType} ${contentType}`.toLowerCase();
  if (/sticker/.test(probe)) return "sticker";
  if (/voice|audio/.test(probe)) return "voice";
  if (/video/.test(probe)) return "video";
  if (/chat\.file|\bfile\b|doc/.test(probe)) return "document";
  if (/photo|image|gif|picture/.test(probe)) return "photo";
  return "unknown";
}

/** Credential ZCA nằm trong secret mã hóa của channel, không nằm trong config JSON. */
export function parseZaloPersonalCredentials(secret: string): Credentials | null {
  if (!secret.trim()) return null;
  try {
    const value = JSON.parse(secret) as Partial<Credentials>;
    if (
      typeof value.imei !== "string" ||
      !value.imei ||
      typeof value.userAgent !== "string" ||
      !value.userAgent ||
      value.cookie === undefined
    ) {
      return null;
    }
    return value as Credentials;
  } catch {
    return null;
  }
}

/** Zalo không render Markdown; chia ở biên 2.000 ký tự, ưu tiên xuống dòng/từ. */
export function chunkZaloText(input: string, max = ZALO_MAX_TEXT): string[] {
  const text = stripToPlain(input).trim();
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Group mặc định chỉ kích hoạt khi @mention tài khoản, reply tin của tài khoản, hoặc dùng lệnh. */
export function shouldHandleZaloGroup(
  data: Message["data"],
  accountId: string,
  requireMention: boolean,
): boolean {
  if (!requireMention) return true;
  const text = typeof data.content === "string" ? data.content.trim() : "";
  if (/^\/[a-z]/i.test(text)) return true;
  const mentions = "mentions" in data && Array.isArray(data.mentions) ? data.mentions : [];
  if (mentions.some((mention) => String(mention.uid) === accountId)) return true;
  return String(data.quote?.ownerId ?? "") === accountId;
}

function threadFromChatKey(chatKey: string): { id: string; type: ThreadType } {
  const [prefix, ...idParts] = chatKey.split(":");
  if ((prefix === "group" || prefix === "direct") && idParts.length) {
    return {
      id: idParts.join(":"),
      type: prefix === "group" ? ThreadType.Group : ThreadType.User,
    };
  }
  return { id: chatKey, type: ThreadType.User };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CDN Zalo tin cậy. File/ảnh trong chat nằm trên `*.zdn.vn` (vd f18-zpg.zdn.vn,
 * f47-photo.talk.zdn.vn); avatar/sticker trên `*.zadn.vn`. Chỉ tải qua https để
 * tránh SSRF từ tin "link" giả mạo.
 */
export function trustedZaloMediaUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const allowed = ["zalo.me", "zaloapp.com", "zadn.vn", "zdn.vn", "zalo.cloud"];
    if (!allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Chuẩn hóa nội dung 1 tin Zalo để lưu/hiển thị trong Inbox (không tải file:
 * chỉ giữ link CDN Zalo). Hàm thuần — test được.
 */
export function describeZaloContent(
  content: unknown,
  msgType = "",
): Pick<ChannelMessageLog, "contentType" | "text" | "media"> {
  if (typeof content === "string") return { contentType: "text", text: content };
  if (!content || typeof content !== "object") return { contentType: "other", text: "" };
  const value = content as ZaloContentObject;
  const href = typeof value.href === "string" ? value.href : "";
  const thumb = typeof value.thumb === "string" ? value.thumb : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const params = parseZaloAttachmentParams(value.params);
  const safe = (raw: string) => (raw && trustedZaloMediaUrl(raw) ? raw : "");
  const probe = msgType.toLowerCase();
  if (/link|recommend|webcontent/.test(probe) && href && !/zdn|zadn|zalo/.test(href)) {
    let url = "";
    try {
      const u = new URL(href);
      if (u.protocol === "https:" || u.protocol === "http:") url = u.href;
    } catch {
      /* link hỏng → chỉ giữ chữ */
    }
    return {
      contentType: "link",
      text: [title, description, url].filter(Boolean).join("\n"),
      ...(url ? { media: { url } } : {}),
    };
  }
  const kind = zaloMediaKind(msgType, typeof value.type === "string" ? value.type : "");
  if (kind === "photo") {
    const url = safe(href) || safe(thumb);
    return {
      contentType: "photo",
      text: title,
      media: { ...(url ? { url } : {}), ...(safe(thumb) ? { thumb: safe(thumb) } : {}) },
    };
  }
  if (kind === "document") {
    let name = title || params.title || "tep-zalo";
    if (params.fileExt && !name.toLowerCase().endsWith(`.${params.fileExt.toLowerCase()}`)) {
      name = `${name}.${params.fileExt}`;
    }
    return {
      contentType: "file",
      text: "",
      media: { name, ...(safe(href) ? { url: safe(href) } : {}), ...(params.fileSize ? { size: params.fileSize } : {}) },
    };
  }
  if (kind === "sticker") {
    return { contentType: "sticker", text: "", ...(safe(thumb) || safe(href) ? { media: { url: safe(thumb) || safe(href) } } : {}) };
  }
  if (kind === "voice" || kind === "video") {
    return { contentType: kind, text: "", ...(safe(href) ? { media: { url: safe(href) } } : {}) };
  }
  return { contentType: "other", text: title || description };
}

/** msgId của mọi phần (text + từng file) trong kết quả sendMessage của zca-js. */
function sentMessageIds(result: unknown): string[] {
  const r = result as { message?: { msgId?: unknown } | null; attachment?: Array<{ msgId?: unknown }> } | null;
  const ids: string[] = [];
  if (r?.message?.msgId != null) ids.push(String(r.message.msgId));
  for (const a of r?.attachment ?? []) if (a?.msgId != null) ids.push(String(a.msgId));
  return ids;
}

export type ZaloSendSource = "agent" | "web" | "mcp" | "api";

/** Cảm xúc hỗ trợ (tên dễ dùng → mã icon Zalo). "none" = gỡ cảm xúc. */
export const ZALO_REACTIONS = {
  heart: "/-heart",
  like: "/-strong",
  haha: ":>",
  wow: ":o",
  cry: ":-((",
  angry: ":-h",
  none: "",
} as const;
export type ZaloReactionKey = keyof typeof ZALO_REACTIONS;

export function isZaloReactionKey(v: unknown): v is ZaloReactionKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ZALO_REACTIONS, v);
}

/** Tự thả cảm xúc khi khách nhắn: config.auto_reaction = "heart" | "like" (khác → tắt). */
export function parseAutoReaction(config: Record<string, unknown>): "heart" | "like" | null {
  const v = config["auto_reaction"];
  return v === "heart" || v === "like" ? v : null;
}

export class ZaloNotConnectedError extends Error {
  readonly code = "NOT_CONNECTED";
  constructor(message = "Zalo Personal chưa đăng nhập — vào Channels → Kết nối QR để quét lại.") {
    super(message);
  }
}

async function imageMetadataGetter(filePath: string) {
  const data = await readFile(filePath);
  const metadata = imageDimensionsFromData(data);
  if (!metadata) return null;
  return { width: metadata.width, height: metadata.height, size: data.length };
}

/**
 * Zalo Personal qua zca-js (unofficial): QR login + restore credential, DM/group,
 * pairing dùng chung runtime PenAI, typing, text và file/ảnh outbound.
 *
 * CHẾ ĐỘ AN TOÀN (luôn bật): tài khoản có thể là Zalo cá nhân đang dùng thật,
 * nên mặc định channel CHỈ QUAN SÁT — ghi nhận ai/nhóm nào nhắn tới (tên, id),
 * không chạy agent, không gửi bất kỳ tin nào. Chỉ những thread được admin chỉ
 * định trong `config.demo_threads` (vd "group:123") mới được nhận/gửi tin.
 */
export class ZaloPersonalChannel implements Channel {
  readonly kind = "zalo_personal";
  readonly id: string;
  readonly name: string;

  private api: API | null = null;
  private running = false;
  private listening = false;
  private credentials: Credentials | null;
  private account: ZaloPersonalAccount | null = null;
  private lastError: string | null = null;
  private requireMention: boolean;
  private qrAttempts = new Map<string, QrAttempt>();
  private currentQrId: string | null = null;
  private seenMessageIds = new Set<string>();
  private runner: BoundedRunner;
  private demoThreadSet: Set<string>;
  private observed = new Map<string, ZaloObservedPeer>();
  private groupNames = new Map<string, string>();
  /** Kênh tắt "yêu cầu pairing" → DM mở cho mọi người; nhóm vẫn gate theo demo threads. */
  private openDirect: boolean;
  /**
   * msgId của tin do PenAI gửi (agent/web/MCP) — tin này dội lại qua listener
   * (isSelf) thì bỏ qua vì đã ghi Inbox lúc gửi. Dội lại có thể tới TRƯỚC khi
   * sendMessage() trả kết quả → listener chờ ngắn rồi kiểm tra lại.
   */
  private sentMsgIds = new Set<string>();
  private contactSync: Promise<{ friends: number; groups: number }> | null = null;
  /** Tự thả cảm xúc khi khách nhắn (null = tắt). Cập nhật nóng qua setAutoReaction. */
  private autoReaction: "heart" | "like" | null;
  /** Hẹn giờ tự thả theo hội thoại — khách nhắn dồn thì chỉ thả tin cuối. */
  private autoReactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Hàng đợi thả cảm xúc toàn kênh: tối đa ~1 lần/giây (tránh bị Zalo coi là spam). */
  private reactChain: Promise<unknown> = Promise.resolve();
  private lastReactAt = 0;
  private pendingThreadName = "";

  constructor(private deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.credentials = parseZaloPersonalCredentials(deps.token);
    this.requireMention = deps.config["require_mention"] === true;
    this.demoThreadSet = new Set(parseZaloDemoThreads(deps.config));
    this.openDirect = deps.requirePairing === false;
    this.autoReaction = parseAutoReaction(deps.config);
    this.runner = new BoundedRunner(20, (error) => deps.onError?.(error));
  }

  /**
   * Thread được phép hội thoại: nằm trong demo threads, hoặc là DM khi kênh đã
   * tắt "yêu cầu pairing" (chủ kênh chủ động mở cho mọi khách nhắn riêng —
   * toggle trong Channels; nhóm KHÔNG mở tự do để bot không tự trả lời trong
   * mọi nhóm tài khoản đang tham gia).
   */
  private isThreadEnabled(chatKey: string): boolean {
    if (this.demoThreadSet.has(chatKey)) return true;
    return this.openDirect && chatKey.startsWith("direct:");
  }

  private newZalo(): Zalo {
    return new Zalo({
      logging: false,
      selfListen: true,
      imageMetadataGetter,
    });
  }

  async start(): Promise<void> {
    this.running = true;
    this.lastError = null;
    logger.warn(
      "security.unofficial_api: Zalo Personal dùng API không chính thức; tài khoản có thể bị khóa. Chỉ dùng tài khoản dành riêng cho bot.",
    );
    if (!this.credentials) return;
    try {
      const api = await this.newZalo().login(this.credentials);
      await this.activate(api);
    } catch (error) {
      this.lastError = `Không khôi phục được phiên Zalo: ${errorMessage(error)}. Hãy quét QR lại.`;
      this.deps.onError?.(new Error(this.lastError));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.autoReactTimers.values()) clearTimeout(t);
    this.autoReactTimers.clear();
    for (const attempt of this.qrAttempts.values()) attempt.abort?.();
    this.currentQrId = null;
    this.stopListener();
    this.api = null;
    await this.runner.drain(10_000);
  }

  isRunning(): boolean {
    return this.running;
  }

  status(): ZaloPersonalStatus {
    return {
      running: this.running,
      connected: this.api !== null,
      listening: this.listening,
      account: this.account,
      error: this.lastError,
      unofficialWarning:
        "Zalo Personal dùng zca-js/API không chính thức; tài khoản có thể bị Zalo giới hạn hoặc khóa.",
      safeMode: true,
      demoThreads: this.demoThreads(),
      observedCount: this.observed.size,
      openDirect: this.openDirect,
    };
  }

  /** Danh sách thread demo hiện tại (chatKey đã chuẩn hóa). */
  demoThreads(): string[] {
    return [...this.demoThreadSet].sort();
  }

  /** Cập nhật nóng danh sách thread demo — không cần restart/đăng nhập lại. */
  setDemoThreads(threads: string[]): void {
    this.demoThreadSet = new Set(
      threads.map(normalizeZaloChatKey).filter((key) => /^(group|direct):.+$/.test(key)),
    );
    for (const peer of this.observed.values()) {
      peer.allowed = this.isThreadEnabled(peer.chatKey);
    }
    logger.info(
      `zalo.safe_mode: channel "${this.name}" demo threads = [${this.demoThreads().join(", ") || "trống — chỉ quan sát"}]` +
        (this.openDirect ? " + MỞ mọi DM (đã tắt yêu cầu pairing)" : ""),
    );
  }

  /** Người/nhóm đã nhắn tới, mới nhất trước — cho admin chọn nhóm demo. */
  listObserved(): ZaloObservedPeer[] {
    return [...this.observed.values()].sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt),
    );
  }

  async startQrLogin(): Promise<{ id: string }> {
    if (!this.running) throw new Error("Channel đang tạm dừng; hãy bật channel trước.");
    if (this.api) throw new Error("Zalo Personal đã kết nối. Hãy ngắt kết nối trước khi quét QR lại.");
    if (this.currentQrId) {
      const current = this.qrAttempts.get(this.currentQrId);
      if (current && (current.status === "waiting" || current.status === "scanned")) {
        return { id: current.id };
      }
    }

    const id = randomUUID();
    const attempt: QrAttempt = {
      id,
      status: "waiting",
      qrDataUrl: null,
      scannedName: null,
      error: null,
      createdAt: Date.now(),
    };
    this.qrAttempts.set(id, attempt);
    this.currentQrId = id;
    void this.runQrLogin(attempt);
    return { id };
  }

  qrStatus(id: string): ZaloPersonalQrStatus | null {
    const attempt = this.qrAttempts.get(id);
    if (!attempt) return null;
    return {
      id: attempt.id,
      status: attempt.status,
      qrDataUrl: attempt.qrDataUrl,
      scannedName: attempt.scannedName,
      error: attempt.error,
      account: attempt.status === "success" ? this.account : null,
    };
  }

  async logout(): Promise<void> {
    for (const attempt of this.qrAttempts.values()) attempt.abort?.();
    this.currentQrId = null;
    this.stopListener();
    this.api = null;
    this.account = null;
    this.credentials = null;
    this.lastError = null;
    await this.deps.onSecretChanged?.("{}");
  }

  /** Danh bạ tối giản cho admin chọn đúng người/nhóm khi kiểm tra kênh. */
  async listTargets(): Promise<ZaloPersonalTarget[]> {
    if (!this.api) throw new Error("Zalo Personal chưa đăng nhập");
    const targets: ZaloPersonalTarget[] = [];
    const friends = await this.api.getAllFriends();
    let aliases: Map<string, string> | undefined;
    try {
      aliases = await loadZaloContactAliases(this.api);
    } catch {
      logger.warn("zalo.alias_sync_failed: giữ tên danh bạ đã lưu");
    }
    for (const friend of friends) {
      if (!friend.userId) continue;
      targets.push({
        id: String(friend.userId),
        type: "direct",
        name: friend.zaloName || friend.displayName || String(friend.userId),
        ...(aliases ? { contactAlias: aliases.get(String(friend.userId)) ?? "" } : {}),
        ...(friend.avatar ? { avatar: friend.avatar } : {}),
        ...(friend.phoneNumber ? { phone: friend.phoneNumber } : {}),
      });
    }

    const groups = await this.api.getAllGroups();
    const groupIds = Object.keys(groups.gridVerMap ?? {});
    for (let i = 0; i < groupIds.length; i += 10) {
      const batch = groupIds.slice(i, i + 10);
      const detail = await this.api.getGroupInfo(batch);
      for (const id of batch) {
        const group = detail.gridInfoMap[id];
        if (group?.name) this.groupNames.set(id, group.name);
        targets.push({
          id,
          type: "group",
          name: group?.name || id,
          ...(group?.avt ? { avatar: group.avt } : {}),
          ...(group?.totalMember !== undefined ? { memberCount: group.totalMember } : {}),
        });
      }
    }
    return targets.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }

  /** Đã đăng nhập Zalo và sẵn sàng gửi. */
  isConnected(): boolean {
    return this.api !== null;
  }

  accountInfo(): ZaloPersonalAccount | null {
    return this.account;
  }

  /**
   * Đồng bộ danh bạ (bạn bè + nhóm) rồi báo server lưu DB (onContactsSynced).
   * Gọi trùng khi đang chạy → dùng chung lượt đang chạy.
   */
  syncContacts(): Promise<{ friends: number; groups: number }> {
    if (!this.api) return Promise.reject(new ZaloNotConnectedError());
    if (this.contactSync) return this.contactSync;
    this.contactSync = (async () => {
      try {
        const targets = await this.listTargets();
        const items: ChannelContact[] = targets.map((t) => ({
          id: t.id,
          type: t.type,
          name: t.name,
          ...(t.contactAlias !== undefined ? { contactAlias: t.contactAlias } : {}),
          ...(t.avatar ? { avatar: t.avatar } : {}),
          ...(t.phone ? { phone: t.phone } : {}),
          ...(t.memberCount !== undefined ? { memberCount: t.memberCount } : {}),
        }));
        this.deps.onContactsSynced?.(items);
        const groups = items.filter((i) => i.type === "group").length;
        logger.info(`zalo.contacts_synced: channel "${this.name}" ${items.length - groups} bạn bè, ${groups} nhóm`);
        return { friends: items.length - groups, groups };
      } finally {
        this.contactSync = null;
      }
    })();
    return this.contactSync;
  }

  /** Tra người dùng Zalo theo SĐT; không tìm thấy (hoặc chặn tìm kiếm) → null. */
  async findUserByPhone(phone: string): Promise<{ uid: string; name: string; avatar: string } | null> {
    if (!this.api) throw new ZaloNotConnectedError();
    try {
      const user = await this.api.findUser(phone);
      if (!user?.uid) return null;
      return {
        uid: String(user.uid),
        name: user.display_name || user.zalo_name || String(user.uid),
        avatar: user.avatar || "",
      };
    } catch (error) {
      const msg = errorMessage(error).toLowerCase();
      if (/not found|không tìm|khong tim|216|-?1\b/.test(msg)) return null;
      throw error;
    }
  }

  /**
   * Gửi có chủ đích từ người trực (Inbox web), ứng dụng AI qua MCP, hoặc REST —
   * KHÔNG qua cổng "thread demo" (cổng đó chỉ dành cho agent tự trả lời).
   * Trả msgId của các tin đã gửi.
   */
  async sendManual(input: {
    threadId: string;
    peerKind: "direct" | "group";
    text?: string;
    filePaths?: string[];
    source: ZaloSendSource;
    webUserId?: string;
    /** Tên người/nhóm nhận (nếu biết) — để hội thoại mới trong Inbox có tên. */
    threadName?: string;
  }): Promise<string[]> {
    if (!this.api) throw new ZaloNotConnectedError();
    const type = input.peerKind === "group" ? ThreadType.Group : ThreadType.User;
    const ids: string[] = [];
    this.pendingThreadName = input.threadName ?? "";
    try {
      if (input.text?.trim()) {
        ids.push(...(await this.sendText(input.threadId, type, input.text, input.source, input.webUserId)));
      }
      if (input.filePaths?.length) {
        ids.push(
          ...(await this.sendFiles(input.threadId, type, input.filePaths, input.source, input.webUserId, true)),
        );
      }
    } finally {
      this.pendingThreadName = "";
    }
    return ids;
  }

  setAutoReaction(v: "heart" | "like" | null): void {
    this.autoReaction = v;
    if (!v) {
      for (const t of this.autoReactTimers.values()) clearTimeout(t);
      this.autoReactTimers.clear();
    }
  }

  getAutoReaction(): "heart" | "like" | null {
    return this.autoReaction;
  }

  /**
   * Thả (hoặc gỡ, reaction = "none") cảm xúc vào 1 tin. Chạy qua hàng đợi toàn
   * kênh ~1 lần/giây. Thành công → báo onReaction để Inbox lưu + hiện ngay.
   */
  async react(input: {
    threadId: string;
    peerKind: "direct" | "group";
    msgId: string;
    cliMsgId: string;
    reaction: ZaloReactionKey;
    source: "web" | "auto" | "mcp";
    webUserId?: string;
  }): Promise<void> {
    if (!this.api) throw new ZaloNotConnectedError();
    if (!input.msgId || !input.cliMsgId) throw new Error("Tin này thiếu mã để thả cảm xúc (tin lưu trước bản 1.5.0)");
    const run = async () => {
      const wait = this.lastReactAt + 1_000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastReactAt = Date.now();
      if (!this.api) throw new ZaloNotConnectedError();
      await this.api.addReaction(ZALO_REACTIONS[input.reaction] as never, {
        data: { msgId: input.msgId, cliMsgId: input.cliMsgId },
        threadId: input.threadId,
        type: input.peerKind === "group" ? ThreadType.Group : ThreadType.User,
      });
    };
    const job = this.reactChain.then(run, run);
    this.reactChain = job.catch(() => {});
    await job;
    this.deps.onReaction?.({
      threadId: input.threadId,
      peerKind: input.peerKind,
      targetMsgId: input.msgId,
      reactorId: this.account?.id ?? "",
      reactorName: this.account?.name ?? "",
      icon: ZALO_REACTIONS[input.reaction],
      source: input.source,
      ...(input.webUserId ? { webUserId: input.webUserId } : {}),
      at: new Date(),
    });
  }

  /** Khách nhắn (cá nhân + nhóm) → sau 1–4 giây thả cảm xúc vào tin CUỐI của đợt nhắn. */
  private scheduleAutoReaction(message: Message, peerKind: "direct" | "group", threadId: string): void {
    const icon = this.autoReaction;
    if (!icon || !this.api) return;
    const msgId = String(message.data.msgId ?? "");
    const cliMsgId = String((message.data as { cliMsgId?: unknown }).cliMsgId ?? "");
    if (!msgId || !cliMsgId) return;
    const key = `${peerKind}:${threadId}`;
    const prev = this.autoReactTimers.get(key);
    if (prev) clearTimeout(prev);
    const delay = 1_000 + Math.floor(Math.random() * 3_000);
    const timer = setTimeout(() => {
      this.autoReactTimers.delete(key);
      if (this.autoReaction !== icon) return;
      void this.react({ threadId, peerKind, msgId, cliMsgId, reaction: icon, source: "auto" }).catch((error) =>
        logger.warn(`zalo.auto_reaction_fail: ${peerKind} ${threadId} — ${errorMessage(error)}`),
      );
    }, delay);
    timer.unref?.();
    this.autoReactTimers.set(key, timer);
  }

  /** Tên nhóm (cache; tra Zalo nếu chưa có). Lỗi → "". */
  async lookupGroupName(threadId: string): Promise<string> {
    const cached = this.groupNames.get(threadId);
    if (cached) return cached;
    if (!this.api) return "";
    try {
      const detail = await this.api.getGroupInfo([threadId]);
      const name = detail.gridInfoMap[threadId]?.name ?? "";
      if (name) this.groupNames.set(threadId, name);
      return name;
    } catch {
      return "";
    }
  }

  /** Tìm UID Zalo theo số điện thoại (cho admin thêm thread demo/gửi tin test). */
  async resolvePhone(phone: string): Promise<{ uid: string; name: string }> {
    if (!this.api) throw new Error("Zalo Personal chưa đăng nhập");
    const user = await this.api.findUser(phone);
    if (!user?.uid) throw new Error(`Không tìm thấy tài khoản Zalo với số ${phone}`);
    return {
      uid: String(user.uid),
      name: user.display_name || user.zalo_name || String(user.uid),
    };
  }

  /** Gửi tin kiểm tra có chủ đích từ admin — vẫn bị chặn ngoài thread demo. */
  async sendTestMessage(
    threadId: string,
    peerKind: "direct" | "group",
    text: string,
  ): Promise<void> {
    this.assertThreadAllowed(`${peerKind}:${threadId}`);
    await this.sendText(
      threadId,
      peerKind === "group" ? ThreadType.Group : ThreadType.User,
      text,
    );
  }

  private async runQrLogin(attempt: QrAttempt): Promise<void> {
    let credentials: Credentials | null = null;
    let expired = 0;
    let declined = 0;
    try {
      const api = await this.newZalo().loginQR({}, (event: LoginQRCallbackEvent) => {
        if (!this.running) {
          event.actions?.abort();
          return;
        }
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            attempt.status = "waiting";
            attempt.qrDataUrl = `data:image/png;base64,${event.data.image}`;
            attempt.abort = event.actions.abort;
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            expired++;
            if (expired > QR_MAX_EXPIRED_RETRIES) {
              attempt.status = "failed";
              attempt.error = "Mã QR hết hạn nhiều lần. Hãy tạo mã mới.";
              event.actions.abort();
            } else {
              attempt.status = "waiting";
              attempt.qrDataUrl = null;
              event.actions.retry();
            }
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            attempt.status = "scanned";
            attempt.scannedName = event.data.display_name;
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            declined++;
            if (declined > QR_MAX_DECLINED_RETRIES) {
              attempt.status = "failed";
              attempt.error = "Đăng nhập bị từ chối nhiều lần. Hãy tạo mã mới.";
              event.actions.abort();
            } else {
              attempt.status = "waiting";
              attempt.qrDataUrl = null;
              event.actions.retry();
            }
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            credentials = event.data;
            break;
        }
      });

      if (!this.running) {
        api.listener.stop();
        return;
      }
      if (!credentials) throw new Error("ZCA không trả credentials để lưu phiên đăng nhập");
      await this.deps.onSecretChanged?.(JSON.stringify(credentials));
      this.credentials = credentials;
      await this.activate(api);
      attempt.status = "success";
      attempt.qrDataUrl = null;
      attempt.error = null;
      this.lastError = null;
    } catch (error) {
      if (!this.running) {
        attempt.status = "failed";
        attempt.error = "Phiên QR đã được hủy";
        return;
      }
      if (attempt.status !== "failed") {
        attempt.status = "failed";
        attempt.error = errorMessage(error);
      }
      this.lastError = `Đăng nhập Zalo thất bại: ${attempt.error}`;
      this.deps.onError?.(new Error(this.lastError));
    } finally {
      attempt.abort = undefined;
      if (this.currentQrId === attempt.id) this.currentQrId = null;
      setTimeout(() => this.qrAttempts.delete(attempt.id), 10 * 60_000).unref();
    }
  }

  private async activate(api: API): Promise<void> {
    const info = await api.fetchAccountInfo();
    const profile = info.profile;
    this.stopListener();
    this.api = api;
    this.account = {
      id: String(profile.userId),
      name: profile.displayName || profile.zaloName || String(profile.userId),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      ...(profile.phoneNumber ? { phone: profile.phoneNumber } : {}),
    };
    this.lastError = null;
    this.attachListener(api);
    // Inbox: kéo danh bạ (bạn bè + nhóm) về DB một lần sau mỗi lần đăng nhập/khôi phục phiên.
    if (this.deps.onContactsSynced) {
      setTimeout(() => {
        if (this.api !== api) return;
        this.syncContacts().catch((error) =>
          logger.warn(`zalo.contacts_sync_fail: ${errorMessage(error)}`),
        );
      }, 5_000).unref?.();
    }
  }

  private attachListener(api: API): void {
    api.listener.on("message", (message) => {
      this.runner.run(() => this.handleMessage(message));
    });
    api.listener.on("reaction", (reaction) => {
      try {
        const data = reaction.data;
        const target = data.content?.rMsg?.[0];
        if (!target?.gMsgID) return;
        this.deps.onReaction?.({
          threadId: String(reaction.threadId),
          peerKind: reaction.isGroup ? "group" : "direct",
          targetMsgId: String(target.gMsgID),
          reactorId: reaction.isSelf ? (this.account?.id ?? String(data.uidFrom)) : String(data.uidFrom),
          reactorName: reaction.isSelf ? (this.account?.name ?? "") : (data.dName ?? ""),
          icon: String(data.content.rIcon ?? ""),
          source: reaction.isSelf ? "app" : "zalo",
          at: Number(data.ts) > 0 ? new Date(Number(data.ts)) : new Date(),
        });
      } catch (error) {
        logger.warn(`zalo.reaction_event_fail: ${errorMessage(error)}`);
      }
    });
    api.listener.on("connected", () => {
      this.listening = true;
      this.lastError = null;
    });
    api.listener.on("error", (error) => {
      this.lastError = `Listener Zalo lỗi: ${errorMessage(error)}`;
      this.deps.onError?.(new Error(this.lastError));
    });
    api.listener.on("closed", (_code, reason) => {
      this.listening = false;
      if (reason) this.lastError = `Listener Zalo đã đóng: ${reason}`;
    });
    api.listener.start({ retryOnClose: true });
    this.listening = true;
  }

  private stopListener(): void {
    if (this.api && this.listening) {
      try {
        this.api.listener.stop();
      } catch {
        // Listener đã đóng thì không cần làm thêm.
      }
    }
    this.listening = false;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!this.api) return;
    const msgId = String(message.data.msgId ?? "");
    if (msgId && this.seenMessageIds.has(msgId)) return;
    if (msgId) {
      this.seenMessageIds.add(msgId);
      setTimeout(() => this.seenMessageIds.delete(msgId), 5 * 60_000).unref();
    }

    const peerKind = message.type === ThreadType.Group ? "group" : "direct";
    const threadId = String(message.threadId);
    const chatKey = `${peerKind}:${threadId}`;
    const senderId = String(message.data.uidFrom || message.threadId);
    const senderName =
      message.data.dName || (message.isSelf ? (this.account?.name ?? senderId) : senderId);

    // Inbox: ghi MỌI tin (kể cả thread chưa cho agent trả lời). Tin do PenAI
    // tự gửi (agent/web/MCP) đã ghi lúc gửi → bỏ qua bản dội lại.
    await this.logListenerMessage(message, peerKind, threadId, senderId, senderName);
    if (!message.isSelf) this.scheduleAutoReaction(message, peerKind, threadId);

    // Chế độ an toàn: LUÔN ghi nhận ai/nhóm nào nhắn tới (metadata, không lưu
    // nội dung), rồi im lặng bỏ qua mọi thread chưa được chỉ định làm demo —
    // không typing, không chạy agent, không trả lời.
    // Tin do CHÍNH tài khoản gửi trong group cũng được ghi nhận — đây là cách
    // tự nhiên nhất để chủ tài khoản đăng ký nhóm demo (nhắn 1 tin rồi vào
    // dashboard bấm «Chỉ định demo»). DM tự gửi thì bỏ qua để không ghi nhầm
    // thread người nhận dưới tên người gửi.
    if (peerKind === "group" || !message.isSelf) {
      this.recordObservation(chatKey, threadId, peerKind, senderId, senderName);
    }
    if (message.isSelf) return;
    if (!this.isThreadEnabled(chatKey)) return;

    // Trong thread demo, KHÔNG chặn theo mention ở adapter nữa: runtime cần
    // thấy mọi tin (bộ điều phối quy trình đọc phản hồi trong nhóm). Cờ
    // `mentioned` cho biết tin có @mention/reply/lệnh nhắm vào bot; runtime
    // gate agent theo config require_mention.
    const mentioned =
      peerKind !== "group" ||
      shouldHandleZaloGroup(message.data, this.account?.id ?? "", true);

    const text = typeof message.data.content === "string" ? message.data.content : "";
    const media = await this.collectMedia(
      message.data.content,
      String(message.data.msgType ?? ""),
    );
    if (!text.trim() && media.length === 0) return;
    const threadType = message.type;

    const hooks = {
      onStatus: (status: string) => {
        if (status === "queued" || status === "thinking") {
          void this.api?.sendTypingEvent(threadId, threadType).catch(() => {});
        }
      },
      onBlockReply: (blockText: string) => {
        void this.sendText(threadId, threadType, blockText).catch((error) =>
          this.deps.onError?.(error as Error),
        );
      },
    };

    try {
      const result = await this.deps.onInbound(
        {
          channelId: this.id,
          channelKind: this.kind,
          chatKey,
          senderId,
          senderName: message.data.dName || senderId,
          text,
          peerKind,
          mentioned,
          ...(media.length ? { media } : {}),
        },
        hooks,
      );
      if (result.kind === "pairing") {
        // Ngoại lệ Zalo cá nhân: người chưa duyệt pairing thì IM LẶNG — không
        // gửi mã pair (tài khoản thật không tự nhắn cho người lạ). Mã vẫn được
        // cấp trong DB, admin duyệt qua Dashboard → Channels như bình thường.
        logger.info(
          `zalo.pairing_silent: ${chatKey} chưa duyệt — đã cấp mã chờ admin, không nhắn lại`,
        );
      } else if (result.kind === "reply") {
        if (result.text.trim()) await this.sendText(threadId, threadType, result.text);
        if (result.media?.length) {
          await this.sendFiles(threadId, threadType, result.media);
        }
      }
    } catch (error) {
      this.deps.onError?.(error as Error);
      await this.sendText(
        threadId,
        threadType,
        "⚠️ Có lỗi khi xử lý tin nhắn. Vui lòng thử lại.",
      ).catch(() => {});
    }
  }

  private async logListenerMessage(
    message: Message,
    peerKind: "direct" | "group",
    threadId: string,
    senderId: string,
    senderName: string,
  ): Promise<void> {
    if (!this.deps.onMessageLog) return;
    const msgId = String(message.data.msgId ?? "");
    if (message.isSelf && msgId) {
      if (!this.sentMsgIds.has(msgId)) await new Promise((r) => setTimeout(r, 1_500));
      if (this.sentMsgIds.has(msgId)) {
        this.sentMsgIds.delete(msgId);
        // Tin đã ghi lúc gửi nhưng thiếu cliMsgId (kết quả gửi không có) → bổ sung để thả cảm xúc được.
        const cli = (message.data as { cliMsgId?: unknown }).cliMsgId;
        if (cli != null && String(cli) !== "") this.deps.onMessageCliId?.(msgId, String(cli));
        return;
      }
    }
    try {
      const described = describeZaloContent(message.data.content, String(message.data.msgType ?? ""));
      const meta: Record<string, unknown> = {};
      const data = message.data as unknown as {
        mentions?: Array<{ uid: unknown }>;
        quote?: { msg?: unknown; ownerId?: unknown };
      };
      if (data.quote) {
        meta.quote = {
          ownerId: String(data.quote.ownerId ?? ""),
          text: typeof data.quote.msg === "string" ? data.quote.msg.slice(0, 300) : "",
        };
      }
      if (Array.isArray(data.mentions) && data.mentions.length) {
        meta.mentions = data.mentions.map((m) => String(m.uid));
      }
      // Cần cả msgId + cliMsgId để thả cảm xúc vào tin này về sau
      const cli = (message.data as { cliMsgId?: unknown }).cliMsgId;
      if (cli != null && String(cli) !== "") meta.cliMsgId = String(cli);
      const ts = Number(message.data.ts);
      this.deps.onMessageLog({
        threadId,
        peerKind,
        msgId,
        direction: message.isSelf ? "out" : "in",
        source: message.isSelf ? "app" : "zalo",
        senderId: message.isSelf ? (this.account?.id ?? senderId) : senderId,
        senderName,
        ...described,
        ...(Object.keys(meta).length ? { meta } : {}),
        sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date(),
        threadName:
          peerKind === "group"
            ? (this.groupNames.get(threadId) ?? "")
            : message.isSelf
              ? ""
              : senderName,
      });
    } catch (error) {
      logger.warn(`zalo.inbox_log_fail: ${errorMessage(error)}`);
    }
  }

  /** Ghi tin PenAI vừa gửi vào Inbox + nhớ msgId để bỏ qua bản dội lại. */
  private logSent(
    ids: string[],
    threadId: string,
    type: ThreadType,
    source: ZaloSendSource,
    webUserId: string | undefined,
    content: Pick<ChannelMessageLog, "contentType" | "text" | "media">,
  ): void {
    for (const id of ids) {
      this.sentMsgIds.add(id);
      setTimeout(() => this.sentMsgIds.delete(id), 120_000).unref?.();
    }
    if (!this.deps.onMessageLog) return;
    try {
      this.deps.onMessageLog({
        threadId,
        peerKind: type === ThreadType.Group ? "group" : "direct",
        msgId: ids[0] ?? "",
        direction: "out",
        source,
        senderId: this.account?.id ?? "",
        senderName: this.account?.name ?? "",
        ...(webUserId ? { webUserId } : {}),
        ...content,
        sentAt: new Date(),
        ...(this.pendingThreadName ? { threadName: this.pendingThreadName } : {}),
      });
    } catch (error) {
      logger.warn(`zalo.inbox_log_fail: ${errorMessage(error)}`);
    }
  }

  /** Ghi nhận peer đã nhắn tới — chỉ metadata (tên/id/số tin), không lưu nội dung. */
  private recordObservation(
    chatKey: string,
    threadId: string,
    type: "direct" | "group",
    senderId: string,
    senderName: string,
  ): void {
    const now = new Date().toISOString();
    const notifyObserved = (name: string) =>
      this.deps.onObserved?.({
        chatKey,
        threadId,
        kind: type,
        name,
        lastSenderId: senderId,
        lastSenderName: senderName,
        countMessage: true,
      });
    const existing = this.observed.get(chatKey);
    if (existing) {
      existing.lastSenderId = senderId;
      existing.lastSenderName = senderName;
      existing.messageCount++;
      existing.lastSeenAt = now;
      if (type === "direct") existing.name = senderName;
      notifyObserved(existing.name);
      return;
    }
    if (this.observed.size >= OBSERVED_MAX) {
      let oldestKey: string | null = null;
      let oldestAt = "";
      for (const [key, peer] of this.observed) {
        if (!oldestKey || peer.lastSeenAt < oldestAt) {
          oldestKey = key;
          oldestAt = peer.lastSeenAt;
        }
      }
      if (oldestKey) this.observed.delete(oldestKey);
    }
    this.observed.set(chatKey, {
      chatKey,
      threadId,
      type,
      name: type === "direct" ? senderName : this.groupNames.get(threadId) || `Nhóm ${threadId}`,
      lastSenderId: senderId,
      lastSenderName: senderName,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      allowed: this.isThreadEnabled(chatKey),
    });
    notifyObserved(this.observed.get(chatKey)?.name ?? senderName);
    if (type === "group" && !this.groupNames.has(threadId)) {
      void this.resolveGroupName(threadId);
    }
    logger.info(
      `zalo.observe: ${type} ${threadId} — người gửi "${senderName}" (${senderId})`,
    );
  }

  /** Lấy tên nhóm 1 lần (cache) để danh sách quan sát dễ đọc; lỗi thì bỏ qua. */
  private async resolveGroupName(threadId: string): Promise<void> {
    if (!this.api) return;
    this.groupNames.set(threadId, ""); // marker: đang resolve, tránh gọi trùng
    try {
      const detail = await this.api.getGroupInfo([threadId]);
      const name = detail.gridInfoMap[threadId]?.name;
      if (name) {
        this.groupNames.set(threadId, name);
        this.deps.onThreadName?.(threadId, name);
        const peer = this.observed.get(`group:${threadId}`);
        if (peer) {
          peer.name = name;
          // Đồng bộ tên nhóm thật vào DB (không tăng message_count)
          this.deps.onObserved?.({
            chatKey: peer.chatKey,
            threadId,
            kind: "group",
            name,
            lastSenderId: peer.lastSenderId,
            lastSenderName: peer.lastSenderName,
            countMessage: false,
          });
        }
      } else {
        this.groupNames.delete(threadId);
      }
    } catch {
      this.groupNames.delete(threadId);
    }
  }

  /** Fail-closed: mọi outbound (kể cả test message) chỉ được vào thread demo — trừ DM khi kênh đã tắt pairing (openDirect). */
  private assertThreadAllowed(chatKey: string): void {
    const key = normalizeZaloChatKey(chatKey);
    if (!this.isThreadEnabled(key)) {
      throw new Error(
        `Chế độ an toàn Zalo: thread "${key}" chưa được chỉ định làm nhóm demo — tin nhắn bị chặn. ` +
          `Chỉ định trong Channels → Kết nối Zalo → Chế độ an toàn (hoặc tắt "yêu cầu pairing" để mở mọi DM).`,
      );
    }
  }

  private async collectMedia(
    content: Message["data"]["content"],
    msgType = "",
  ): Promise<InboundMedia[]> {
    if (!content || typeof content === "string") return [];
    const value = content as ZaloContentObject;
    const rawUrl =
      typeof value.href === "string" && value.href
        ? value.href
        : typeof value.thumb === "string"
          ? value.thumb
          : "";
    const url = trustedZaloMediaUrl(rawUrl);
    const contentType = typeof value.type === "string" ? value.type.toLowerCase() : "";
    const params = parseZaloAttachmentParams(value.params);
    const kind = zaloMediaKind(msgType, contentType);
    const label = msgType || contentType || "không rõ";

    let name =
      (typeof value.title === "string" && value.title.trim()) || params.title || "";
    if (!name) name = kind === "photo" ? "anh-zalo" : "tep-zalo";
    if (params.fileExt && !name.toLowerCase().endsWith(`.${params.fileExt.toLowerCase()}`)) {
      name = `${name}.${params.fileExt}`;
    }

    if (kind === "voice") {
      return [{ kind: "voice", note: "[Người dùng gửi tin nhắn thoại — hệ thống chưa hỗ trợ nghe]" }];
    }
    if (kind === "video") {
      return [{ kind: "video", note: "[Người dùng gửi video — hệ thống chưa hỗ trợ xem]" }];
    }
    if (kind === "sticker") {
      return [{ kind: "photo", note: "[Người dùng gửi sticker Zalo]" }];
    }

    if (!url) {
      let host = "";
      try {
        host = rawUrl ? new URL(rawUrl).hostname : "(không có link)";
      } catch {
        host = "(link không hợp lệ)";
      }
      logger.warn(
        `zalo.media_skip: msgType=${label} host=${host} title=${JSON.stringify(name)} — link không thuộc CDN Zalo tin cậy, bỏ qua`,
      );
      if (kind === "unknown" && !rawUrl) {
        return [{ kind: "document", name, note: `[Người dùng gửi nội dung Zalo loại ${label}]` }];
      }
      return [
        {
          kind: "document",
          name,
          note: `[Người dùng gửi ${kind === "photo" ? "ảnh" : `file "${name}"`} qua Zalo nhưng hệ thống không tải được (nguồn ${host} chưa được tin cậy)]`,
        },
      ];
    }

    if (params.fileSize && params.fileSize > MEDIA_MAX_BYTES) {
      return [
        {
          kind: "document",
          name,
          note: `[Người dùng gửi file "${name}" (${Math.round(params.fileSize / 1024 / 1024)} MB) — vượt giới hạn 10 MB, không lưu]`,
        },
      ];
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
        headers: { "user-agent": "Mozilla/5.0 (PenAI Zalo bridge)" },
      });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (declared > MEDIA_MAX_BYTES) throw new Error("media vượt 10MB");
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MEDIA_MAX_BYTES) throw new Error("media vượt 10MB");
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      logger.info(
        `zalo.media: msgType=${label} kind=${kind} name=${JSON.stringify(name)} bytes=${data.length} mime=${mime || "?"}`,
      );
      // chat.file → luôn giữ là document (giữ nguyên tên/đuôi file để lưu vào
      // workspace, kể cả khi người dùng gửi ảnh dưới dạng file).
      if (kind === "document") {
        return [{ kind: "document", name, dataB64: data.toString("base64") }];
      }
      if (kind === "photo" || mime.startsWith("image/")) {
        return [
          {
            kind: "photo",
            name,
            dataUrl: `data:${mime.startsWith("image/") ? mime : "image/jpeg"};base64,${data.toString("base64")}`,
          },
        ];
      }
      return [{ kind: "document", name, dataB64: data.toString("base64") }];
    } catch (error) {
      logger.warn(`zalo.media_fail: msgType=${label} name=${JSON.stringify(name)} — ${errorMessage(error)}`);
      return [
        {
          kind: "document",
          name,
          note: `[Người dùng gửi file "${name}" qua Zalo nhưng tải về thất bại: ${errorMessage(error)}]`,
        },
      ];
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    this.assertThreadAllowed(message.chatKey);
    if (!this.api) throw new Error("Zalo Personal chưa đăng nhập. Hãy quét QR trong trang Channels.");
    const thread = threadFromChatKey(message.chatKey);
    if (message.text.trim()) await this.sendText(thread.id, thread.type, message.text);
    if (message.media?.length) await this.sendFiles(thread.id, thread.type, message.media);
  }

  private async sendText(
    threadId: string,
    type: ThreadType,
    text: string,
    source: ZaloSendSource = "agent",
    webUserId?: string,
  ): Promise<string[]> {
    if (!this.api) throw new ZaloNotConnectedError();
    const all: string[] = [];
    for (const chunk of chunkZaloText(text)) {
      const ids = sentMessageIds(await this.api.sendMessage({ msg: chunk }, threadId, type));
      this.logSent(ids, threadId, type, source, webUserId, { contentType: "text", text: chunk });
      all.push(...ids);
    }
    return all;
  }

  private async sendFiles(
    threadId: string,
    type: ThreadType,
    paths: string[],
    source: ZaloSendSource = "agent",
    webUserId?: string,
    throwOnError = false,
  ): Promise<string[]> {
    if (!this.api) throw new ZaloNotConnectedError();
    const all: string[] = [];
    for (const path of paths) {
      const normalized = path.replaceAll("\\", "/");
      const name = normalized.split("/").pop() ?? "file";
      const isImage = /\.(png|jpe?g|webp|gif)$/i.test(name);
      try {
        const ids = sentMessageIds(
          await this.api.sendMessage({ msg: "", attachments: [normalized] }, threadId, type),
        );
        this.logSent(ids, threadId, type, source, webUserId, {
          contentType: isImage ? "photo" : "file",
          text: "",
          media: { name, localPath: path },
        });
        all.push(...ids);
      } catch (error) {
        const err = new Error(`Không gửi được file "${name}" qua Zalo: ${errorMessage(error)}`) as Error & {
          zaloRejected?: boolean;
        };
        // ZaloApiError (name "ZcaApiError") = Zalo đã trả lỗi → chắc chắn chưa gửi.
        if ((error as Error)?.name === "ZcaApiError") err.zaloRejected = true;
        if (throwOnError) throw err;
        this.deps.onError?.(err);
      }
    }
    return all;
  }
}
