/**
 * Inbox trực chat dùng chung cho các kênh có Inbox (Zalo cá nhân, WhatsApp cá nhân,
 * Facebook Fanpage, Instagram Business) — 0031, 0034.
 *
 * - Adapter của kênh báo MỌI tin đến/đi (onMessageLog) → lưu inbox_messages
 *   + inbox_threads → đẩy realtime (SSE) cho người đang trực.
 * - Người trực (operator trở lên: mọi kênh; member: kênh được gán) xem hội thoại,
 *   gửi text/ảnh, bật/tắt AI theo hội thoại. Nhân viên trả lời (web hoặc điện
 *   thoại) → AI tạm im trong hội thoại đó `inbox_pause_minutes` phút (mặc định 30).
 * - Dùng chung cho MCP server (mcp-server.ts): gửi tin/ảnh, tra SĐT, danh bạ.
 * - Phân công hội thoại (0040, tùy chọn): member có phạm vi `assigned` trên một kênh chỉ thấy/trả lời
 *   hội thoại được giao; operator trở lên giao tay, hoặc bật chia tự động xoay vòng cho khách mới
 *   (`inbox_auto_assign`, mặc định tắt). Member phạm vi `all` và operator trở lên: như trước.
 *
 * Cấu hình theo kênh (channels.config): `inbox` (mặc định true — lưu nội dung),
 * `inbox_pause_minutes` (mặc định 30, 0 = không tạm dừng).
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  autoAssignInboxThread,
  inboxThreadsOfFile,
  listInboxChannelStaff,
  listInboxThreadAssignees,
  listUserInboxChannelScopes,
  setInboxThreadAssignees,
  type Db,
  type InboxAssignee,
  type InboxMessageRow,
  type InboxScope,
  type InboxThread,
} from "@penai/db";
import {
  isPersonalChannel,
  isInboxChannel,
  isInboxChannelKind,
  inboxCapabilitiesOf,
  inboxPlatformLabel,
  isValidThreadId,
  type InboxChannel,
  type PersonalChannel,
  MetaPageChannel,
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
  /** Chia tự động xoay vòng khách mới cho nhân viên "chỉ hội thoại được giao" (mặc định tắt) */
  autoAssign: boolean;
}

const inboxState = new Map<string, InboxChannelState>();
let inboxDataDir = "";

export function readInboxConfig(config: Record<string, unknown>, kind = ""): {
  enabled: boolean;
  pauseMinutes: number;
  mcpReadMessages: boolean;
  autoReaction: "heart" | "like" | null;
  agentReply: boolean;
  photoAck: "short" | "off" | "ai";
  /** Fanpage/Instagram: nhận bình luận, AI trả lời công khai, AI nhắn riêng (mặc định bật cả ba) */
  comments: boolean;
  commentAiPublic: boolean;
  commentAiPrivate: boolean;
  /** Khách mới (tin riêng) chưa ai phụ trách → tự chia xoay vòng. MẶC ĐỊNH TẮT (quản trị giao tay). */
  autoAssign: boolean;
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
    photoAck: readPhotoAcknowledgement(config, kind),
    comments: config["comments"] !== false,
    commentAiPublic: config["comment_ai_public"] !== false,
    commentAiPrivate: config["comment_ai_private"] !== false,
    autoAssign: config["inbox_auto_assign"] === true,
  };
}

// ===== SSE: đẩy tin mới cho người đang trực =====

interface SseClient {
  workspaceId: string;
  userId: string;
  /** null = mọi kênh (operator trở lên) */
  channelIds: Set<string> | null;
  /** Kênh mà người này chỉ được xem hội thoại được giao */
  restricted: Set<string>;
  write: (chunk: string) => void;
  close: () => void;
}

const sseClients = new Set<SseClient>();

/**
 * Ai nhận sự kiện của một kênh:
 * - "unrestricted": chỉ người thấy mọi hội thoại của kênh (sự kiện không gắn hội thoại cụ thể)
 * - "all": mọi người trực kênh (sự kiện không chứa nội dung, vd "phân công vừa đổi")
 * - Set userId: người thấy mọi hội thoại + người bị giới hạn có tên trong danh sách được giao
 */
type Audience = "unrestricted" | "all" | Set<string>;

