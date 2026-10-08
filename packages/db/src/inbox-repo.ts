import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

// ===== Inbox (0031, 0034): hội thoại + tin nhắn của các kênh cá nhân (Zalo, WhatsApp) =====

/** peer = người ngoài gửi tới (dữ liệu Zalo trước 1.9.0 ghi "zalo") */
export type InboxMessageSource = "zalo" | "peer" | "app" | "agent" | "web" | "mcp" | "api";

export interface InboxMessageInput {
  threadId: string;
  peerKind: "direct" | "group";
  msgId: string;
  direction: "in" | "out";
  source: InboxMessageSource;
  senderId: string;
  senderName: string;
  webUserId?: string | null;
  contentType: string;
  text: string;
  media?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  sentAt: Date;
  /** Tên hội thoại biết được lúc này (tên người gửi với DM đến, tên nhóm…) — rỗng = giữ nguyên. */
  threadName?: string;
}

export interface InboxThread {
  threadId: string;
  kind: "direct" | "group";
  name: string;
  avatar: string;
  phone: string;
  isContact: boolean;
  memberCount: number | null;
  lastMessage: string;
  lastMessageAt: string | null;
  lastDirection: string | null;
  unreadCount: number;
  aiMode: "auto" | "off";
  pausedUntil: string | null;
}

export interface InboxReactionRow {
  icon: string;
  reactorId: string;
  reactorName: string;
  source: string;
  webUserName: string | null;
}

export interface InboxMessageRow {
  id: string;
  threadId: string;
  msgId: string;
  direction: "in" | "out";
  source: InboxMessageSource;
  senderId: string;
  senderName: string;
  webUserId: string | null;
  webUserName: string | null;
  contentType: string;
  text: string;
  media: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  sentAt: string;
  /** Cảm xúc trên tin (chỉ có khi truy vấn kèm reactions). */
  reactions?: InboxReactionRow[];
  /** Thả cảm xúc được không (có đủ msgId + cliMsgId — tin lưu từ bản 1.5.0). */
  canReact?: boolean;
}

type Raw = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapThread(r: Raw): InboxThread {
  return {
    threadId: String(r.thread_id),
    kind: r.kind === "group" ? "group" : "direct",
    name: String(r.name ?? ""),
    avatar: String(r.avatar ?? ""),
    phone: String(r.phone ?? ""),
    isContact: r.is_contact === true,
    memberCount: r.member_count == null ? null : Number(r.member_count),
    lastMessage: String(r.last_message ?? ""),
    lastMessageAt: iso(r.last_message_at),
    lastDirection: (r.last_direction as string | null) ?? null,
    unreadCount: Number(r.unread_count ?? 0),
    aiMode: r.ai_mode === "off" ? "off" : "auto",
    pausedUntil: iso(r.paused_until),
  };
}

function mapReactions(v: unknown): InboxReactionRow[] {
  if (!Array.isArray(v)) return [];
  return (v as Raw[]).map((x) => ({
    icon: String(x.icon ?? ""),
    reactorId: String(x.reactor_id ?? ""),
    reactorName: String(x.reactor_name ?? ""),
    source: String(x.source ?? ""),
    webUserName: (x.web_user_name as string | null) ?? null,
  }));
}

function mapMessage(r: Raw): InboxMessageRow {
  const meta = (r.meta as Record<string, unknown> | null) ?? null;
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    msgId: String(r.msg_id ?? ""),
    direction: r.direction === "out" ? "out" : "in",
    source: String(r.source) as InboxMessageSource,
    senderId: String(r.sender_id ?? ""),
    senderName: String(r.sender_name ?? ""),
    webUserId: (r.web_user_id as string | null) ?? null,
    webUserName: (r.web_user_name as string | null) ?? null,
    contentType: String(r.content_type ?? "text"),
    text: String(r.text ?? ""),
    media: (r.media as Record<string, unknown> | null) ?? null,
    meta,
    sentAt: iso(r.sent_at) ?? new Date().toISOString(),
    ...(r.reactions !== undefined ? { reactions: mapReactions(r.reactions) } : {}),
    canReact: !!r.msg_id && typeof meta?.cliMsgId === "string" && meta.cliMsgId !== "",
  };
}

