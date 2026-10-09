/**
 * Inbox trực chat dùng chung cho các kênh cá nhân (Zalo cá nhân, WhatsApp cá nhân) — 0031, 0034.
 *
 * - Adapter của kênh báo MỌI tin đến/đi (onMessageLog) → lưu inbox_messages
 *   + inbox_threads → đẩy realtime (SSE) cho người đang trực.
 * - Người trực (operator trở lên: mọi kênh; member: kênh được gán) xem hội thoại,
 *   gửi text/ảnh, bật/tắt AI theo hội thoại. Nhân viên trả lời (web hoặc điện
 *   thoại) → AI tạm im trong hội thoại đó `inbox_pause_minutes` phút (mặc định 30).
 * - Dùng chung cho MCP server (mcp-server.ts): gửi tin/ảnh, tra SĐT, danh bạ.
 *
 * Cấu hình theo kênh (channels.config): `inbox` (mặc định true — lưu nội dung),
 * `inbox_pause_minutes` (mặc định 30, 0 = không tạm dừng).
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasRole, logger, type WorkspaceContext } from "@penai/shared";
import {
  clearInboxPauses,
  getChannelById,
  getInboxThread,
  listChannels,
  listUserInboxChannelIds,
  listInboxMessages,
  listInboxThreads,
  markInboxThreadRead,
  recordInboxMessage,
  setInboxThreadAi,
  setInboxThreadName,
  updateChannel,
  upsertInboxReaction,
  setInboxMessageCliId,
  upsertContact,
  getInboxMessageById,
  latestIncomingInboxMessages,
  upsertInboxContacts,
  recordAudit,
  type Db,
  type InboxMessageRow,
  type InboxThread,
} from "@penai/db";
import {
  isPersonalChannel,
  isPersonalChannelKind,
  isValidThreadId,
  personalPlatformLabel,
  type PersonalChannel,
  isZaloReactionKey,
  parseAutoReaction,
  ZALO_REACTIONS,
  type ZaloReactionKey,
  type ChannelReaction,
  type ChannelContact,
  type ChannelMessageLog,
  type ZaloSendSource,
} from "@penai/channels";
import { channelHandlers } from "./channels-runtime.js";
import { readPhotoAcknowledgement } from "./photo-burst.js";

// ===== Cấu hình sống theo kênh =====

interface InboxChannelState {
  workspaceId: string;
  enabled: boolean;
  pauseMinutes: number;
}

const inboxState = new Map<string, InboxChannelState>();
let inboxDataDir = "";

export function readInboxConfig(config: Record<string, unknown>): {
  enabled: boolean;
  pauseMinutes: number;
  mcpReadMessages: boolean;
  autoReaction: "heart" | "like" | null;
  agentReply: boolean;
  photoAck: "short" | "off";
} {
  const raw = Number(config["inbox_pause_minutes"]);
  return {
    enabled: config["inbox"] !== false,
    pauseMinutes: Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 24 * 60) : 30,
    // Ứng dụng AI bên ngoài (MCP) đọc hội thoại + nội dung tin: MẶC ĐỊNH TẮT, quản trị bật theo từng kênh.
    mcpReadMessages: config["mcp_read_messages"] === true,
    // Tự thả cảm xúc khi khách nhắn (cá nhân + nhóm): MẶC ĐỊNH TẮT.
    autoReaction: parseAutoReaction(config),
    // Công tắc "Agent tự trả lời" (Channels → Sửa): mặc định bật.
    agentReply: config["agent_reply"] !== false,
    photoAck: readPhotoAcknowledgement(config),
  };
}

// ===== SSE: đẩy tin mới cho người đang trực =====

interface SseClient {
  workspaceId: string;
  /** null = mọi kênh (operator trở lên) */
  channelIds: Set<string> | null;
  write: (chunk: string) => void;
}

const sseClients = new Set<SseClient>();

function broadcast(workspaceId: string, channelId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.workspaceId !== workspaceId) continue;
    if (c.channelIds && !c.channelIds.has(channelId)) continue;
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

setInterval(() => {
  for (const c of sseClients) {
    try {
      c.write(": ping\n\n");
    } catch {
      sseClients.delete(c);
    }
  }
}, 25_000).unref();

// ===== Hook cho adapter (channels-runtime gọi khi dựng kênh) =====