function broadcast(workspaceId: string, channelId: string, event: string, data: unknown, audience: Audience = "unrestricted"): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.workspaceId !== workspaceId) continue;
    if (c.channelIds && !c.channelIds.has(channelId)) continue;
    if (c.restricted.has(channelId) && audience !== "all" && (audience === "unrestricted" || !audience.has(c.userId))) continue;
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

/** Ngắt kết nối realtime của một người (quyền Inbox vừa đổi) — trình duyệt tự nối lại với quyền mới. */
export function dropInboxSseForUser(userId: string): void {
  for (const c of sseClients) {
    if (c.userId !== userId) continue;
    sseClients.delete(c);
    try {
      c.close();
    } catch {
      /* đã đóng */
    }
  }
}

// ===== Người được giao theo hội thoại (bộ nhớ đệm ngắn, xóa ngay khi phân công đổi) =====

const assigneeCache = new Map<string, { at: number; list: InboxAssignee[] }>();
const ASSIGNEE_TTL_MS = 30_000;
setInterval(() => {
  const cut = Date.now() - ASSIGNEE_TTL_MS;
  for (const [k, v] of assigneeCache) if (v.at < cut) assigneeCache.delete(k);
}, 60_000).unref();

async function assigneesOf(db: Db, workspaceId: string, channelId: string, threadId: string): Promise<InboxAssignee[]> {
  const key = `${channelId}:${threadId}`;
  const hit = assigneeCache.get(key);
  if (hit && Date.now() - hit.at < ASSIGNEE_TTL_MS) return hit.list;
  const list = await listInboxThreadAssignees(db, ctxOf(workspaceId), channelId, threadId);
  assigneeCache.set(key, { at: Date.now(), list });
  return list;
}

/** Quên bộ nhớ đệm người được giao: của vài hội thoại, hoặc cả kênh (không truyền threadIds). */
export function forgetInboxAssignees(channelId: string, threadIds?: string[]): void {
  if (threadIds) {
    for (const t of threadIds) assigneeCache.delete(`${channelId}:${t}`);
    return;
  }
  for (const k of assigneeCache.keys()) if (k.startsWith(`${channelId}:`)) assigneeCache.delete(k);
}