const REACTIONS_SUBQUERY = sql`(SELECT COALESCE(json_agg(json_build_object('icon', zr.icon, 'reactor_id', zr.reactor_id,
    'reactor_name', zr.reactor_name, 'source', zr.source, 'web_user_name', zu.name) ORDER BY zr.updated_at), '[]'::json)
  FROM inbox_reactions zr LEFT JOIN users zu ON zu.id = zr.web_user_id
  WHERE zr.channel_id = m.channel_id AND zr.msg_id = m.msg_id AND m.msg_id <> '')`;

const PREVIEW_LABEL: Record<string, string> = {
  photo: "[Hình ảnh]",
  file: "[File]",
  sticker: "[Sticker]",
  voice: "[Tin nhắn thoại]",
  video: "[Video]",
  link: "[Liên kết]",
  other: "[Nội dung khác]",
};

export function inboxPreview(contentType: string, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const label = contentType === "text" ? "" : (PREVIEW_LABEL[contentType] ?? "[Nội dung khác]");
  return (label && t ? `${label} ${t}` : label || t).slice(0, 160);
}

/**
 * Ghi 1 tin nhắn + cập nhật hội thoại. Trùng msg_id → bỏ qua (trả null).
 * `pauseMinutes` > 0 và tin do NGƯỜI gửi đi (web/app) → AI tạm im trong hội thoại đó.
 */
export async function recordInboxMessage(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  input: InboxMessageInput,
  opts: { pauseMinutes?: number; history?: boolean } = {},
): Promise<{ message: InboxMessageRow; thread: InboxThread } | null> {
  // history = tin CŨ nhập về sau khi liên kết: không tăng "chưa đọc", không tạm dừng AI,
  // không đè "tin gần nhất" của hội thoại nếu đã có tin mới hơn.
  const history = opts.history === true;
  return withWorkspace(db, ctx, async (tx) => {
    const ins = await tx.execute(sql`
      INSERT INTO inbox_messages (workspace_id, channel_id, thread_id, msg_id, direction, source,
        sender_id, sender_name, web_user_id, content_type, text, media, meta, sent_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.msgId}, ${input.direction},
        ${input.source}, ${input.senderId}, ${input.senderName}, ${input.webUserId ?? null},
        ${input.contentType}, ${input.text},
        ${input.media ? JSON.stringify(input.media) : null}::jsonb,
        ${input.meta ? JSON.stringify(input.meta) : null}::jsonb, ${input.sentAt.toISOString()})
      ON CONFLICT (channel_id, msg_id) WHERE msg_id <> '' DO NOTHING
      RETURNING *`);
    const row = ins.rows[0] as Raw | undefined;
    if (!row) return null;
    const preview = inboxPreview(input.contentType, input.text);
    const human = !history && input.direction === "out" && (input.source === "web" || input.source === "app");
    const pause =
      human && (opts.pauseMinutes ?? 0) > 0
        ? new Date(Date.now() + (opts.pauseMinutes ?? 0) * 60_000).toISOString()
        : null;
    const unreadInc = input.direction === "in" && !history ? 1 : 0;
    const th = await tx.execute(sql`
      INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, name, last_message,
        last_message_at, last_direction, unread_count, paused_until, updated_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.peerKind},
        ${input.threadName ?? ""}, ${preview}, ${input.sentAt.toISOString()}, ${input.direction},
        ${unreadInc}, ${pause}, now())
      ON CONFLICT (channel_id, thread_id) DO UPDATE SET
        name = CASE WHEN EXCLUDED.name <> '' AND (inbox_threads.name = '' OR inbox_threads.kind = 'direct')
                    THEN EXCLUDED.name ELSE inbox_threads.name END,
        last_message = CASE WHEN inbox_threads.last_message_at IS NOT NULL AND inbox_threads.last_message_at > EXCLUDED.last_message_at
                            THEN inbox_threads.last_message ELSE EXCLUDED.last_message END,
        last_message_at = GREATEST(COALESCE(inbox_threads.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at),
        last_direction = CASE WHEN inbox_threads.last_message_at IS NOT NULL AND inbox_threads.last_message_at > EXCLUDED.last_message_at
                              THEN inbox_threads.last_direction ELSE EXCLUDED.last_direction END,
        -- Người trả lời (web/app) = đã đọc hết tin trước đó
        unread_count = CASE WHEN ${human} THEN 0 ELSE inbox_threads.unread_count + ${unreadInc} END,
        paused_until = COALESCE(EXCLUDED.paused_until, inbox_threads.paused_until),
        updated_at = now()
      RETURNING *`);
    const msg = mapMessage(row);
    if (msg.webUserId) {
      const u = await tx.execute(sql`SELECT name FROM users WHERE id = ${msg.webUserId}`);
      msg.webUserName = ((u.rows[0] as Raw | undefined)?.name as string | undefined) ?? null;
    }
    return { message: msg, thread: mapThread(th.rows[0] as Raw) };
  });
}