function ctxOf(workspaceId: string): WorkspaceContext {
  return { workspaceId, userId: workspaceId, role: "ws_admin" };
}

function inboxRuntime(channelId: string): PersonalChannel | null {
  const ch = channelHandlers.get(channelId)?.channel;
  return isPersonalChannel(ch) ? ch : null;
}

/** Tên nền tảng của kênh (Zalo, WhatsApp) để ghi vào thông báo cho người dùng. */
function platformOf(channelId: string): string {
  return personalPlatformLabel(channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal");
}

const groupNameLookups = new Set<string>();

/** Ghi Contacts tối đa 1 lần/phút cho mỗi người/nhóm (nhóm đông tin không làm DB bận). */
const contactSeen = new Map<string, { at: number; name: string }>();
setInterval(() => {
  const cut = Date.now() - 10 * 60_000;
  for (const [k, v] of contactSeen) if (v.at < cut) contactSeen.delete(k);
}, 10 * 60_000).unref();

function recordInboxContact(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  channelKind: string,
  externalId: string,
  name: string,
  kind: "user" | "group",
): void {
  if (!externalId || externalId === "0") return;
  const key = `${channelId}:${externalId}`;
  const prev = contactSeen.get(key);
  if (prev && Date.now() - prev.at < 60_000 && (!name || prev.name === name)) return;
  contactSeen.set(key, { at: Date.now(), name });
  void upsertContact(db, ctx, {
    channelId,
    channelKind,
    externalId,
    ...(name ? { displayName: name } : {}),
    // peer_kind: loại người/nhóm (mọi nền tảng); zalo_kind giữ cho dữ liệu + bản cũ
    metadata: channelKind === "zalo_personal" ? { peer_kind: kind, zalo_kind: kind } : { peer_kind: kind },
  }).catch((err) => logger.warn(`zalo.contact_store lỗi: ${(err as Error).message}`));
}

/** Hook onMessageLog / onContactsSynced / onThreadName… cho 1 kênh cá nhân (Zalo, WhatsApp). */
export function inboxHooks(
  db: Db,
  ch: { id: string; kind: string; workspaceId: string; config: Record<string, unknown> },
  dataDir: string,
) {
  const cfg = readInboxConfig(ch.config);
  inboxState.set(ch.id, { workspaceId: ch.workspaceId, enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes });
  const ctx = ctxOf(ch.workspaceId);
  const toInput = (entry: ChannelMessageLog) => ({
    threadId: entry.threadId,
    peerKind: entry.peerKind,
    msgId: entry.msgId,
    direction: entry.direction,
    source: entry.source,
    senderId: entry.senderId,
    senderName: entry.senderName,
    webUserId: entry.webUserId ?? null,
    contentType: entry.contentType,
    text: entry.text,
    media: entry.media ? { ...entry.media } : null,
    meta: entry.meta ?? null,
    sentAt: entry.sentAt,
    threadName: entry.threadName ?? "",
  });
  return {
    // Thư mục giữ phiên đăng nhập của kênh (WhatsApp: khóa thiết bị liên kết)
    stateDir: resolve(join(dataDir, ch.workspaceId, "channel-state", ch.id)),
    saveInboxFile: async (buf: Buffer, ext: string) =>
      saveOutboundImage(dataDir, ch.workspaceId, ch.id, { buf, ext: ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin" }),
    // Tin cũ nền tảng gửi về sau khi liên kết: lưu tuần tự theo thời gian, không tính "chưa đọc"
    onHistory: (entries: ChannelMessageLog[]) => {
      const st = inboxState.get(ch.id);
      if (!st?.enabled) return;
      void (async () => {
        let n = 0;
        for (const entry of entries) {
          const saved = await recordInboxMessage(db, ctx, ch.id, toInput(entry), { history: true }).catch(() => null);
          if (saved) n++;
        }
        logger.info(`inbox.history_import: kênh ${ch.id} lưu ${n}/${entries.length} tin cũ`);
        if (n) broadcast(ch.workspaceId, ch.id, "contacts", { channelId: ch.id, count: n });
      })();
    },
    onMessageLog: (entry: ChannelMessageLog) => {
      // Contacts: MỌI người nhắn tới (tin riêng + người gửi trong nhóm) và cả NHÓM — ghi ngay,
      // không phụ thuộc thread demo / công tắc agent / lưu Inbox (chỉ tên + uid).
      if (entry.direction === "in" && (entry.source === "zalo" || entry.source === "peer")) {
        if (entry.peerKind === "group") {
          recordInboxContact(db, ctx, ch.id, ch.kind, entry.threadId, entry.threadName ?? "", "group");
        }
        recordInboxContact(db, ctx, ch.id, ch.kind, entry.senderId, entry.senderName, "user");
      }
      const st = inboxState.get(ch.id);
      if (!st?.enabled) return;
      void (async () => {
        const saved = await recordInboxMessage(db, ctx, ch.id, toInput(entry), { pauseMinutes: st.pauseMinutes });
        if (!saved) return;
        broadcast(ch.workspaceId, ch.id, "message", {
          channelId: ch.id,
          thread: saved.thread,
          message: publicMessage(saved.message, ch.workspaceId),
        });
        // Nhóm chưa có tên → tra 1 lần
        const key = `${ch.id}:${entry.threadId}`;
        if (entry.peerKind === "group" && !saved.thread.name && !groupNameLookups.has(key)) {
          groupNameLookups.add(key);
          const name = await inboxRuntime(ch.id)?.lookupGroupName(entry.threadId);
          if (name) {
            await setInboxThreadName(db, ctx, ch.id, entry.threadId, name);
            recordInboxContact(db, ctx, ch.id, ch.kind, entry.threadId, name, "group");
            broadcast(ch.workspaceId, ch.id, "thread", { channelId: ch.id, thread: { ...saved.thread, name } });
          }
        }
      })().catch((err) => logger.warn(`zalo.inbox_store lỗi: ${(err as Error).message}`));
    },
    onContactsSynced: (items: ChannelContact[]) => {
      void upsertInboxContacts(
        db,
        ctx,
        ch.id,
        items.map((i) => ({
          threadId: i.id,
          kind: i.type,
          name: i.name,
          ...(i.contactAlias !== undefined ? { contactAlias: i.contactAlias } : {}),
          ...(i.avatar ? { avatar: i.avatar } : {}),
          ...(i.phone ? { phone: i.phone } : {}),
          ...(i.memberCount !== undefined ? { memberCount: i.memberCount } : {}),
        })),
      )
        .then((n) => broadcast(ch.workspaceId, ch.id, "contacts", { channelId: ch.id, count: n }))
        .catch((err) => logger.warn(`zalo.contacts_store lỗi: ${(err as Error).message}`));
    },
    onThreadName: (threadId: string, name: string) => {
      void setInboxThreadName(db, ctx, ch.id, threadId, name).catch(() => {});
      recordInboxContact(db, ctx, ch.id, ch.kind, threadId, name, "group");
    },
    onMessageCliId: (msgId: string, cliMsgId: string) => {
      // Bản dội lại có thể tới trước khi tin kịp ghi DB → thử lại sau 3 giây nếu chưa thấy.
      const apply = (retry: boolean) =>
        setInboxMessageCliId(db, ctx, ch.id, msgId, cliMsgId)
          .then((m) => {
            if (m) broadcast(ch.workspaceId, ch.id, "message_update", { channelId: ch.id, threadId: m.threadId, message: publicMessage(m, ch.workspaceId) });
            else if (retry) setTimeout(() => void apply(false), 3_000).unref?.();
          })
          .catch((err) => logger.warn(`zalo.cli_id_store lỗi: ${(err as Error).message}`));
      void apply(true);
    },
    onReaction: (r: ChannelReaction) => {
      void upsertInboxReaction(db, ctx, ch.id, {
        threadId: r.threadId,
        msgId: r.targetMsgId,
        reactorId: r.reactorId,
        reactorName: r.reactorName,
        icon: r.icon,
        source: r.source,
        webUserId: r.webUserId ?? null,
      })
        .then((reactions) =>
          broadcast(ch.workspaceId, ch.id, "reaction", { channelId: ch.id, threadId: r.threadId, msgId: r.targetMsgId, reactions }),
        )
        .catch((err) => logger.warn(`zalo.reaction_store lỗi: ${(err as Error).message}`));
    },
  };
}

/**
 * Thả/gỡ cảm xúc vào 1 tin đã lưu (Inbox + MCP). Lỗi rõ ràng:
 * NOT_CONNECTED / MESSAGE_NOT_FOUND / CANNOT_REACT.
 */
export async function reactInboxMessage(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    channelId: string;
    threadId: string;
    messageId: string;
    reaction: ZaloReactionKey;
    source: "web" | "mcp";
    webUserId?: string;
  },
): Promise<void> {
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  const rt = inboxRuntime(input.channelId);
  if (!rt?.isConnected()) throw err("NOT_CONNECTED", `Kênh ${platformOf(input.channelId)} chưa kết nối — vào Channels → Kết nối QR để quét lại.`);
  const msg = await getInboxMessageById(db, ctx, input.channelId, input.threadId, input.messageId);
  if (!msg) throw err("MESSAGE_NOT_FOUND", "Không có tin nhắn này trong hội thoại.");
  const cli = typeof msg.meta?.cliMsgId === "string" ? msg.meta.cliMsgId : "";
  const needCli = rt.kind === "zalo_personal";
  if (!msg.msgId || (needCli ? !cli : !msg.meta?.waKey)) throw err("CANNOT_REACT", "Tin này không thả cảm xúc được (tin lưu trước bản 1.5.0 hoặc tin do hệ thống gửi).");
  const thread = await getInboxThread(db, ctx, input.channelId, input.threadId);
  await rt.react({
    threadId: input.threadId,
    peerKind: thread?.kind ?? "direct",
    msgId: msg.msgId,
    cliMsgId: cli,
    meta: msg.meta ?? null,
    reaction: input.reaction,
    source: input.source,
    ...(input.webUserId ? { webUserId: input.webUserId } : {}),
  });
}

export { latestIncomingInboxMessages, ZALO_REACTIONS, isZaloReactionKey };

export function forgetInboxChannel(channelId: string): void {
  inboxState.delete(channelId);
}

// ===== Quyền truy cập kênh =====

/** Kênh zalo_personal người này được trực: operator trở lên = mọi kênh; member = kênh được gán; viewer = không. */
export async function allowedInboxChannelIds(db: Db, ctx: WorkspaceContext): Promise<string[]> {
  if (hasRole(ctx.role, "operator")) {
    return (await listChannels(db, ctx)).filter((c) => isPersonalChannelKind(c.kind)).map((c) => c.id);
  }
  if (ctx.role === "member") return listUserInboxChannelIds(db, ctx, ctx.userId);
  return [];
}

export async function canUseInboxChannel(db: Db, ctx: WorkspaceContext, channelId: string): Promise<boolean> {
  return (await allowedInboxChannelIds(db, ctx)).includes(channelId);
}

// ===== Ảnh: nạp từ data URL hoặc URL công khai (chống SSRF) =====

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number) as [number, number, number, number];
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith("::ffff:")) return isBlockedIp(low.slice(7));
    return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
  }
  return true;
}