/** Đẩy sự kiện của MỘT hội thoại: gắn người được giao vào `thread`, chỉ gửi cho người được xem hội thoại đó. */
async function emitThread(
  db: Db,
  workspaceId: string,
  channelId: string,
  threadId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const list = await assigneesOf(db, workspaceId, channelId, threadId).catch(() => [] as InboxAssignee[]);
  const thread = data["thread"] as InboxThread | undefined;
  broadcast(workspaceId, channelId, event, thread ? { ...data, thread: { ...thread, assignees: list } } : data, new Set(list.map((x) => x.userId)));
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

/** Kênh có Inbox đang chạy (cá nhân hoặc Trang Meta). */
function inboxRuntime(channelId: string): InboxChannel | null {
  const ch = channelHandlers.get(channelId)?.channel;
  return isInboxChannel(ch) ? ch : null;
}

/** Kênh tài khoản cá nhân đang chạy (Zalo, WhatsApp) — tính năng riêng: danh bạ, tra SĐT, cảm xúc. */
function personalRuntime(channelId: string): PersonalChannel | null {
  const ch = channelHandlers.get(channelId)?.channel;
  return isPersonalChannel(ch) ? ch : null;
}

/** Tên nền tảng của kênh (Zalo, WhatsApp, Facebook, Instagram) để ghi vào thông báo cho người dùng. */
function platformOf(channelId: string): string {
  return inboxPlatformLabel(channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal");
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

/** Hook onMessageLog / onContactsSynced / onThreadName… cho 1 kênh có Inbox. */
export function inboxHooks(
  db: Db,
  ch: { id: string; kind: string; workspaceId: string; config: Record<string, unknown> },
  dataDir: string,
) {
  const cfg = readInboxConfig(ch.config, ch.kind);
  inboxState.set(ch.id, { workspaceId: ch.workspaceId, enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes, autoAssign: cfg.autoAssign });
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
        // Khách (tin riêng) chưa ai phụ trách + kênh bật chia tự động → giao xoay vòng TRƯỚC khi đẩy tin,
        // để người vừa được giao nhận luôn tin này.
        if (st.autoAssign && entry.direction === "in" && entry.peerKind === "direct" && !entry.threadId.startsWith("post:")) {
          const who = await autoAssignInboxThread(db, ctx, ch.id, entry.threadId).catch((err) => {
            logger.warn(`inbox.auto_assign lỗi: ${(err as Error).message}`);
            return null;
          });
          if (who) {
            forgetInboxAssignees(ch.id, [entry.threadId]);
            broadcast(ch.workspaceId, ch.id, "assign", { channelId: ch.id, threadIds: [entry.threadId] }, "all");
          }
        }
        await emitThread(db, ch.workspaceId, ch.id, entry.threadId, "message", {
          channelId: ch.id,
          thread: saved.thread,
          message: publicMessage(saved.message, ch.workspaceId),
        });
        // Nhóm chưa có tên → tra 1 lần
        const key = `${ch.id}:${entry.threadId}`;
        if (entry.peerKind === "group" && !saved.thread.name && !groupNameLookups.has(key)) {
          groupNameLookups.add(key);
          const name = await personalRuntime(ch.id)?.lookupGroupName(entry.threadId);
          if (name) {
            await setInboxThreadName(db, ctx, ch.id, entry.threadId, name);
            recordInboxContact(db, ctx, ch.id, ch.kind, entry.threadId, name, "group");
            await emitThread(db, ch.workspaceId, ch.id, entry.threadId, "thread", { channelId: ch.id, thread: { ...saved.thread, name } });
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
    // Trang Meta: tên + ảnh đại diện của khách → hội thoại trong Inbox (không báo "đã đồng bộ")
    onPeerProfile: (p: { threadId: string; name: string; avatar?: string }) => {
      recordInboxContact(db, ctx, ch.id, ch.kind, p.threadId, p.name, "user");
      void upsertInboxContacts(db, ctx, ch.id, [{ threadId: p.threadId, kind: "direct", name: p.name, ...(p.avatar ? { avatar: p.avatar } : {}) }])
        .then(async () => {
          const thread = await getInboxThread(db, ctx, ch.id, p.threadId);
          if (thread) await emitThread(db, ch.workspaceId, ch.id, p.threadId, "thread", { channelId: ch.id, thread });
        })
        .catch((err) => logger.warn(`inbox.peer_profile lỗi: ${(err as Error).message}`));
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
            if (m) void emitThread(db, ch.workspaceId, ch.id, m.threadId, "message_update", { channelId: ch.id, threadId: m.threadId, message: publicMessage(m, ch.workspaceId) });
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
          emitThread(db, ch.workspaceId, ch.id, r.threadId, "reaction", { channelId: ch.id, threadId: r.threadId, msgId: r.targetMsgId, reactions }),
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
  if (inboxRuntime(input.channelId) && !personalRuntime(input.channelId)) {
    throw err("CANNOT_REACT", `${platformOf(input.channelId)} chưa hỗ trợ thả cảm xúc từ PenAI.`);
  }
  const rt = personalRuntime(input.channelId);
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
  forgetInboxAssignees(channelId);
}

// ===== Quyền truy cập kênh =====

/**
 * Kênh có Inbox người này được trực kèm phạm vi: operator trở lên = mọi kênh, mọi hội thoại;
 * member = kênh được gán, phạm vi `all` (mọi hội thoại) hoặc `assigned` (chỉ hội thoại được giao); viewer = không.
 */
export async function inboxChannelScopes(db: Db, ctx: WorkspaceContext): Promise<Map<string, InboxScope>> {
  if (hasRole(ctx.role, "operator")) {
    return new Map((await listChannels(db, ctx)).filter((c) => isInboxChannelKind(c.kind)).map((c) => [c.id, "all" as InboxScope]));
  }
  if (ctx.role === "member") {
    return new Map((await listUserInboxChannelScopes(db, ctx, ctx.userId)).map((r) => [r.channelId, r.scope]));
  }
  return new Map();
}

/** Kênh có Inbox người này được trực (kể cả kênh chỉ được xem hội thoại được giao). */
export async function allowedInboxChannelIds(db: Db, ctx: WorkspaceContext): Promise<string[]> {
  return [...(await inboxChannelScopes(db, ctx)).keys()];
}

/**
 * Kênh người này thấy MỌI hội thoại. Dùng cho MCP server: ứng dụng AI bên ngoài tra danh bạ, đọc và
 * gửi tin trên cả kênh, nên người chỉ được giao một số hội thoại không dùng kênh đó qua MCP.
 */
export async function fullInboxChannelIds(db: Db, ctx: WorkspaceContext): Promise<string[]> {
  return [...(await inboxChannelScopes(db, ctx))].filter(([, scope]) => scope === "all").map(([id]) => id);
}

export async function canUseInboxChannel(db: Db, ctx: WorkspaceContext, channelId: string): Promise<boolean> {
  return (await inboxChannelScopes(db, ctx)).has(channelId);
}

/** Người này được xem/trả lời hội thoại này không (kênh được trực + nếu bị giới hạn thì phải được giao). */
export async function canUseInboxThread(db: Db, ctx: WorkspaceContext, channelId: string, threadId: string): Promise<boolean> {
  const scope = (await inboxChannelScopes(db, ctx)).get(channelId);
  if (!scope) return false;
  if (scope === "all") return true;
  return (await assigneesOf(db, ctx.workspaceId, channelId, threadId)).some((x) => x.userId === ctx.userId);
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
  /** Hội thoại bình luận: trả lời bình luận này / nhắn riêng người bình luận */
  comment?: { id: string; private?: boolean };
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

/** Kiểm tra đủ bộ trước khi gửi; ảnh lỗi thì dọn các file vừa chuẩn bị. */
export async function prepareOutboundImages(dataDir: string, workspaceId: string, channelId: string, sources: string[]): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const src of sources) paths.push(await prepareOutboundImage(dataDir, workspaceId, channelId, src));
    return paths;
  } catch (error) {
    await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
    if (error instanceof ImageInputError) throw new ImageInputError(`Ảnh ${paths.length + 1}/${sources.length}: ${error.message}`);
    throw error;
  }
}

/** Lỗi do Zalo trả về (tham số sai, bị chặn…) → chắc chắn tin CHƯA gửi. */
export function isPlatformRejected(err: unknown): boolean {
  const e = err as { name?: string; zaloRejected?: boolean; platformRejected?: boolean } | null;
  return !!e && (e.name === "ZcaApiError" || e.zaloRejected === true || e.platformRejected === true);
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
    ...(req.comment ? { comment: req.comment } : {}),
  });
  return { msgIds };
}

/** MCP server: chỉ kênh cá nhân (bộ công cụ zalo_… / whatsapp_…). */
export function inboxRuntimeFor(channelId: string): PersonalChannel | null {
  return personalRuntime(channelId);
}

// ===== Routes =====

const SendBody = z
  .object({
    text: z.string().max(10_000).optional(),
    image: z.string().max(15_000_000).optional(),
    peerKind: z.enum(["direct", "group"]).optional(),
    /** Hội thoại bình luận: id tin (trong Inbox) của bình luận cần trả lời */
    replyTo: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).optional(),
    /** true = nhắn riêng (Messenger/Direct) cho người viết bình luận replyTo */
    private: z.boolean().optional(),
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
  photoAck: z.enum(["short", "off", "ai"]).optional(),
  comments: z.boolean().optional(),
  commentAiPublic: z.boolean().optional(),
  commentAiPrivate: z.boolean().optional(),
  autoAssign: z.boolean().optional(),
});

const AssignBody = z.object({
  threadIds: z.array(z.string().min(1).max(80)).min(1).max(200),
  userIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).max(50),
  mode: z.enum(["set", "add"]).default("set"),
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

  /** Trả phạm vi của người gọi trên kênh (all / assigned); không được trực → trả lời 403 và trả null. */
  async function guard(req: FastifyRequest, reply: FastifyReply, channelId: string): Promise<InboxScope | null> {
    const scope = /^[0-9a-f-]{36}$/i.test(channelId) ? (await inboxChannelScopes(db, req.authCtx)).get(channelId) : undefined;
    if (!scope) {
      void reply.code(403).send({ error: "Bạn không được trực kênh này" });
      return null;
    }
    return scope;
  }

  const isAssignee = async (req: FastifyRequest, channelId: string, threadId: string): Promise<boolean> =>
    (await assigneesOf(db, req.authCtx.workspaceId, channelId, threadId)).some((x) => x.userId === req.authCtx.userId);

  /** Như guard + người bị giới hạn phải được giao hội thoại này. */
  async function guardThread(req: FastifyRequest, reply: FastifyReply, channelId: string, threadId: string): Promise<boolean> {
    const scope = await guard(req, reply, channelId);
    if (!scope) return false;
    if (scope === "assigned" && !(await isAssignee(req, channelId, threadId))) {
      void reply.code(403).send({ error: "Hội thoại này chưa được giao cho bạn", code: "THREAD_NOT_ASSIGNED" });
      return false;
    }
    return true;
  }

  const kindOf = (channelId: string): string => channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal";

  // /v1/inbox/… là địa chỉ chung; /v1/zalo-inbox/… giữ nguyên cho tích hợp đã có (cùng một bộ xử lý)
  for (const base of ["/v1/inbox", "/v1/zalo-inbox"]) {
  // Kênh được trực + trạng thái kết nối
  app.get(`${base}/channels`, async (req) => {
    const scopes = await inboxChannelScopes(db, req.authCtx);
    const all = (await listChannels(db, req.authCtx)).filter((c) => scopes.has(c.id));
    return {
      channels: all.map((c) => {
        const rt = inboxRuntime(c.id);
        const cfg = readInboxConfig((c.config as Record<string, unknown>) ?? {}, c.kind);
        return {
          id: c.id,
          kind: c.kind,
          platform: inboxPlatformLabel(c.kind),
          capabilities: inboxCapabilitiesOf(rt, c.kind),
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
          comments: cfg.comments,
          commentAiPublic: cfg.commentAiPublic,
          commentAiPrivate: cfg.commentAiPrivate,
          autoAssign: cfg.autoAssign,
          // all = thấy mọi hội thoại; assigned = chỉ hội thoại được giao
          scope: scopes.get(c.id) ?? "all",
        };
      }),
      canManage: hasRole(req.authCtx.role, "operator"),
    };
  });

  // Realtime
  app.get(`${base}/events`, async (req, reply) => {
    const scopes = await inboxChannelScopes(db, req.authCtx);
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
      userId: req.authCtx.userId,
      channelIds: hasRole(req.authCtx.role, "operator") ? null : new Set(scopes.keys()),
      restricted: new Set([...scopes].filter(([, sc]) => sc === "assigned").map(([id]) => id)),
      write: (chunk) => raw.write(chunk),
      close: () => raw.end(),
    };
    sseClients.add(client);
    req.raw.on("close", () => sseClients.delete(client));
  });

  app.get(`${base}/:channelId/threads`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const scope = await guard(req, reply, channelId);
    if (!scope) return;
    const q = req.query as { q?: string; kind?: string; unread?: string; limit?: string; offset?: string; all?: string; assign?: string };
    const res = await listInboxThreads(db, req.authCtx, channelId, {
      // Người bị giới hạn: chỉ hội thoại được giao. Người thấy hết: lọc "của tôi" / "chưa phân công" nếu muốn.
      ...(scope === "assigned" || q.assign === "mine" ? { assignedTo: req.authCtx.userId } : {}),
      ...(scope === "all" && q.assign === "none" ? { unassignedOnly: true } : {}),
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
    if (!(await guardThread(req, reply, channelId, threadId))) return;
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
    if (!(await guardThread(req, reply, channelId, threadId))) return;
    await markInboxThreadRead(db, req.authCtx, channelId, threadId);
    return { ok: true };
  });

  app.post(`${base}/:channelId/threads/:threadId/send`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guardThread(req, reply, channelId, threadId))) return;
    if (!isValidThreadId(kindOf(channelId), threadId)) return reply.code(400).send({ error: "Mã hội thoại không hợp lệ" });
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const thread = await getInboxThread(db, req.authCtx, channelId, threadId);
    const peerKind = thread?.kind ?? parsed.data.peerKind ?? "direct";
    let comment: { id: string; private?: boolean } | undefined;
    if (parsed.data.replyTo !== undefined) {
      const target = await getInboxMessageById(db, req.authCtx, channelId, threadId, String(parsed.data.replyTo));
      const cid = typeof target?.meta?.commentId === "string" ? target.meta.commentId : "";
      if (!cid) return reply.code(400).send({ error: "Tin được chọn không phải bình luận" });
      comment = { id: cid, ...(parsed.data.private ? { private: true } : {}) };
    } else if (parsed.data.private) {
      return reply.code(400).send({ error: "Nhắn riêng cần chọn một bình luận" });
    }
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
        ...(comment ? { comment } : {}),
      });
      return { sent: true, msgIds: out.msgIds };
    } catch (err) {
      return sendError(reply, err, channelId);
    }
  });

  // Nhắn tin mới cho uid/SĐT chưa có trong danh sách
  app.post(`${base}/:channelId/new`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const scope = await guard(req, reply, channelId);
    if (!scope) return;
    const parsed = NewMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    // Người chỉ được giao một số hội thoại: không tự mở hội thoại với người/nhóm chưa được giao, không tra theo SĐT
    if (scope === "assigned" && (!parsed.data.to || !(await isAssignee(req, channelId, parsed.data.to)))) {
      return reply.code(403).send({ error: "Người/nhóm này chưa được giao cho bạn — nhờ quản trị phân công trước.", code: "THREAD_NOT_ASSIGNED" });
    }
    if (inboxRuntime(channelId) && !personalRuntime(channelId)) {
      return reply.code(400).send({ error: `${platformOf(channelId)} chỉ cho Trang trả lời người đã nhắn tới — không nhắn tin mới được.` });
    }
    const rt = personalRuntime(channelId);
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
    const scope = await guard(req, reply, channelId);
    if (!scope) return;
    if (scope === "assigned") return reply.code(403).send({ error: "Bạn chỉ được trực các hội thoại được giao — không tra số điện thoại được." });
    const phone = String((req.query as { phone?: string }).phone ?? "").trim();
    if (!/^\+?\d{8,15}$/.test(phone)) return reply.code(400).send({ error: "Số điện thoại không hợp lệ" });
    const rt = personalRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    const user = await rt.findUserByPhone(phone).catch(() => null);
    return { found: !!user, user };
  });

  app.put(`${base}/:channelId/threads/:threadId/ai`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guardThread(req, reply, channelId, threadId))) return;
    const parsed = AiBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const existing = await getInboxThread(db, req.authCtx, channelId, threadId);
    const thread = await setInboxThreadAi(db, req.authCtx, channelId, threadId, {
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.resume ? { resume: true } : {}),
      kind: existing?.kind ?? "direct",
    });
    if (!thread) return { thread };
    const assignees = await assigneesOf(db, req.authCtx.workspaceId, channelId, threadId);
    await emitThread(db, req.authCtx.workspaceId, channelId, threadId, "thread", { channelId, thread });
    return { thread: { ...thread, assignees } };
  });

  // Đồng bộ danh bạ ngay (operator trở lên)
  app.post(`${base}/:channelId/sync-contacts`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền operator trở lên" });
    if (!(await guard(req, reply, channelId))) return;
    const rt = personalRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối hoặc không có danh bạ để đồng bộ`, code: "NOT_CONNECTED" });
    try {
      return await rt.syncContacts();
    } catch (err) {
      return reply.code(502).send({ error: `Đồng bộ danh bạ lỗi: ${(err as Error).message}` });
    }
  });

  // Nhân viên thả / gỡ cảm xúc vào tin trong Inbox
  app.post(`${base}/:channelId/threads/:threadId/messages/:messageId/react`, async (req, reply) => {
    const { channelId, threadId, messageId } = req.params as { channelId: string; threadId: string; messageId: string };
    if (!(await guardThread(req, reply, channelId, threadId))) return;
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
    if (!row || !isInboxChannelKind(row.kind)) return reply.code(404).send({ error: "Không có kênh Inbox này" });
    const config = { ...((row.config as Record<string, unknown>) ?? {}) };
    if (parsed.data.enabled !== undefined) config["inbox"] = parsed.data.enabled;
    if (parsed.data.pauseMinutes !== undefined) config["inbox_pause_minutes"] = parsed.data.pauseMinutes;
    if (parsed.data.mcpReadMessages !== undefined) config["mcp_read_messages"] = parsed.data.mcpReadMessages;
    if (parsed.data.autoReaction !== undefined) config["auto_reaction"] = parsed.data.autoReaction;
    if (parsed.data.photoAck !== undefined) config["photo_ack"] = parsed.data.photoAck;
    if (parsed.data.comments !== undefined) config["comments"] = parsed.data.comments;
    if (parsed.data.commentAiPublic !== undefined) config["comment_ai_public"] = parsed.data.commentAiPublic;
    if (parsed.data.commentAiPrivate !== undefined) config["comment_ai_private"] = parsed.data.commentAiPrivate;
    if (parsed.data.autoAssign !== undefined) config["inbox_auto_assign"] = parsed.data.autoAssign;
    await updateChannel(db, req.authCtx, channelId, { config });
    const cfg = readInboxConfig(config, row.kind);
    // Đặt "số phút AI tạm im" về 0 = không tạm dừng nữa → gỡ luôn các lượt tạm dừng đang treo,
    // nếu không hội thoại vừa có người trả lời vẫn im tới hết giờ cũ.
    if (parsed.data.pauseMinutes === 0) {
      const cleared = await clearInboxPauses(db, req.authCtx, channelId);
      if (cleared) broadcast(req.authCtx.workspaceId, channelId, "contacts", { channelId, count: cleared });
    }
    const st = inboxState.get(channelId);
    if (st) Object.assign(st, { enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes, autoAssign: cfg.autoAssign });
    personalRuntime(channelId)?.setAutoReaction(cfg.autoReaction);
    const metaRt = channelHandlers.get(channelId)?.channel;
    if (metaRt instanceof MetaPageChannel) metaRt.updateOptions(config);
    await recordAudit(db, req.authCtx, "zalo_inbox.settings", { channelId, ...cfg });
    return cfg;
  });

  // Nhân viên của kênh (để chọn khi phân công) — operator trở lên
  app.get(`${base}/:channelId/staff`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền operator trở lên" });
    if (!(await guard(req, reply, channelId))) return;
    return { staff: await listInboxChannelStaff(db, req.authCtx, channelId) };
  });

  // Giao hội thoại cho nhân viên (một hoặc nhiều hội thoại) — operator trở lên.
  // mode set: thay người được giao (userIds rỗng = bỏ phân công); add: giao thêm.
  app.post(`${base}/:channelId/assign`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền operator trở lên" });
    if (!(await guard(req, reply, channelId))) return;
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const { threadIds, userIds, mode } = parsed.data;
    if (threadIds.some((t) => !isValidThreadId(kindOf(channelId), t))) return reply.code(400).send({ error: "Mã hội thoại không hợp lệ" });
    if (mode === "add" && !userIds.length) return reply.code(400).send({ error: "Chọn ít nhất một nhân viên" });
    const used = await setInboxThreadAssignees(db, req.authCtx, channelId, threadIds, userIds, mode);
    if (userIds.length && !used.length) {
      return reply.code(400).send({ error: "Nhân viên được chọn chưa được gán trực kênh này (Người dùng → Sửa → tick kênh)." });
    }
    forgetInboxAssignees(channelId, threadIds);
    await recordAudit(db, req.authCtx, "inbox.assign", { channelId, threads: threadIds.length, userIds: used, mode });
    broadcast(req.authCtx.workspaceId, channelId, "assign", { channelId, threadIds }, "all");
    return { ok: true, userIds: used, threads: threadIds.length };
  });

  // File/ảnh đã gửi (lưu trong workspace) — chỉ người trực kênh
  app.get(`${base}/:channelId/file`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const scope = await guard(req, reply, channelId);
    if (!scope) return;
    const p = String((req.query as { p?: string }).p ?? "");
    const ws = resolve(join(dataDir, req.authCtx.workspaceId));
    const abs = resolve(ws, p);
    if (!p || !abs.startsWith(ws + sep)) return reply.code(400).send({ error: "Đường dẫn không hợp lệ" });
    // Nhân viên (member): chỉ tải được file gắn với một tin nhắn của kênh này — và nếu bị giới hạn
    // thì tin đó phải thuộc hội thoại được giao. (Operator trở lên vốn xem được file của workspace.)
    if (req.authCtx.role === "member") {
      const threads = await inboxThreadsOfFile(db, req.authCtx, channelId, abs);
      let ok = threads.length > 0 && scope === "all";
      for (const t of scope === "assigned" ? threads : []) {
        if (await isAssignee(req, channelId, t)) {
          ok = true;
          break;
        }
      }
      if (!ok) return reply.code(404).send({ error: "Không tìm thấy file" });
    }
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