export interface InboxContactInput {
  threadId: string;
  kind: "direct" | "group";
  name: string;
  avatar?: string;
  phone?: string;
  memberCount?: number;
}

/** Đồng bộ danh bạ (bạn bè + nhóm) vào inbox_threads — không đụng tin nhắn/trạng thái AI. */
export async function upsertInboxContacts(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  items: InboxContactInput[],
): Promise<number> {
  if (!items.length) return 0;
  return withWorkspace(db, ctx, async (tx) => {
    let n = 0;
    for (let i = 0; i < items.length; i += 200) {
      const batch = items.slice(i, i + 200);
      const values = sql.join(
        batch.map(
          (c) =>
            sql`(${ctx.workspaceId}::uuid, ${channelId}::uuid, ${c.threadId}, ${c.kind}, ${c.name}, ${c.avatar ?? ""}, ${c.phone ?? ""}, true, ${c.memberCount ?? null}::int, now(), now())`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, name, avatar, phone,
          is_contact, member_count, synced_at, updated_at)
        VALUES ${values}
        ON CONFLICT (channel_id, thread_id) DO UPDATE SET
          kind = EXCLUDED.kind,
          name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE inbox_threads.name END,
          avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE inbox_threads.avatar END,
          phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE inbox_threads.phone END,
          is_contact = true,
          member_count = COALESCE(EXCLUDED.member_count, inbox_threads.member_count),
          synced_at = now()`);
      n += batch.length;
    }
    return n;
  });
}

/** Cập nhật tên hội thoại (vd tên nhóm tra được sau). */
export async function setInboxThreadName(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  name: string,
): Promise<void> {
  if (!name) return;
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET name = ${name}, updated_at = now()
      WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
}

export interface InboxThreadQuery {
  q?: string;
  kind?: "direct" | "group";
  unreadOnly?: boolean;
  /** true = chỉ hội thoại đã có tin nhắn; false = cả danh bạ chưa chat */
  withMessagesOnly?: boolean;
  /** true = chỉ danh bạ (bạn bè / nhóm đang tham gia) */
  contactsOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Sắp theo thread_id cố định (phân trang ổn định cho MCP) thay vì tin mới nhất. */
  stableOrder?: boolean;
}

export async function listInboxThreads(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  query: InboxThreadQuery = {},
): Promise<{ threads: InboxThread[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const conds = [sql`channel_id = ${channelId}`];
  if (query.kind) conds.push(sql`kind = ${query.kind}`);
  if (query.unreadOnly) conds.push(sql`unread_count > 0`);
  if (query.withMessagesOnly) conds.push(sql`last_message_at IS NOT NULL`);
  if (query.contactsOnly) conds.push(sql`is_contact = true`);
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(name ILIKE ${like} OR thread_id LIKE ${like} OR phone LIKE ${like})`);
  }
  const where = sql.join(conds, sql` AND `);
  const order = query.stableOrder
    ? sql`thread_id ASC`
    : sql`last_message_at DESC NULLS LAST, name ASC`;
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT * FROM inbox_threads WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    );
    const cnt = await tx.execute(sql`SELECT count(*)::int AS n FROM inbox_threads WHERE ${where}`);
    return {
      threads: (rows.rows as Raw[]).map(mapThread),
      total: Number((cnt.rows[0] as Raw | undefined)?.n ?? 0),
    };
  });
}