/** Nhận diện ảnh theo byte đầu (không tin content-type). */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

export class ImageInputError extends Error {}

/**
 * Ảnh đầu vào: `data:image/...;base64,...` hoặc URL http(s) công khai.
 * URL: chặn IP nội bộ (kiểm lại ở mỗi lần chuyển hướng, tối đa 3), ≤ 10 MB,
 * nội dung phải là PNG/JPEG/GIF/WEBP thật.
 */
export async function loadImageInput(src: string): Promise<{ buf: Buffer; ext: string; mime: string }> {
  const value = src.trim();
  let buf: Buffer;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    const head = value.slice(0, comma);
    if (comma < 0 || !/^data:image\/[a-z0-9.+-]+;base64$/i.test(head)) {
      throw new ImageInputError("Ảnh base64 phải có dạng data:image/<loại>;base64,<dữ liệu>");
    }
    buf = Buffer.from(value.slice(comma + 1), "base64");
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ImageInputError("image_url không phải URL hợp lệ");
    }
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new ImageInputError("Chỉ nhận ảnh qua http/https");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (!ips.length || ips.some((i) => isBlockedIp(i.address))) {
        throw new ImageInputError("Từ chối: địa chỉ ảnh trỏ tới mạng nội bộ");
      }
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        res = null;
        continue;
      }
      break;
    }
    if (!res) throw new ImageInputError("Ảnh chuyển hướng quá nhiều lần");
    if (!res.ok) throw new ImageInputError(`Không tải được ảnh (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) throw new ImageInputError("Ảnh vượt 10 MB");
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (!buf.length) throw new ImageInputError("Ảnh rỗng");
  if (buf.length > IMAGE_MAX_BYTES) throw new ImageInputError("Ảnh vượt 10 MB");
  const kind = sniffImage(buf);
  if (!kind) throw new ImageInputError("Chỉ hỗ trợ ảnh PNG, JPEG, GIF, WEBP");
  return { buf, ...kind };
}

/** Lưu ảnh gửi đi vào thư mục inbox của kênh (để gửi Zalo + hiển thị lại). */
export async function saveOutboundImage(
  dataDir: string,
  workspaceId: string,
  channelId: string,
  img: { buf: Buffer; ext: string },
): Promise<string> {
  const month = new Date().toISOString().slice(0, 7);
  const dir = resolve(join(dataDir, workspaceId, "zalo-inbox", channelId, month));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${img.ext}`);
  await writeFile(path, img.buf);
  return path;
}

