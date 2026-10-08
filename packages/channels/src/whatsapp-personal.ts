import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  getContentType,
  normalizeMessageContent,
  useMultiFileAuthState,
  type Contact,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from "baileys";
import { logger } from "@penai/shared";
import { BoundedRunner } from "./bounded-runner.js";
import { stripToPlain } from "./format.js";
import type {
  Channel,
  ChannelContact,
  ChannelDeps,
  ChannelMessageLog,
  InboundMedia,
  OutboundMessage,
} from "./types.js";
import {
  normalizeZaloChatKey,
  parseAutoReaction,
  parseZaloDemoThreads,
  type ZaloObservedPeer,
  type ZaloPersonalAccount,
  type ZaloPersonalQrStatus,
  type ZaloPersonalStatus,
  type ZaloPersonalTarget,
  type ZaloReactionKey,
  type ZaloSendSource,
} from "./zalo-personal.js";

const WA_MAX_TEXT = 4_000;
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const OBSERVED_MAX = 1_000;
const HISTORY_MAX_MESSAGES = 20_000;

/** Tên cảm xúc dùng chung của Inbox → emoji WhatsApp. "none" = gỡ. */
export const WHATSAPP_REACTIONS: Record<ZaloReactionKey, string> = {
  heart: "❤️",
  like: "👍",
  haha: "😂",
  wow: "😮",
  cry: "😢",
  angry: "😡",
  none: "",
};

export class WhatsappNotConnectedError extends Error {
  readonly code = "NOT_CONNECTED";
  constructor(message = "WhatsApp chưa liên kết — vào Channels → Kết nối QR để quét lại.") {
    super(message);
  }
}

/** Lỗi do WhatsApp từ chối (số không dùng WhatsApp, sai mã hội thoại…) → chắc chắn tin CHƯA gửi. */
function rejected(message: string): Error {
  return Object.assign(new Error(message), { zaloRejected: true, platformRejected: true });
}

/** SĐT người dùng nhập → chỉ chữ số, kèm mã quốc gia (số Việt Nam bắt đầu bằng 0 → 84…). */
export function normalizeWhatsappPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return `84${digits.slice(1)}`;
  return digits;
}

/**
 * Mã hội thoại lưu trong Inbox ↔ JID của WhatsApp:
 * - tin riêng biết số điện thoại: chỉ chữ số ("84938583264")
 * - tin riêng chỉ biết mã ẩn danh (LID): "<số>@lid"
 * - nhóm: "<id>@g.us"
 */
export function whatsappThreadToJid(threadId: string): string {
  if (threadId.includes("@")) return threadId;
  return `${threadId.replace(/\D/g, "")}@s.whatsapp.net`;
}

export function isWhatsappThreadId(v: string): boolean {
  return /^\d{5,20}$/.test(v) || /^\d{5,25}@lid$/.test(v) || /^[0-9-]{5,40}@g\.us$/.test(v);
}

function userPart(jid: string | null | undefined): string {
  if (!jid) return "";
  const at = jid.indexOf("@");
  const user = at < 0 ? jid : jid.slice(0, at);
  const colon = user.indexOf(":");
  return colon < 0 ? user : user.slice(0, colon);
}

interface ILogger {
  level: string;
  child(obj: Record<string, unknown>): ILogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const silentLogger: ILogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface QrAttempt {
  id: string;
  status: "waiting" | "scanned" | "success" | "failed";
  qrDataUrl: string | null;
  pairingCode: string | null;
  error: string | null;
  createdAt: number;
}

export type WhatsappQrStatus = ZaloPersonalQrStatus & { pairingCode: string | null };

type Described = Pick<ChannelMessageLog, "contentType" | "text"> & { media?: ChannelMessageLog["media"] };

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
};

/** Mô tả nội dung 1 tin WhatsApp cho Inbox (chưa tải file). */
export function describeWhatsappContent(message: proto.IMessage | null | undefined): Described | null {
  const content = normalizeMessageContent(message);
  const type = getContentType(content);
  if (!content || !type) return null;
  switch (type) {
    case "conversation":
      return { contentType: "text", text: content.conversation ?? "" };
    case "extendedTextMessage":
      return { contentType: "text", text: content.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return { contentType: "photo", text: content.imageMessage?.caption ?? "" };
    case "videoMessage":
      return { contentType: "video", text: content.videoMessage?.caption ?? "" };
    case "audioMessage":
      return { contentType: "voice", text: "" };
    case "stickerMessage":
      return { contentType: "sticker", text: "" };
    case "documentMessage": {
      const d = content.documentMessage;
      const size = toNum(d?.fileLength);
      return {
        contentType: "file",
        text: d?.caption ?? "",
        media: { name: d?.fileName ?? "file", ...(size > 0 ? { size } : {}) },
      };
    }
    case "locationMessage":
    case "liveLocationMessage": {
      const l = content.locationMessage ?? content.liveLocationMessage;
      const lat = l?.degreesLatitude, lng = l?.degreesLongitude;
      return { contentType: "link", text: lat != null && lng != null ? `Vị trí: https://maps.google.com/?q=${lat},${lng}` : "Vị trí" };
    }
    case "contactMessage":
      return { contentType: "other", text: `Danh thiếp: ${content.contactMessage?.displayName ?? ""}`.trim() };
    case "contactsArrayMessage":
      return { contentType: "other", text: "Danh thiếp (nhiều người)" };
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3": {
      const p = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
      return { contentType: "other", text: `Bình chọn: ${p?.name ?? ""}`.trim() };
    }
    // Không phải nội dung trò chuyện: cảm xúc (đi đường riêng), thu hồi/sửa tin, khóa, cuộc gọi…
    case "reactionMessage":
    case "protocolMessage":
    case "senderKeyDistributionMessage":
    case "messageContextInfo":
    case "pollUpdateMessage":
    case "keepInChatMessage":
    case "encReactionMessage":
      return null;
    default:
      return { contentType: "other", text: "" };
  }
}