/** Toàn bộ danh bạ + hội thoại Zalo của 1 kênh (xuất Excel), tối đa 100.000 dòng. */
export async function listAllInboxThreads(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
): Promise<InboxThread[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT * FROM inbox_threads WHERE channel_id = ${channelId}
      ORDER BY kind, last_message_at DESC NULLS LAST, name LIMIT 100000`),
  );
  return (res.rows as Raw[]).map(mapThread);
}

export async function getInboxThread(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT * FROM inbox_threads WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapThread(r) : null;
}

export async function listInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  opts: { beforeId?: string; limit?: number; maxLimit?: number } = {},
): Promise<InboxMessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), opts.maxLimit ?? 200);
  const before = opts.beforeId && /^\d+$/.test(opts.beforeId) ? sql`AND m.id < ${opts.beforeId}::bigint` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      SELECT m.*, u.name AS web_user_name, ${REACTIONS_SUBQUERY} AS reactions FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} ${before}
      ORDER BY m.id DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map(mapMessage).reverse();
}

export async function countInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<number> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM inbox_messages WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
  return Number((res.rows[0] as Raw | undefined)?.n ?? 0);
}

/** Tìm tin nhắn theo nội dung (không phân biệt hoa thường), mới nhất trước. */
export async function searchInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  query: string,
  opts: { threadId?: string; limit?: number; since?: Date } = {},
): Promise<Array<InboxMessageRow & { threadName: string; threadKind: "direct" | "group" }>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const byThread = opts.threadId ? sql`AND m.thread_id = ${opts.threadId}` : sql``;
  const since = opts.since ? sql`AND m.sent_at >= ${opts.since.toISOString()}` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      SELECT m.*, u.name AS web_user_name, t.name AS thread_name, t.kind AS thread_kind
      FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      LEFT JOIN inbox_threads t ON t.channel_id = m.channel_id AND t.thread_id = m.thread_id
      WHERE m.channel_id = ${channelId} AND m.text ILIKE ${like} ${byThread} ${since}
      ORDER BY m.id DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map((r) => ({
    ...mapMessage(r),
    threadName: String(r.thread_name ?? ""),
    threadKind: r.thread_kind === "group" ? "group" : "direct",
  }));
}

/** 1 tin theo id nội bộ (kèm cảm xúc). */
export async function getInboxMessageById(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  id: string,
): Promise<InboxMessageRow | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT m.*, u.name AS web_user_name, ${REACTIONS_SUBQUERY} AS reactions FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} AND m.id = ${id}::bigint`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** Bổ sung cliMsgId vào meta của tin đã lưu (bản dội lại của tin PenAI gửi). Trả tin sau cập nhật. */
export async function setInboxMessageCliId(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  msgId: string,
  cliMsgId: string,
): Promise<InboxMessageRow | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('cliMsgId', ${cliMsgId}::text)
      WHERE channel_id = ${channelId} AND msg_id = ${msgId} AND msg_id <> '' RETURNING *`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** N tin mới nhất KHÁCH gửi (direction in) còn thả cảm xúc được, mới nhất trước. */
export async function latestIncomingInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  count: number,
): Promise<InboxMessageRow[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT m.* FROM inbox_messages m
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} AND m.direction = 'in'
        AND m.msg_id <> '' AND COALESCE(m.meta->>'cliMsgId', '') <> ''
      ORDER BY m.id DESC LIMIT ${Math.min(Math.max(count, 1), 20)}`),
  );
  return (res.rows as Raw[]).map(mapMessage);
}

/**
 * Ghi cảm xúc: icon rỗng = gỡ. Nguồn PenAI (web/auto/mcp) giữ nguyên khi bản dội lại
 * từ listener (app) tới sau với cùng icon. Trả danh sách cảm xúc hiện tại của tin.
 */