/** Media cho trình duyệt: bỏ đường dẫn tuyệt đối, thay bằng đường dẫn tương đối trong workspace. */
function publicMessage(m: InboxMessageRow, workspaceId: string): InboxMessageRow {
  if (!m.media || typeof m.media.localPath !== "string") return m;
  const { localPath, ...rest } = m.media as { localPath: string } & Record<string, unknown>;
  const ws = resolve(join(inboxDataDir, workspaceId));
  const rel = relative(ws, resolve(localPath));
  const file = rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) ? rel.split(sep).join("/") : undefined;
  return { ...m, media: { ...rest, ...(file ? { file } : {}) } };
}

// ===== Gửi (dùng chung Inbox web + MCP) =====

export interface InboxSendRequest {
  channelId: string;
  workspaceId: string;
  threadId: string;
  peerKind: "direct" | "group";
  text?: string;
  image?: string;
  /** Ảnh đã nạp + lưu sẵn (prepareOutboundImage) — MCP kiểm tra ảnh trước khi chiếm lượt gửi. */
  filePaths?: string[];
  source: ZaloSendSource;
  webUserId?: string;
  threadName?: string;
}

/** Nạp + kiểm tra + lưu ảnh gửi đi. Lỗi → ImageInputError (chưa gửi gì). */
export async function prepareOutboundImage(
  dataDir: string,
  workspaceId: string,
  channelId: string,
  src: string,
): Promise<string> {
  const img = await loadImageInput(src);
  return saveOutboundImage(dataDir, workspaceId, channelId, img);
}