/**
 * WhatsApp cá nhân qua Baileys (không chính thức): PenAI là một "thiết bị đã liên kết"
 * của tài khoản — quét QR (hoặc nhập mã 8 ký tự) một lần, điện thoại vẫn dùng bình thường.
 *
 * Cùng bề mặt với ZaloPersonalChannel để dùng chung Inbox, MCP, trang Channels:
 * CHẾ ĐỘ AN TOÀN luôn bật — mặc định chỉ quan sát + lưu Inbox; agent chỉ tự trả lời trong
 * hội thoại nằm ở `config.demo_threads`, hoặc mọi tin riêng khi kênh tắt "yêu cầu pairing".
 */
export class WhatsappPersonalChannel implements Channel {
  readonly kind = "whatsapp_personal";
  readonly platformLabel = "WhatsApp";
  readonly id: string;
  readonly name: string;

  private sock: WASocket | null = null;
  private running = false;
  private connected = false;
  private account: ZaloPersonalAccount | null = null;
  private myLid = "";
  private lastError: string | null = null;
  private qrAttempts = new Map<string, QrAttempt>();
  private currentQrId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2_000;
  private generation = 0;
  private runner: BoundedRunner;
  private demoThreadSet: Set<string>;
  private openDirect: boolean;
  private observed = new Map<string, ZaloObservedPeer>();
  private names = new Map<string, string>();
  private groupNames = new Map<string, string>();
  private lidToPn = new Map<string, string>();
  private seenIds = new Set<string>();
  private sentIds = new Set<string>();
  private autoReaction: "heart" | "like" | null;
  private autoReactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private contactSync: Promise<{ friends: number; groups: number }> | null = null;
  private pendingThreadName = "";
  private historyCount = 0;
  private version: [number, number, number] | undefined;

  constructor(private deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.demoThreadSet = new Set(parseZaloDemoThreads(deps.config));
    this.openDirect = deps.requirePairing === false;
    this.autoReaction = parseAutoReaction(deps.config);
    this.runner = new BoundedRunner(20, (error) => deps.onError?.(error));
  }

  private get authDir(): string {
    if (!this.deps.stateDir) throw new Error("WhatsApp cá nhân cần thư mục trạng thái (stateDir)");
    return join(this.deps.stateDir, "auth");
  }

  private hasSession(): boolean {
    return !!this.deps.stateDir && existsSync(join(this.authDir, "creds.json"));
  }

  private isThreadEnabled(chatKey: string): boolean {
    if (this.demoThreadSet.has(chatKey)) return true;
    return this.openDirect && chatKey.startsWith("direct:");
  }

  // ===== Vòng đời =====