export async function upsertInboxReaction(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  input: {
    threadId: string;
    msgId: string;
    reactorId: string;
    reactorName: string;
    icon: string;
    source: string;
    webUserId?: string | null;
  },
): Promise<InboxReactionRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    if (!input.icon) {
      await tx.execute(sql`DELETE FROM inbox_reactions WHERE channel_id = ${channelId}
        AND msg_id = ${input.msgId} AND reactor_id = ${input.reactorId}`);
    } else {
      await tx.execute(sql`INSERT INTO inbox_reactions (workspace_id, channel_id, thread_id, msg_id, reactor_id,
          reactor_name, icon, source, web_user_id, updated_at)
        VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.msgId}, ${input.reactorId},
          ${input.reactorName}, ${input.icon}, ${input.source}, ${input.webUserId ?? null}, now())
        ON CONFLICT (channel_id, msg_id, reactor_id) DO UPDATE SET
          reactor_name = CASE WHEN EXCLUDED.reactor_name <> '' THEN EXCLUDED.reactor_name ELSE inbox_reactions.reactor_name END,
          source = CASE WHEN EXCLUDED.source = 'app' AND inbox_reactions.icon = EXCLUDED.icon
                        THEN inbox_reactions.source ELSE EXCLUDED.source END,
          web_user_id = CASE WHEN EXCLUDED.source = 'app' AND inbox_reactions.icon = EXCLUDED.icon
                        THEN inbox_reactions.web_user_id ELSE EXCLUDED.web_user_id END,
          icon = EXCLUDED.icon,
          updated_at = now()`);
    }
    const res = await tx.execute(sql`SELECT zr.icon, zr.reactor_id, zr.reactor_name, zr.source, zu.name AS web_user_name
      FROM inbox_reactions zr LEFT JOIN users zu ON zu.id = zr.web_user_id
      WHERE zr.channel_id = ${channelId} AND zr.msg_id = ${input.msgId} ORDER BY zr.updated_at`);
    return mapReactions(res.rows);
  });
}

export async function markInboxThreadRead(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET unread_count = 0
      WHERE channel_id = ${channelId} AND thread_id = ${threadId} AND unread_count <> 0`),
  );
}

/** Bật/tắt AI theo hội thoại; resume=true xóa tạm dừng do nhân viên vừa trả lời. */
export async function setInboxThreadAi(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  input: { mode?: "auto" | "off"; resume?: boolean; kind?: "direct" | "group" },
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, ai_mode, updated_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${threadId}, ${input.kind ?? "direct"}, ${input.mode ?? "auto"}, now())
      ON CONFLICT (channel_id, thread_id) DO UPDATE SET
        ai_mode = COALESCE(${input.mode ?? null}, inbox_threads.ai_mode),
        paused_until = CASE WHEN ${input.resume === true} THEN NULL ELSE inbox_threads.paused_until END,
        updated_at = now()
      RETURNING *`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapThread(r) : null;
}

/** AI có được trả lời trong hội thoại này lúc này không (tắt tay / đang tạm dừng). */
/** Bỏ mọi lượt "AI tạm dừng" đang treo của một kênh (khi quản trị đặt số phút tạm dừng về 0). */
export async function clearInboxPauses(db: Db, ctx: WorkspaceContext, channelId: string): Promise<number> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET paused_until = NULL, updated_at = now()
      WHERE channel_id = ${channelId} AND paused_until IS NOT NULL`),
  );
  return res.rowCount ?? 0;
}

export async function getInboxThreadAgentBlock(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<"off" | "paused" | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT ai_mode, paused_until FROM inbox_threads
      WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  if (r.ai_mode === "off") return "off";
  if (r.paused_until && new Date(String(r.paused_until)).getTime() > Date.now()) return "paused";
  return null;
}

/** Dọn tin nhắn cũ hơn N ngày (0 = giữ mãi). */
export async function pruneInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  days: number,
): Promise<number> {
  if (!(days > 0)) return 0;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`DELETE FROM inbox_messages WHERE channel_id = ${channelId}
      AND sent_at < now() - make_interval(days => ${Math.floor(days)})`),
  );
  return res.rowCount ?? 0;
}

// ===== Member được trực kênh Zalo nào =====

export async function listInboxChannelMembers(
  db: Db,
  ctx: WorkspaceContext,
): Promise<Array<{ channelId: string; userId: string }>> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT channel_id, user_id FROM inbox_channel_members`),
  );
  return (res.rows as Raw[]).map((r) => ({ channelId: String(r.channel_id), userId: String(r.user_id) }));
}