/** Lỗi do Zalo trả về (tham số sai, bị chặn…) → chắc chắn tin CHƯA gửi. */
export function isPlatformRejected(err: unknown): boolean {
  const e = err as { name?: string; zaloRejected?: boolean } | null;
  return !!e && (e.name === "ZcaApiError" || e.zaloRejected === true);
}

export async function sendInbox(dataDir: string, req: InboxSendRequest): Promise<{ msgIds: string[] }> {
  const runtime = inboxRuntime(req.channelId);
  if (!runtime || !runtime.isConnected()) {
    const err = new Error(`Kênh ${platformOf(req.channelId)} chưa kết nối — vào Channels → Kết nối QR để quét lại.`) as Error & { code?: string };
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const filePaths: string[] = [...(req.filePaths ?? [])];
  if (req.image) {
    filePaths.push(await prepareOutboundImage(dataDir, req.workspaceId, req.channelId, req.image));
  }
  const msgIds = await runtime.sendManual({
    threadId: req.threadId,
    peerKind: req.peerKind,
    ...(req.text ? { text: req.text } : {}),
    ...(filePaths.length ? { filePaths } : {}),
    source: req.source,
    ...(req.webUserId ? { webUserId: req.webUserId } : {}),
    ...(req.threadName ? { threadName: req.threadName } : {}),
  });
  return { msgIds };
}

export function inboxRuntimeFor(channelId: string): PersonalChannel | null {
  return inboxRuntime(channelId);
}

// ===== Routes =====

const SendBody = z
  .object({
    text: z.string().max(10_000).optional(),
    image: z.string().max(15_000_000).optional(),
    peerKind: z.enum(["direct", "group"]).optional(),
  })
  .refine((v) => (v.text && v.text.trim()) || v.image, { message: "Cần nội dung hoặc ảnh" });

const NewMessageBody = z
  .object({
    to: z.string().regex(/^[0-9A-Za-z@.-]{1,64}$/).optional(),
    phone: z.string().regex(/^\+?\d{8,15}$/).optional(),
    peerKind: z.enum(["direct", "group"]).default("direct"),
    text: z.string().max(10_000).optional(),
    image: z.string().max(15_000_000).optional(),
  })
  .refine((v) => v.to || v.phone, { message: "Cần uid (to) hoặc số điện thoại" })
  .refine((v) => (v.text && v.text.trim()) || v.image, { message: "Cần nội dung hoặc ảnh" });

const AiBody = z.object({ mode: z.enum(["auto", "off"]).optional(), resume: z.boolean().optional() });
const InboxSettingsBody = z.object({
  enabled: z.boolean().optional(),
  pauseMinutes: z.number().int().min(0).max(1440).optional(),
  mcpReadMessages: z.boolean().optional(),
  autoReaction: z.enum(["off", "heart", "like"]).optional(),
  photoAck: z.enum(["short", "off"]).optional(),
});

const ReactBody = z.object({ reaction: z.enum(["heart", "like", "haha", "wow", "cry", "angry", "none"]) });

function sendError(reply: FastifyReply, err: unknown, channelId: string) {
  const e = err as Error & { code?: string };
  const label = platformOf(channelId);
  if (e instanceof ImageInputError) return reply.code(400).send({ error: e.message });
  if (e.code === "NOT_CONNECTED") return reply.code(409).send({ error: e.message, code: "NOT_CONNECTED" });
  if (isPlatformRejected(e)) return reply.code(422).send({ error: `${label} từ chối: ${e.message}`, code: `${label.toUpperCase()}_REJECTED` });
  logger.warn(`zalo.inbox_send lỗi: ${e.message}`);
  return reply.code(502).send({ error: `Gửi ${label} lỗi: ${e.message}` });
}

export function registerInboxRoutes(app: FastifyInstance, deps: { db: Db; dataDir: string }): void {
  const { db, dataDir } = deps;
  inboxDataDir = dataDir;

  async function guard(req: FastifyRequest, reply: FastifyReply, channelId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(channelId) || !(await canUseInboxChannel(db, req.authCtx, channelId))) {
      void reply.code(403).send({ error: "Bạn không được trực kênh này" });
      return false;
    }
    return true;
  }

  const kindOf = (channelId: string): string => channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal";

  // /v1/inbox/… là địa chỉ chung; /v1/zalo-inbox/… giữ nguyên cho tích hợp đã có (cùng một bộ xử lý)
  for (const base of ["/v1/inbox", "/v1/zalo-inbox"]) {
  // Kênh được trực + trạng thái kết nối
  app.get(`${base}/channels`, async (req) => {
    const ids = await allowedInboxChannelIds(db, req.authCtx);
    const all = (await listChannels(db, req.authCtx)).filter((c) => ids.includes(c.id));
    return {
      channels: all.map((c) => {
        const rt = inboxRuntime(c.id);
        const cfg = readInboxConfig((c.config as Record<string, unknown>) ?? {});
        return {
          id: c.id,
          kind: c.kind,
          platform: personalPlatformLabel(c.kind),
          name: c.name,
          enabled: c.enabled,
          connected: rt?.isConnected() ?? false,
          account: rt?.accountInfo() ?? null,
          inbox: cfg.enabled,
          pauseMinutes: cfg.pauseMinutes,
          mcpReadMessages: cfg.mcpReadMessages,
          autoReaction: cfg.autoReaction,
          agentReply: cfg.agentReply,
          photoAck: cfg.photoAck,
        };
      }),
      canManage: hasRole(req.authCtx.role, "operator"),
    };
  });

  // Realtime
  app.get(`${base}/events`, async (req, reply) => {
    const ids = await allowedInboxChannelIds(db, req.authCtx);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write("event: ready\ndata: {}\n\n");
    const client: SseClient = {
      workspaceId: req.authCtx.workspaceId,
      channelIds: hasRole(req.authCtx.role, "operator") ? null : new Set(ids),
      write: (chunk) => raw.write(chunk),
    };
    sseClients.add(client);
    req.raw.on("close", () => sseClients.delete(client));
  });

  app.get(`${base}/:channelId/threads`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const q = req.query as { q?: string; kind?: string; unread?: string; limit?: string; offset?: string; all?: string };
    const res = await listInboxThreads(db, req.authCtx, channelId, {
      ...(q.q ? { q: q.q.slice(0, 100) } : {}),
      ...(q.kind === "direct" || q.kind === "group" ? { kind: q.kind } : {}),
      unreadOnly: q.unread === "1",
      // Không tìm kiếm → chỉ hội thoại đã có tin; tìm kiếm → cả danh bạ chưa chat
      withMessagesOnly: !q.q && q.all !== "1",
      limit: Number(q.limit) || 100,
      offset: Number(q.offset) || 0,
    });
    return res;
  });

  app.get(`${base}/:channelId/threads/:threadId/messages`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const q = req.query as { before?: string; limit?: string };
    const [thread, messages] = await Promise.all([
      getInboxThread(db, req.authCtx, channelId, threadId),
      listInboxMessages(db, req.authCtx, channelId, threadId, {
        ...(q.before ? { beforeId: q.before } : {}),
        limit: Number(q.limit) || 50,
      }),
    ]);
    return { thread, messages: messages.map((m) => publicMessage(m, req.authCtx.workspaceId)) };
  });

  app.post(`${base}/:channelId/threads/:threadId/read`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    await markInboxThreadRead(db, req.authCtx, channelId, threadId);
    return { ok: true };
  });

  app.post(`${base}/:channelId/threads/:threadId/send`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!isValidThreadId(kindOf(channelId), threadId)) return reply.code(400).send({ error: "Mã hội thoại không hợp lệ" });
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const thread = await getInboxThread(db, req.authCtx, channelId, threadId);
    const peerKind = thread?.kind ?? parsed.data.peerKind ?? "direct";
    try {
      const out = await sendInbox(dataDir, {
        channelId,
        workspaceId: req.authCtx.workspaceId,
        threadId,
        peerKind,
        ...(parsed.data.text?.trim() ? { text: parsed.data.text } : {}),
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        source: "web",
        webUserId: req.authCtx.userId,
      });
      return { sent: true, msgIds: out.msgIds };
    } catch (err) {
      return sendError(reply, err, channelId);
    }
  });

  // Nhắn tin mới cho uid/SĐT chưa có trong danh sách
  app.post(`${base}/:channelId/new`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = NewMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    let threadId = parsed.data.to ?? "";
    let peerKind = parsed.data.peerKind;
    let threadName = "";
    if (!threadId && parsed.data.phone) {
      const user = await rt.findUserByPhone(parsed.data.phone).catch(() => null);
      if (!user) return reply.code(404).send({ error: `Không tìm thấy tài khoản ${platformOf(channelId)} với số này (hoặc người đó chặn tìm kiếm)` });
      threadId = user.uid;
      threadName = user.name;
      peerKind = "direct";
    } else {
      if (!isValidThreadId(kindOf(channelId), threadId)) return reply.code(400).send({ error: "Mã người nhận không hợp lệ" });
      const known = await getInboxThread(db, req.authCtx, channelId, threadId);
      if (known) peerKind = known.kind;
      else if (threadId.endsWith("@g.us")) peerKind = "group";
    }
    try {
      await sendInbox(dataDir, {
        channelId,
        workspaceId: req.authCtx.workspaceId,
        threadId,
        peerKind,
        ...(parsed.data.text?.trim() ? { text: parsed.data.text } : {}),
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        source: "web",
        webUserId: req.authCtx.userId,
        ...(threadName ? { threadName } : {}),
      });
      return { sent: true, threadId, peerKind };
    } catch (err) {
      return sendError(reply, err, channelId);
    }
  });

  app.get(`${base}/:channelId/find-phone`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const phone = String((req.query as { phone?: string }).phone ?? "").trim();
    if (!/^\+?\d{8,15}$/.test(phone)) return reply.code(400).send({ error: "Số điện thoại không hợp lệ" });
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    const user = await rt.findUserByPhone(phone).catch(() => null);
    return { found: !!user, user };
  });

  app.put(`${base}/:channelId/threads/:threadId/ai`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = AiBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const existing = await getInboxThread(db, req.authCtx, channelId, threadId);
    const thread = await setInboxThreadAi(db, req.authCtx, channelId, threadId, {
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.resume ? { resume: true } : {}),
      kind: existing?.kind ?? "direct",
    });
    if (thread) broadcast(req.authCtx.workspaceId, channelId, "thread", { channelId, thread });
    return { thread };
  });

  // Đồng bộ danh bạ ngay (operator trở lên)
  app.post(`${base}/:channelId/sync-contacts`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền operator trở lên" });
    if (!(await guard(req, reply, channelId))) return;
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    try {
      return await rt.syncContacts();
    } catch (err) {
      return reply.code(502).send({ error: `Đồng bộ danh bạ lỗi: ${(err as Error).message}` });
    }
  });

  // Nhân viên thả / gỡ cảm xúc vào tin trong Inbox
  app.post(`${base}/:channelId/threads/:threadId/messages/:messageId/react`, async (req, reply) => {
    const { channelId, threadId, messageId } = req.params as { channelId: string; threadId: string; messageId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = ReactBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Cảm xúc không hợp lệ" });
    try {
      await reactInboxMessage(db, req.authCtx, {
        channelId,
        threadId,
        messageId,
        reaction: parsed.data.reaction,
        source: "web",
        webUserId: req.authCtx.userId,
      });
      return { ok: true };
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "NOT_CONNECTED") return reply.code(409).send({ error: e.message, code: e.code });
      if (e.code === "MESSAGE_NOT_FOUND") return reply.code(404).send({ error: e.message, code: e.code });
      if (e.code === "CANNOT_REACT") return reply.code(422).send({ error: e.message, code: e.code });
      logger.warn(`zalo.inbox_react lỗi: ${e.message}`);
      return reply.code(502).send({ error: `${platformOf(channelId)} lỗi khi thả cảm xúc: ${e.message}` });
    }
  });

  // Bật/tắt lưu nội dung + số phút AI tạm im sau khi nhân viên trả lời (ws_admin)
  app.put(`${base}/:channelId/settings`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!hasRole(req.authCtx.role, "ws_admin")) return reply.code(403).send({ error: "Cần quyền quản trị" });
    const parsed = InboxSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const row = await getChannelById(db, req.authCtx, channelId);
    if (!row || !isPersonalChannelKind(row.kind)) return reply.code(404).send({ error: "Không có kênh cá nhân này" });
    const config = { ...((row.config as Record<string, unknown>) ?? {}) };
    if (parsed.data.enabled !== undefined) config["inbox"] = parsed.data.enabled;
    if (parsed.data.pauseMinutes !== undefined) config["inbox_pause_minutes"] = parsed.data.pauseMinutes;
    if (parsed.data.mcpReadMessages !== undefined) config["mcp_read_messages"] = parsed.data.mcpReadMessages;
    if (parsed.data.autoReaction !== undefined) config["auto_reaction"] = parsed.data.autoReaction;
    if (parsed.data.photoAck !== undefined) config["photo_ack"] = parsed.data.photoAck;
    await updateChannel(db, req.authCtx, channelId, { config });
    const cfg = readInboxConfig(config);
    // Đặt "số phút AI tạm im" về 0 = không tạm dừng nữa → gỡ luôn các lượt tạm dừng đang treo,
    // nếu không hội thoại vừa có người trả lời vẫn im tới hết giờ cũ.
    if (parsed.data.pauseMinutes === 0) {
      const cleared = await clearInboxPauses(db, req.authCtx, channelId);
      if (cleared) broadcast(req.authCtx.workspaceId, channelId, "contacts", { channelId, count: cleared });
    }
    const st = inboxState.get(channelId);
    if (st) Object.assign(st, { enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes });
    inboxRuntime(channelId)?.setAutoReaction(cfg.autoReaction);
    await recordAudit(db, req.authCtx, "zalo_inbox.settings", { channelId, ...cfg });
    return cfg;
  });

  // File/ảnh đã gửi (lưu trong workspace) — chỉ người trực kênh
  app.get(`${base}/:channelId/file`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const p = String((req.query as { p?: string }).p ?? "");
    const ws = resolve(join(dataDir, req.authCtx.workspaceId));
    const abs = resolve(ws, p);
    if (!p || !abs.startsWith(ws + sep)) return reply.code(400).send({ error: "Đường dẫn không hợp lệ" });
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > 50 * 1024 * 1024) return reply.code(404).send({ error: "Không tìm thấy file" });
    const buf = await readFile(abs);
    const img = sniffImage(buf);
    const name = abs.split(sep).pop() ?? "file";
    return reply
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `${img ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type(img ? img.mime : "application/octet-stream")
      .send(buf);
  });
  }
}

export type { InboxThread };