  async start(): Promise<void> {
    this.running = true;
    this.lastError = null;
    logger.warn(
      "security.unofficial_api: WhatsApp cá nhân dùng kết nối không chính thức; tài khoản có thể bị WhatsApp giới hạn hoặc khóa. Nên dùng số dành riêng.",
    );
    if (this.hasSession()) await this.connect(null).catch((e) => this.fail(`Không khôi phục được phiên WhatsApp: ${errText(e)}`));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const t of this.autoReactTimers.values()) clearTimeout(t);
    this.autoReactTimers.clear();
    this.currentQrId = null;
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    if (sock) await sock.end(undefined).catch(() => {});
    await this.runner.drain(10_000);
  }

  isRunning(): boolean {
    return this.running;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.deps.onError?.(new Error(message));
  }

  private async connect(attempt: QrAttempt | null): Promise<void> {
    const gen = ++this.generation;
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    if (!this.version) {
      // Bản WhatsApp Web kèm trong thư viện có thể đã cũ → WhatsApp từ chối liên kết thiết bị mới.
      this.version = await fetchLatestWaWebVersion({})
        .then((r) => r.version as [number, number, number])
        .catch(() => undefined);
    }
    const sock = makeWASocket({
      auth: state,
      ...(this.version ? { version: this.version } : {}),
      logger: silentLogger,
      browser: Browsers.macOS("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    const alive = () => gen === this.generation && this.running;

    sock.ev.on("creds.update", () => void saveCreds().catch(() => {}));

    sock.ev.on("connection.update", (u) => {
      if (!alive()) return;
      if (u.qr && attempt && attempt.status === "waiting" && !attempt.pairingCode) {
        void QRCode.toDataURL(u.qr, { width: 320, margin: 2 })
          .then((url) => {
            attempt.qrDataUrl = url;
          })
          .catch(() => {});
      }
      if (u.connection === "open") {
        this.connected = true;
        this.lastError = null;
        this.reconnectDelay = 2_000;
        const me = sock.user;
        const phone = userPart(me?.id);
        this.myLid = userPart(me?.lid);
        this.account = { id: phone, name: me?.name || me?.notify || me?.verifiedName || phone, phone };
        if (attempt) {
          attempt.status = "success";
          attempt.qrDataUrl = null;
          if (this.currentQrId === attempt.id) this.currentQrId = null;
        }
        logger.info(`whatsapp.connected: channel "${this.name}" tài khoản ${this.account.name} (${phone})`);
        this.runner.run(async () => {
          await this.syncContacts().catch((e) => logger.warn(`whatsapp.contacts_sync lỗi: ${errText(e)}`));
        });
        return;
      }
      if (u.connection !== "close") return;
      this.connected = false;
      if (this.sock === sock) this.sock = null;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        this.account = null;
        void rm(this.authDir, { recursive: true, force: true }).catch(() => {});
        const msg = "WhatsApp đã hủy liên kết thiết bị này (đăng xuất từ điện thoại hoặc phiên hết hạn). Hãy quét QR lại.";
        if (attempt && attempt.status !== "success") {
          attempt.status = "failed";
          attempt.error = msg;
        }
        this.fail(msg);
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        // Vừa quét xong: WhatsApp yêu cầu mở lại kết nối bằng phiên mới tạo
        if (attempt && attempt.status === "waiting") attempt.status = "scanned";
        void this.connect(attempt).catch((e) => this.fail(errText(e)));
        return;
      }
      if (attempt && attempt.status === "waiting" && !this.hasRegisteredSession(state.creds)) {
        // Hết lượt mã QR mà chưa ai quét
        attempt.status = "failed";
        attempt.error = "Mã đã hết hạn — bấm tạo mã mới.";
        if (this.currentQrId === attempt.id) this.currentQrId = null;
        void rm(this.authDir, { recursive: true, force: true }).catch(() => {});
        return;
      }
      // Rớt mạng / máy chủ WhatsApp đóng kết nối → tự nối lại, giãn dần tới 60 giây
      this.lastError = `Mất kết nối WhatsApp (mã ${code ?? "?"}) — đang tự kết nối lại.`;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      this.reconnectTimer = setTimeout(() => {
        if (!alive()) return;
        void this.connect(attempt && attempt.status !== "success" ? attempt : null).catch((e) => this.fail(errText(e)));
      }, delay);
      this.reconnectTimer.unref?.();
    });

    sock.ev.on("contacts.upsert", (list) => alive() && this.rememberContacts(list));
    sock.ev.on("contacts.update", (list) => alive() && this.rememberContacts(list as Contact[]));
    sock.ev.on("lid-mapping.update", (m) => {
      const lid = userPart((m as { lid?: string }).lid), pn = userPart((m as { pn?: string }).pn);
      if (lid && pn) this.lidToPn.set(lid, pn);
    });
    sock.ev.on("groups.update", (list) => {
      for (const g of list) {
        if (g.id && g.subject) {
          this.groupNames.set(g.id, g.subject);
          this.deps.onThreadName?.(g.id, g.subject);
        }
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (!alive()) return;
      for (const m of messages) {
        this.runner.run(() => this.handleMessage(sock, m, type === "notify"));
      }
    });
    sock.ev.on("messages.reaction", (list) => {
      if (!alive()) return;
      for (const r of list) this.runner.run(() => this.handleReaction(r.key, r.reaction));
    });
    sock.ev.on("messaging-history.set", (h) => {
      if (!alive()) return;
      this.runner.run(() => this.importHistory(h.contacts ?? [], h.messages ?? []));
    });
  }

  private hasRegisteredSession(creds: { registered?: boolean; me?: unknown }): boolean {
    return !!creds.me;
  }

  // ===== Trạng thái + đăng nhập =====

  status(): ZaloPersonalStatus {
    return {
      running: this.running,
      connected: this.connected,
      listening: this.connected,
      account: this.account,
      error: this.lastError,
      unofficialWarning:
        "WhatsApp cá nhân dùng kết nối không chính thức; tài khoản có thể bị WhatsApp giới hạn hoặc khóa. Nên dùng số dành riêng, tránh gửi dồn cho người lạ.",
      safeMode: true,
      demoThreads: this.demoThreads(),
      observedCount: this.observed.size,
      openDirect: this.openDirect,
    };
  }

  isConnected(): boolean {
    return this.connected && this.sock !== null;
  }

  accountInfo(): ZaloPersonalAccount | null {
    return this.account;
  }

  demoThreads(): string[] {
    return [...this.demoThreadSet].sort();
  }

  setDemoThreads(threads: string[]): void {
    this.demoThreadSet = new Set(threads.map(normalizeZaloChatKey).filter((key) => /^(group|direct):.+$/.test(key)));
    for (const peer of this.observed.values()) peer.allowed = this.isThreadEnabled(peer.chatKey);
    logger.info(
      `whatsapp.safe_mode: channel "${this.name}" hội thoại cho AI trả lời = [${this.demoThreads().join(", ") || "trống — chỉ quan sát"}]` +
        (this.openDirect ? " + MỞ mọi tin riêng (đã tắt yêu cầu pairing)" : ""),
    );
  }

  listObserved(): ZaloObservedPeer[] {
    return [...this.observed.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async startQrLogin(): Promise<{ id: string }> {
    if (!this.running) throw new Error("Channel đang tạm dừng; hãy bật channel trước.");
    if (this.connected) throw new Error("WhatsApp đã liên kết. Hãy ngắt kết nối trước khi quét QR lại.");
    if (this.currentQrId) {
      const current = this.qrAttempts.get(this.currentQrId);
      if (current && (current.status === "waiting" || current.status === "scanned")) return { id: current.id };
    }
    for (const [k, a] of this.qrAttempts) if (Date.now() - a.createdAt > 30 * 60_000) this.qrAttempts.delete(k);
    // Bắt đầu sạch: phiên dở dang của lần quét hỏng trước đó làm WhatsApp từ chối
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const old = this.sock;
    this.sock = null;
    this.generation++;
    if (old) await old.end(undefined).catch(() => {});
    await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
    const attempt: QrAttempt = { id: randomUUID(), status: "waiting", qrDataUrl: null, pairingCode: null, error: null, createdAt: Date.now() };
    this.qrAttempts.set(attempt.id, attempt);
    this.currentQrId = attempt.id;
    this.lastError = null;
    void this.connect(attempt).catch((e) => {
      attempt.status = "failed";
      attempt.error = errText(e);
    });
    return { id: attempt.id };
  }

  /** Thay cho quét QR: lấy mã 8 ký tự để nhập ở WhatsApp → Liên kết thiết bị → Liên kết bằng số điện thoại. */
  async requestPairingCode(loginId: string, phone: string): Promise<string> {
    const attempt = this.qrAttempts.get(loginId);
    if (!attempt || attempt.status !== "waiting" || !this.sock) throw new Error("Phiên liên kết không còn hiệu lực — bấm tạo mã mới.");
    const digits = normalizeWhatsappPhone(phone);
    if (!/^\d{8,15}$/.test(digits)) throw new Error("Số điện thoại không hợp lệ");
    const code = await this.sock.requestPairingCode(digits);
    attempt.pairingCode = code;
    attempt.qrDataUrl = null;
    return code;
  }

  qrStatus(id: string): WhatsappQrStatus | null {
    const a = this.qrAttempts.get(id);
    if (!a) return null;
    return {
      id: a.id,
      status: a.status,
      qrDataUrl: a.qrDataUrl,
      pairingCode: a.pairingCode,
      scannedName: null,
      error: a.error,
      account: a.status === "success" ? this.account : null,
    };
  }

  async logout(): Promise<void> {
    this.currentQrId = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = null;
    this.generation++;
    this.connected = false;
    this.account = null;
    this.lastError = null;
    if (sock) {
      await sock.logout().catch(() => {});
      await sock.end(undefined).catch(() => {});
    }
    await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
  }

  // ===== Danh bạ =====

  private rememberContacts(list: Contact[]): void {
    for (const c of list) {
      const name = c.name || c.notify || c.verifiedName || "";
      const lid = userPart(c.lid ?? (c.id?.endsWith("@lid") ? c.id : ""));
      const pn = userPart(c.phoneNumber ?? (c.id?.endsWith("@s.whatsapp.net") ? c.id : ""));
      if (lid && pn) this.lidToPn.set(lid, pn);
      if (name && pn) this.names.set(pn, name);
      if (name && lid) this.names.set(`${lid}@lid`, name);
    }
  }

  async listTargets(): Promise<ZaloPersonalTarget[]> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new WhatsappNotConnectedError();
    const targets: ZaloPersonalTarget[] = [];
    for (const [id, name] of this.names) {
      if (id.includes("@")) continue;
      targets.push({ id, type: "direct", name, phone: `+${id}` });
    }
    const groups = await sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) {
      if (g.subject) this.groupNames.set(g.id, g.subject);
      targets.push({ id: g.id, type: "group", name: g.subject || g.id, memberCount: g.participants?.length ?? 0 });
    }
    return targets.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }

  syncContacts(): Promise<{ friends: number; groups: number }> {
    if (!this.isConnected()) return Promise.reject(new WhatsappNotConnectedError());
    if (this.contactSync) return this.contactSync;
    this.contactSync = (async () => {
      try {
        const targets = await this.listTargets();
        const items: ChannelContact[] = targets.map((t) => ({
          id: t.id,
          type: t.type,
          name: t.name,
          ...(t.phone ? { phone: t.phone } : {}),
          ...(t.memberCount !== undefined ? { memberCount: t.memberCount } : {}),
        }));
        this.deps.onContactsSynced?.(items);
        const groups = items.filter((i) => i.type === "group").length;
        logger.info(`whatsapp.contacts_synced: channel "${this.name}" ${items.length - groups} người, ${groups} nhóm`);
        return { friends: items.length - groups, groups };
      } finally {
        this.contactSync = null;
      }
    })();
    return this.contactSync;
  }

  async findUserByPhone(phone: string): Promise<{ uid: string; name: string; avatar: string } | null> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new WhatsappNotConnectedError();
    const digits = normalizeWhatsappPhone(phone);
    if (!/^\d{8,15}$/.test(digits)) return null;
    const res = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
    const hit = res?.find((r) => r.exists);
    if (!hit) return null;
    const uid = userPart(hit.jid) || digits;
    return { uid, name: this.names.get(uid) ?? `+${uid}`, avatar: "" };
  }

  async resolvePhone(phone: string): Promise<{ uid: string; name: string }> {
    const user = await this.findUserByPhone(phone);
    if (!user) throw new Error("Số này không dùng WhatsApp");
    return { uid: user.uid, name: user.name };
  }

  async lookupGroupName(threadId: string): Promise<string> {
    const cached = this.groupNames.get(threadId);
    if (cached) return cached;
    if (!this.sock || !this.connected || !threadId.endsWith("@g.us")) return "";
    const meta = await this.sock.groupMetadata(threadId).catch(() => null);
    if (meta?.subject) this.groupNames.set(threadId, meta.subject);
    return meta?.subject ?? "";
  }

  // ===== Gửi =====

  private assertThread(threadId: string, peerKind: "direct" | "group"): string {
    if (!isWhatsappThreadId(threadId)) throw rejected("Mã hội thoại WhatsApp không hợp lệ");
    const jid = whatsappThreadToJid(threadId);
    if ((peerKind === "group") !== jid.endsWith("@g.us")) throw rejected("Loại hội thoại (cá nhân/nhóm) không khớp với mã hội thoại");
    return jid;
  }

  private logSent(
    msg: WAMessage | undefined,
    threadId: string,
    peerKind: "direct" | "group",
    source: ZaloSendSource,
    webUserId: string | undefined,
    content: Described,
  ): string {
    const id = msg?.key?.id ?? "";
    if (id) {
      this.sentIds.add(id);
      setTimeout(() => this.sentIds.delete(id), 120_000).unref?.();
    }
    try {
      this.deps.onMessageLog?.({
        threadId,
        peerKind,
        msgId: id,
        direction: "out",
        source,
        senderId: this.account?.id ?? "",
        senderName: this.account?.name ?? "",
        ...(webUserId ? { webUserId } : {}),
        ...content,
        ...(msg?.key ? { meta: { waKey: keyMeta(msg.key) } } : {}),
        sentAt: new Date(),
        ...(this.pendingThreadName ? { threadName: this.pendingThreadName } : {}),
      });
    } catch (error) {
      logger.warn(`whatsapp.inbox_log_fail: ${errText(error)}`);
    }
    return id;
  }

  private async sendText(threadId: string, peerKind: "direct" | "group", text: string, source: ZaloSendSource = "agent", webUserId?: string): Promise<string[]> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new WhatsappNotConnectedError();
    const jid = this.assertThread(threadId, peerKind);
    const plain = source === "agent" ? stripToPlain(text) : text;
    const ids: string[] = [];
    for (let i = 0; i < plain.length; i += WA_MAX_TEXT) {
      const part = plain.slice(i, i + WA_MAX_TEXT);
      if (!part.trim()) continue;
      const sent = await sock.sendMessage(jid, { text: part });
      ids.push(this.logSent(sent, threadId, peerKind, source, webUserId, { contentType: "text", text: part }));
    }
    return ids.filter(Boolean);
  }

  private async sendFiles(threadId: string, peerKind: "direct" | "group", paths: string[], source: ZaloSendSource = "agent", webUserId?: string): Promise<string[]> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new WhatsappNotConnectedError();
    const jid = this.assertThread(threadId, peerKind);
    const ids: string[] = [];
    for (const path of paths) {
      const buf = await readFile(path);
      const ext = extname(path).slice(1).toLowerCase();
      const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
      const name = basename(path);
      const sent = isImage
        ? await sock.sendMessage(jid, { image: buf })
        : await sock.sendMessage(jid, { document: buf, fileName: name, mimetype: mimeOf(ext) });
      ids.push(
        this.logSent(sent, threadId, peerKind, source, webUserId, {
          contentType: isImage ? "photo" : "file",
          text: "",
          media: { name, size: buf.length, localPath: path },
        }),
      );
    }
    return ids.filter(Boolean);
  }

  async sendManual(input: {
    threadId: string;
    peerKind: "direct" | "group";
    text?: string;
    filePaths?: string[];
    source: ZaloSendSource;
    webUserId?: string;
    threadName?: string;
  }): Promise<string[]> {
    if (!this.isConnected()) throw new WhatsappNotConnectedError();
    const ids: string[] = [];
    this.pendingThreadName = input.threadName ?? "";
    try {
      if (input.text?.trim()) ids.push(...(await this.sendText(input.threadId, input.peerKind, input.text, input.source, input.webUserId)));
      if (input.filePaths?.length) ids.push(...(await this.sendFiles(input.threadId, input.peerKind, input.filePaths, input.source, input.webUserId)));
    } finally {
      this.pendingThreadName = "";
    }
    return ids;
  }

  async sendTestMessage(threadId: string, peerKind: "direct" | "group", text: string): Promise<void> {
    await this.sendText(threadId, peerKind, text, "web");
  }

  /** Agent/lịch hẹn gửi qua cổng chung: chatKey = "direct:<id>" | "group:<id>". */
  async send(message: OutboundMessage): Promise<void> {
    const key = normalizeZaloChatKey(message.chatKey);
    const peerKind = key.startsWith("group:") ? "group" : "direct";
    const threadId = key.slice(key.indexOf(":") + 1);
    if (message.text.trim()) await this.sendText(threadId, peerKind, message.text);
    if (message.media?.length) await this.sendFiles(threadId, peerKind, message.media);
  }

  // ===== Cảm xúc =====

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

  async react(input: {
    threadId: string;
    peerKind: "direct" | "group";
    msgId: string;
    cliMsgId?: string;
    meta?: Record<string, unknown> | null;
    reaction: ZaloReactionKey;
    source: "web" | "auto" | "mcp";
    webUserId?: string;
  }): Promise<void> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new WhatsappNotConnectedError();
    const key = (input.meta?.waKey ?? null) as WAMessageKey | null;
    if (!key?.id || !key.remoteJid) throw Object.assign(new Error("Tin này không thả cảm xúc được."), { code: "CANNOT_REACT" });
    const icon = WHATSAPP_REACTIONS[input.reaction];
    await sock.sendMessage(key.remoteJid, { react: { text: icon, key } });
    this.deps.onReaction?.({
      threadId: input.threadId,
      peerKind: input.peerKind,
      targetMsgId: input.msgId,
      reactorId: this.account?.id ?? "",
      reactorName: this.account?.name ?? "",
      icon,
      source: input.source,
      ...(input.webUserId ? { webUserId: input.webUserId } : {}),
      at: new Date(),
    });
  }

  private scheduleAutoReaction(m: WAMessage, peerKind: "direct" | "group", threadId: string): void {
    const kind = this.autoReaction;
    if (!kind || !m.key.id) return;
    const prev = this.autoReactTimers.get(threadId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.autoReactTimers.delete(threadId);
      void this.react({ threadId, peerKind, msgId: m.key.id!, meta: { waKey: keyMeta(m.key) }, reaction: kind, source: "auto" }).catch(() => {});
    }, 4_000);
    t.unref?.();
    this.autoReactTimers.set(threadId, t);
  }

  private async handleReaction(key: WAMessageKey, reaction: proto.IReaction): Promise<void> {
    const target = reaction.key ?? key;
    const jid = target.remoteJid ?? key.remoteJid ?? "";
    if (!jid || !target.id) return;
    const peerKind = jid.endsWith("@g.us") ? "group" : "direct";
    const threadId = peerKind === "group" ? jid : await this.directThreadId(jid, (target as WAMessageKey).remoteJidAlt ?? key.remoteJidAlt);
    const fromMe = !!key.fromMe;
    const reactor = fromMe ? (this.account?.id ?? "") : await this.personId(key.participant ?? key.remoteJid ?? "", key.participantAlt ?? key.remoteJidAlt);
    this.deps.onReaction?.({
      threadId,
      peerKind,
      targetMsgId: target.id,
      reactorId: reactor,
      reactorName: fromMe ? (this.account?.name ?? "") : (this.names.get(reactor) ?? reactor),
      icon: reaction.text ?? "",
      source: fromMe ? "app" : "peer",
      at: new Date(),
    });
  }

  // ===== Nhận tin =====

  /** JID người (số điện thoại hoặc LID) → mã dùng trong Inbox: ưu tiên số điện thoại. */
  private async personId(jid: string, alt?: string | null): Promise<string> {
    if (alt && alt.endsWith("@s.whatsapp.net")) {
      const pn = userPart(alt);
      if (jid.endsWith("@lid")) this.lidToPn.set(userPart(jid), pn);
      return pn;
    }
    if (!jid.endsWith("@lid")) return userPart(jid);
    const lid = userPart(jid);
    const known = this.lidToPn.get(lid);
    if (known) return known;
    const pnJid = await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
    if (pnJid) {
      const pn = userPart(pnJid);
      this.lidToPn.set(lid, pn);
      return pn;
    }
    return `${lid}@lid`;
  }

  private directThreadId(jid: string, alt?: string | null): Promise<string> {
    return this.personId(jid, alt);
  }

  private isMe(jid: string | null | undefined): boolean {
    const u = userPart(jid);
    return !!u && (u === this.account?.id || u === this.myLid);
  }

  private async toLog(
    m: WAMessage,
    opts: { download: boolean },
  ): Promise<{ entry: ChannelMessageLog; chatKey: string; media: InboundMedia[]; mentioned: boolean } | null> {
    const key = m.key;
    const jid = key.remoteJid ?? "";
    if (!jid || !key.id) return null;
    if (jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return null;
    const described = describeWhatsappContent(m.message);
    if (!described) return null;
    const peerKind: "direct" | "group" = jid.endsWith("@g.us") ? "group" : "direct";
    const threadId = peerKind === "group" ? jid : await this.directThreadId(jid, key.remoteJidAlt);
    const fromMe = !!key.fromMe;
    const senderId = fromMe
      ? (this.account?.id ?? "")
      : peerKind === "group"
        ? await this.personId(key.participant ?? "", key.participantAlt)
        : threadId;
    if (!fromMe && m.pushName && senderId) this.names.set(senderId, m.pushName);
    const senderName = fromMe ? (this.account?.name ?? senderId) : m.pushName || this.names.get(senderId) || (senderId.includes("@") ? "Người dùng WhatsApp" : `+${senderId}`);

    const content = normalizeMessageContent(m.message);
    const type = getContentType(content);
    const mediaOut: InboundMedia[] = [];
    let media = described.media;
    if (opts.download && content && type && ["imageMessage", "documentMessage", "audioMessage", "videoMessage", "stickerMessage"].includes(type)) {
      const part = (content as Record<string, { fileLength?: unknown; mimetype?: string | null; fileName?: string | null } | undefined>)[type];
      const size = toNum(part?.fileLength);
      const mime = (part?.mimetype ?? "").split(";")[0]!.trim();
      const name = part?.fileName || `${type.replace("Message", "")}.${MIME_EXT[mime] ?? "bin"}`;
      if (size > MEDIA_MAX_BYTES) {
        mediaOut.push({ kind: "document", name, note: `File ${name} vượt 10 MB nên không tải về.` });
      } else {
        try {
          const sock = this.sock;
          const buf = await downloadMediaMessage(m, "buffer", {}, sock ? { logger: silentLogger, reuploadRequest: sock.updateMediaMessage } : undefined);
          const ext = MIME_EXT[mime] ?? (extname(name).slice(1) || "bin");
          const localPath = await this.deps.saveInboxFile?.(buf, ext).catch(() => undefined);
          media = { ...(media ?? {}), name, size: buf.length, ...(localPath ? { localPath } : {}) };
          if (type === "imageMessage") mediaOut.push({ kind: "photo", dataUrl: `data:${mime || "image/jpeg"};base64,${buf.toString("base64")}`, name });
          else if (type === "documentMessage") mediaOut.push({ kind: "document", dataB64: buf.toString("base64"), name });
          else if (type === "audioMessage") mediaOut.push({ kind: "voice", name, note: "Tin nhắn thoại (chưa chuyển thành chữ)." });
          else if (type === "videoMessage") mediaOut.push({ kind: "video", name, note: "Video (chưa xem được nội dung)." });
        } catch (error) {
          mediaOut.push({ kind: "document", name, note: `Không tải được file ${name}: ${errText(error)}` });
        }
      }
    }

    const ctxInfo = (content as Record<string, { contextInfo?: proto.IContextInfo | null } | undefined> | undefined)?.[type ?? ""]?.contextInfo;
    const meta: Record<string, unknown> = { waKey: keyMeta(key) };
    if (ctxInfo?.quotedMessage) {
      const q = describeWhatsappContent(ctxInfo.quotedMessage);
      meta.quote = { ownerId: userPart(ctxInfo.participant), text: (q?.text ?? "").slice(0, 300) };
    }
    const mentions = ctxInfo?.mentionedJid ?? [];
    if (mentions.length) meta.mentions = mentions.map((j) => userPart(j));
    const mentioned =
      peerKind !== "group" ||
      mentions.some((j) => this.isMe(j)) ||
      this.isMe(ctxInfo?.participant) ||
      described.text.trim().startsWith("/");

    const ts = toNum(m.messageTimestamp);
    const entry: ChannelMessageLog = {
      threadId,
      peerKind,
      msgId: key.id,
      direction: fromMe ? "out" : "in",
      source: fromMe ? "app" : "peer",
      senderId,
      senderName,
      contentType: described.contentType,
      text: described.text,
      ...(media ? { media } : {}),
      meta,
      sentAt: ts > 0 ? new Date(ts * 1000) : new Date(),
      threadName: peerKind === "group" ? (this.groupNames.get(threadId) ?? "") : fromMe ? (this.names.get(threadId) ?? "") : senderName,
    };
    return { entry, chatKey: `${peerKind}:${threadId}`, media: mediaOut, mentioned };
  }

  private async handleMessage(sock: WASocket, m: WAMessage, live: boolean): Promise<void> {
    const id = m.key?.id ?? "";
    if (!id || this.seenIds.has(id)) return;
    this.seenIds.add(id);
    setTimeout(() => this.seenIds.delete(id), 5 * 60_000).unref?.();
    // Tin do PenAI vừa gửi đã ghi Inbox lúc gửi → bỏ qua bản dội lại
    if (m.key.fromMe && this.sentIds.has(id)) return;
    if (m.key.fromMe) {
      await new Promise((r) => setTimeout(r, 1_500));
      if (this.sentIds.has(id)) return;
    }
    const parsed = await this.toLog(m, { download: live && !m.key.fromMe });
    if (!parsed) return;
    const { entry, chatKey, media, mentioned } = parsed;
    try {
      this.deps.onMessageLog?.(entry);
    } catch (error) {
      logger.warn(`whatsapp.inbox_log_fail: ${errText(error)}`);
    }
    // Tin tới lúc PenAI đang tắt (đồng bộ bù) chỉ lưu Inbox, không chạy agent cho tin đã cũ
    if (!live) return;
    const fromMe = entry.direction === "out";
    if (!fromMe) this.scheduleAutoReaction(m, entry.peerKind, entry.threadId);
    if (entry.peerKind === "group" || !fromMe) this.recordObservation(chatKey, entry.threadId, entry.peerKind, entry.senderId, entry.senderName);
    if (fromMe) return;
    if (!this.isThreadEnabled(chatKey)) return;
    if (!entry.text.trim() && media.length === 0) return;

    const jid = whatsappThreadToJid(entry.threadId);
    const hooks = {
      onStatus: (status: string) => {
        if (status === "queued" || status === "thinking") void sock.sendPresenceUpdate("composing", jid).catch(() => {});
      },
      onBlockReply: (blockText: string) => {
        void this.sendText(entry.threadId, entry.peerKind, blockText).catch((error) => this.deps.onError?.(error as Error));
      },
    };
    try {
      const result = await this.deps.onInbound(
        {
          channelId: this.id,
          channelKind: this.kind,
          chatKey,
          senderId: entry.senderId,
          senderName: entry.senderName,
          text: entry.text,
          peerKind: entry.peerKind,
          mentioned,
          ...(media.length ? { media } : {}),
        },
        hooks,
      );
      void sock.sendPresenceUpdate("paused", jid).catch(() => {});
      if (result.kind === "pairing") {
        // Tài khoản thật không tự nhắn mã ghép nối cho người lạ — quản trị duyệt ở Dashboard → Channels
        logger.info(`whatsapp.pairing_silent: ${chatKey} chưa duyệt — đã cấp mã chờ quản trị, không nhắn lại`);
      } else if (result.kind === "reply") {
        if (result.text.trim()) await this.sendText(entry.threadId, entry.peerKind, result.text);
        if (result.media?.length) await this.sendFiles(entry.threadId, entry.peerKind, result.media);
      }
    } catch (error) {
      this.deps.onError?.(error as Error);
      await this.sendText(entry.threadId, entry.peerKind, "⚠️ Có lỗi khi xử lý tin nhắn. Vui lòng thử lại.").catch(() => {});
    }
  }

  /** Tin cũ WhatsApp gửi về ngay sau khi liên kết thiết bị → lưu Inbox (không tải file, không chạy agent). */
  private async importHistory(contacts: Contact[], messages: WAMessage[]): Promise<void> {
    this.rememberContacts(contacts);
    if (!this.deps.onHistory || !messages.length || this.historyCount >= HISTORY_MAX_MESSAGES) return;
    const entries: ChannelMessageLog[] = [];
    for (const m of messages) {
      if (this.historyCount + entries.length >= HISTORY_MAX_MESSAGES) break;
      const parsed = await this.toLog(m, { download: false }).catch(() => null);
      if (!parsed) continue;
      if (m.key.id) this.seenIds.add(m.key.id);
      entries.push(parsed.entry);
    }
    if (!entries.length) return;
    entries.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    this.historyCount += entries.length;
    logger.info(`whatsapp.history_import: channel "${this.name}" nhận ${entries.length} tin cũ (tổng ${this.historyCount})`);
    this.deps.onHistory(entries);
  }

  private recordObservation(chatKey: string, threadId: string, type: "direct" | "group", senderId: string, senderName: string): void {
    const now = new Date().toISOString();
    const existing = this.observed.get(chatKey);
    const name = type === "direct" ? senderName : this.groupNames.get(threadId) || existing?.name || "Nhóm WhatsApp";
    this.deps.onObserved?.({ chatKey, threadId, kind: type, name, lastSenderId: senderId, lastSenderName: senderName, countMessage: true });
    if (existing) {
      Object.assign(existing, { lastSenderId: senderId, lastSenderName: senderName, messageCount: existing.messageCount + 1, lastSeenAt: now, name });
      return;
    }
    if (this.observed.size >= OBSERVED_MAX) {
      const oldest = [...this.observed.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];
      if (oldest) this.observed.delete(oldest.chatKey);
    }
    this.observed.set(chatKey, {
      chatKey,
      threadId,
      type,
      name,
      lastSenderId: senderId,
      lastSenderName: senderName,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      allowed: this.isThreadEnabled(chatKey),
    });
    if (type === "group" && !this.groupNames.has(threadId)) {
      void this.lookupGroupName(threadId).then((n) => {
        if (!n) return;
        const peer = this.observed.get(chatKey);
        if (peer) peer.name = n;
        this.deps.onThreadName?.(threadId, n);
        this.deps.onObserved?.({ chatKey, threadId, kind: type, name: n, lastSenderId: senderId, lastSenderName: senderName, countMessage: false });
      });
    }
  }
}

/** Số từ protobuf: number, chuỗi, hoặc Long ({ low, high } / toNumber()). */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  if (v && typeof v === "object") {
    const o = v as { toNumber?: () => number; low?: number; high?: number };
    if (typeof o.toNumber === "function") return o.toNumber();
    if (typeof o.low === "number") return (o.high ?? 0) * 4294967296 + (o.low >>> 0);
  }
  return 0;
}

function keyMeta(key: WAMessageKey): Record<string, unknown> {
  return {
    remoteJid: key.remoteJid ?? "",
    id: key.id ?? "",
    fromMe: !!key.fromMe,
    ...(key.participant ? { participant: key.participant } : {}),
  };
}

function mimeOf(ext: string): string {
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  return "application/octet-stream";
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