export async function listUserInboxChannelIds(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<string[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT channel_id FROM inbox_channel_members WHERE user_id = ${userId}`),
  );
  return (res.rows as Raw[]).map((r) => String(r.channel_id));
}

/** Đặt LẠI danh sách kênh member được trực. Chỉ nhận kênh cá nhân có Inbox (Zalo, WhatsApp). */
export async function setUserInboxChannels(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
  channelIds: string[],
): Promise<string[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const ids = [...new Set(channelIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    const valid = ids.length
      ? (
          (
            await tx.execute(sql`SELECT id FROM channels WHERE kind IN ('zalo_personal', 'whatsapp_personal')
              AND id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)
          ).rows as Raw[]
        ).map((r) => String(r.id))
      : [];
    await tx.execute(sql`DELETE FROM inbox_channel_members WHERE user_id = ${userId}`);
    for (const channelId of valid) {
      await tx.execute(sql`INSERT INTO inbox_channel_members (workspace_id, channel_id, user_id, granted_by)
        VALUES (${ctx.workspaceId}, ${channelId}, ${userId}, ${ctx.userId}) ON CONFLICT DO NOTHING`);
    }
    return valid;
  });
}

// ===== Chống gửi trùng qua MCP (request_id) =====

export interface McpSendRecord {
  requestId: string;
  payloadHash: string;
  tool: string;
  status: "pending" | "sent" | "failed" | "unknown";
  result: Record<string, unknown> | null;
  updatedAt: string;
}

export async function getMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  principal: string,
  requestId: string,
): Promise<McpSendRecord | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT * FROM mcp_server_sends WHERE principal = ${principal} AND request_id = ${requestId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  return {
    requestId: String(r.request_id),
    payloadHash: String(r.payload_hash),
    tool: String(r.tool),
    status: r.status as McpSendRecord["status"],
    result: (r.result as Record<string, unknown> | null) ?? null,
    updatedAt: iso(r.updated_at) ?? "",
  };
}

/** Ghi lượt gửi 'pending'. Trả false nếu request_id đã tồn tại (cạnh tranh). */
export async function insertMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  input: { principal: string; requestId: string; payloadHash: string; tool: string; channelId: string; recipient: string },
): Promise<boolean> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`INSERT INTO mcp_server_sends (workspace_id, principal, request_id, payload_hash, tool,
        channel_id, recipient, status)
      VALUES (${ctx.workspaceId}, ${input.principal}, ${input.requestId}, ${input.payloadHash}, ${input.tool},
        ${input.channelId}, ${input.recipient}, 'pending')
      ON CONFLICT (workspace_id, principal, request_id) DO NOTHING RETURNING id`),
  );
  return res.rows.length > 0;
}

export async function finishMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  principal: string,
  requestId: string,
  status: "sent" | "failed" | "unknown",
  result: Record<string, unknown>,
  recipient?: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE mcp_server_sends SET status = ${status}, result = ${JSON.stringify(result)}::jsonb,
        recipient = COALESCE(${recipient ?? null}, recipient), updated_at = now()
      WHERE principal = ${principal} AND request_id = ${requestId}`),
  );
}

export async function listRecentMcpServerSends(
  db: Db,
  ctx: WorkspaceContext,
  opts: { userId?: string; limit?: number } = {},
): Promise<Array<{ requestId: string; tool: string; recipient: string; status: string; clientName: string; createdAt: string }>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const byUser = opts.userId ? sql`AND s.principal LIKE ${`${opts.userId}:%`}` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT s.request_id, s.tool, s.recipient, s.status, s.created_at,
        c.metadata->>'client_name' AS client_name
      FROM mcp_server_sends s
      LEFT JOIN mcp_oauth_clients c ON c.id = split_part(s.principal, ':', 2)
      WHERE true ${byUser} ORDER BY s.created_at DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map((r) => ({
    requestId: String(r.request_id),
    tool: String(r.tool),
    recipient: String(r.recipient ?? ""),
    status: String(r.status),
    clientName: String(r.client_name ?? ""),
    createdAt: iso(r.created_at) ?? "",
  }));
}
