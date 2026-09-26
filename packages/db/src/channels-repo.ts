import { and, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import {
  channels,
  channelPairings,
  channelSessions,
  conversations,
  contacts,
  principals,
  zaloObservedPeers,
} from "./schema.js";

export type ChannelRow = typeof channels.$inferSelect;

export interface EnabledChannel {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  agentId: string;
  tokenEncrypted: string | null;
  config: Record<string, unknown>;
  requirePairing: boolean;
}

/** Liệt kê mọi channel enabled (không cần workspace context — dùng lúc boot). */
export async function listEnabledChannels(db: Db): Promise<EnabledChannel[]> {
  const res = await db.execute(sql`SELECT * FROM list_enabled_channels()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    kind: r.kind as string,
    name: r.name as string,
    agentId: r.agent_id as string,
    tokenEncrypted: (r.token_encrypted as string) ?? null,
    config: (r.config as Record<string, unknown>) ?? {},
    requirePairing: r.require_pairing as boolean,
  }));
}

export async function listChannels(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(channels));
}

export async function createChannel(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    kind: string;
    name: string;
    agentId: string;
    tokenEncrypted?: string;
    config?: Record<string, unknown>;
    requirePairing?: boolean;
  },
): Promise<ChannelRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(channels)
      .values({
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        name: input.name,
        agentId: input.agentId,
        tokenEncrypted: input.tokenEncrypted ?? null,
        config: input.config ?? {},
        requirePairing: input.requirePairing ?? true,
      })
      .returning(),
  );
  return rows[0]!;
}

/** Đọc 1 channel đầy đủ (kèm token mã hóa) — cho sửa + restart live. */
export async function getChannelById(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<ChannelRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(channels).where(eq(channels.id, id)).limit(1),
  );
  return rows[0] ?? null;
}

/** Sửa channel (tên, agent gắn kèm, token, pairing, bật/tắt, config). */
export async function updateChannel(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: {
    name?: string;
    agentId?: string;
    tokenEncrypted?: string;
    requirePairing?: boolean;
    enabled?: boolean;
    config?: Record<string, unknown>;
  },
): Promise<ChannelRow | null> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.agentId !== undefined) values.agentId = patch.agentId;
  if (patch.tokenEncrypted !== undefined) values.tokenEncrypted = patch.tokenEncrypted;
  if (patch.requirePairing !== undefined) values.requirePairing = patch.requirePairing;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.config !== undefined) values.config = patch.config;
  if (!Object.keys(values).length) return getChannelById(db, ctx, id);
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(channels).set(values).where(eq(channels.id, id)).returning(),
  );
  return rows[0] ?? null;
}

export async function setChannelEnabled(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  enabled: boolean,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.update(channels).set({ enabled }).where(eq(channels.id, id)),
  );
}

export async function deleteChannel(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(channels).where(eq(channels.id, id)).returning({ id: channels.id }),
  );
  return rows.length > 0;
}

// ===== channel_sessions: ánh xạ chat → session =====

export async function getChannelSession(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  chatKey: string,
): Promise<string | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ sessionId: channelSessions.sessionId })
      .from(channelSessions)
      .where(
        and(
          eq(channelSessions.channelId, channelId),
          eq(channelSessions.chatKey, chatKey),
        ),
      )
      .limit(1),
  );
  return rows[0]?.sessionId ?? null;
}

export async function mapChannelSession(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  chatKey: string,
  sessionId: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(channelSessions)
      .values({
        workspaceId: ctx.workspaceId,
        channelId,
        chatKey,
        sessionId,
      })
      .onConflictDoUpdate({
        target: [channelSessions.channelId, channelSessions.chatKey],
        set: { sessionId, lastActive: new Date() },
      }),
  );
}

// ===== Pairing =====

export async function createPairing(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  code: string,
  externalUserId: string,
  ttlMinutes = 60,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(channelPairings)
      .values({
        workspaceId: ctx.workspaceId,
        channelId,
        code,
        externalUserId,
        status: "pending",
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      }),
  );
}

export async function isPaired(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  externalUserId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: channelPairings.id })
      .from(channelPairings)
      .where(
        and(
          eq(channelPairings.channelId, channelId),
          eq(channelPairings.externalUserId, externalUserId),
          eq(channelPairings.status, "approved"),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

export async function approvePairing(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  code: string,
): Promise<{ id: string; externalUserId: string | null } | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(channelPairings)
      .set({ status: "approved", approvedAt: new Date() })
      .where(
        and(
          eq(channelPairings.channelId, channelId),
          eq(channelPairings.code, code),
          eq(channelPairings.status, "pending"),
        ),
      )
      .returning({
        id: channelPairings.id,
        externalUserId: channelPairings.externalUserId,
      }),
  );
  return rows[0] ?? null;
}

export async function listPendingPairings(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(channelPairings)
      .where(eq(channelPairings.status, "pending")),
  );
}

// ===== Contacts (dedup theo workspace + kênh + external_id) =====

export async function upsertContact(
  db: Db,
  ctx: WorkspaceContext,
  input: { channelId?: string; channelKind: string; externalId: string; displayName?: string },
): Promise<{ contactId: string; principalId: string }> {
  return withWorkspace(db, ctx, async (tx) => {
    const existing = input.channelId
      ? await tx.execute(sql`
          SELECT id, principal_id FROM contacts
          WHERE channel_id = ${input.channelId} AND external_id = ${input.externalId}
          LIMIT 1 FOR UPDATE
        `)
      : await tx.execute(sql`
          SELECT id, principal_id FROM contacts
          WHERE channel_id IS NULL AND channel_kind = ${input.channelKind}
            AND external_id = ${input.externalId}
          LIMIT 1 FOR UPDATE
        `);
    const found = existing.rows[0] as { id: string; principal_id: string | null } | undefined;
    if (found?.principal_id) {
      await tx.execute(sql`
        UPDATE contacts SET
          last_seen = now(),
          display_name = COALESCE(${input.displayName ?? null}, display_name)
        WHERE id = ${found.id}
      `);
      if (input.displayName) {
        await tx.execute(sql`
          UPDATE principals SET display_name = ${input.displayName}, updated_at = now()
          WHERE id = ${found.principal_id} AND kind = 'contact'
        `);
      }
      return { contactId: found.id, principalId: found.principal_id };
    }

    // Lần đầu sau migration 0022: gắn contact legacy vào channel instance
    // thay vì tạo một principal trùng. Chỉ claim hàng channel_id IS NULL.
    if (input.channelId) {
      const legacy = await tx.execute(sql`
        SELECT id, principal_id FROM contacts
        WHERE channel_id IS NULL AND channel_kind = ${input.channelKind}
          AND external_id = ${input.externalId}
        LIMIT 1 FOR UPDATE
      `);
      const old = legacy.rows[0] as { id: string; principal_id: string | null } | undefined;
      if (old?.principal_id) {
        await tx.execute(sql`
          UPDATE contacts SET channel_id = ${input.channelId}, last_seen = now(),
            display_name = COALESCE(${input.displayName ?? null}, display_name)
          WHERE id = ${old.id}
        `);
        if (input.displayName) {
          await tx.execute(sql`
            UPDATE principals SET display_name = ${input.displayName}, updated_at = now()
            WHERE id = ${old.principal_id} AND kind = 'contact'
          `);
        }
        return { contactId: old.id, principalId: old.principal_id };
      }
    }

    const principalRows = await tx
      .insert(principals)
      .values({
        workspaceId: ctx.workspaceId,
        kind: "contact",
        displayName: input.displayName ?? `${input.channelKind}:${input.externalId}`,
      })
      .returning({ id: principals.id });
    const principalId = principalRows[0]!.id;
    const contactRows = await tx
      .insert(contacts)
      .values({
        workspaceId: ctx.workspaceId,
        channelId: input.channelId ?? null,
        principalId,
        channelKind: input.channelKind,
        externalId: input.externalId,
        displayName: input.displayName ?? null,
        lastSeen: new Date(),
      })
      .returning({ id: contacts.id });
    return { contactId: contactRows[0]!.id, principalId };
  });
}

export async function listContacts(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(contacts));
}

/** Resolve principal cho tài khoản dashboard/API hiện tại. */
export async function getOrCreateMemberPrincipal(
  db: Db,
  ctx: WorkspaceContext,
): Promise<string> {
  return withWorkspace(db, ctx, async (tx) => {
    const found = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(eq(principals.workspaceUserId, ctx.userId))
      .limit(1);
    if (found[0]) return found[0].id;
    const res = await tx.execute(sql`
      INSERT INTO principals (workspace_id, kind, display_name, workspace_user_id)
      SELECT ${ctx.workspaceId}, 'member', u.name, u.id FROM users u WHERE u.id = ${ctx.userId}
      ON CONFLICT (workspace_id, workspace_user_id) WHERE workspace_user_id IS NOT NULL
      DO UPDATE SET updated_at = now()
      RETURNING id
    `);
    const id = (res.rows[0] as { id?: string } | undefined)?.id;
    if (!id) throw new Error("Không resolve được principal cho workspace user");
    return id;
  });
}

export async function listPrincipals(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(principals).where(eq(principals.status, "active")),
  );
}

export async function upsertConversation(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    channelId: string;
    externalChatId: string;
    peerKind: "direct" | "group" | "thread";
    title?: string;
  },
): Promise<string> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .insert(conversations)
      .values({
        workspaceId: ctx.workspaceId,
        channelId: input.channelId,
        externalChatId: input.externalChatId,
        peerKind: input.peerKind,
        title: input.title ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [conversations.channelId, conversations.externalChatId],
        set: {
          peerKind: input.peerKind,
          ...(input.title ? { title: input.title } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: conversations.id });
    return rows[0]!.id;
  });
}

export async function listConversations(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(conversations));
}

// ===== Zalo Personal: danh sách quan sát bền vững (0017) =====

export interface ZaloObservedUpsert {
  chatKey: string;
  threadId: string;
  kind: "direct" | "group";
  name: string;
  lastSenderId: string;
  lastSenderName: string;
  /** true = tin nhắn mới (tăng message_count); false = chỉ cập nhật tên nhóm */
  countMessage: boolean;
}

export async function upsertZaloObservedPeer(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  input: ZaloObservedUpsert,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(zaloObservedPeers)
      .values({
        workspaceId: ctx.workspaceId,
        channelId,
        chatKey: input.chatKey,
        threadId: input.threadId,
        kind: input.kind,
        name: input.name,
        lastSenderId: input.lastSenderId,
        lastSenderName: input.lastSenderName,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [zaloObservedPeers.channelId, zaloObservedPeers.chatKey],
        set: {
          name: input.name,
          ...(input.countMessage
            ? {
                lastSenderId: input.lastSenderId,
                lastSenderName: input.lastSenderName,
                lastSeenAt: new Date(),
                messageCount: sql`${zaloObservedPeers.messageCount} + 1`,
              }
            : {}),
        },
      }),
  );
}

export async function listZaloObservedPeers(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(zaloObservedPeers)
      .where(eq(zaloObservedPeers.channelId, channelId))
      .orderBy(sql`${zaloObservedPeers.lastSeenAt} DESC`)
      .limit(500),
  );
}
