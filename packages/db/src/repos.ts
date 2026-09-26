import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  MessageContent,
  MessageRole,
  StoredMessage,
  WorkspaceContext,
} from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { agentUserGrants, agents, messages, sessions } from "./schema.js";

// Mọi function ở đây BẮT BUỘC nhận WorkspaceContext (lớp cách ly số 1).

export type AgentRow = typeof agents.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/**
 * Danh sách agent. Role `member` CHỈ thấy agent được gán trong
 * agent_user_grants (0024) — lọc ở tầng DB, không phải chỉ ở UI.
 */
export async function listAgents(db: Db, ctx: WorkspaceContext): Promise<AgentRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    if (ctx.role !== "member") {
      return tx.select().from(agents).orderBy(asc(agents.createdAt));
    }
    const rows = await tx
      .select({ agents })
      .from(agents)
      .innerJoin(
        agentUserGrants,
        and(eq(agentUserGrants.agentId, agents.id), eq(agentUserGrants.userId, ctx.userId)),
      )
      .orderBy(asc(agents.createdAt));
    return rows.map((r) => r.agents);
  });
}

/** Member có được gán agent này không (ws_admin/operator/viewer: luôn true). */
export async function canAccessAgent(db: Db, ctx: WorkspaceContext, agentId: string): Promise<boolean> {
  if (ctx.role !== "member") return true;
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: agentUserGrants.id })
      .from(agentUserGrants)
      .where(and(eq(agentUserGrants.agentId, agentId), eq(agentUserGrants.userId, ctx.userId)))
      .limit(1),
  );
  return rows.length > 0;
}

export async function getAgentByKey(
  db: Db,
  ctx: WorkspaceContext,
  key: string,
): Promise<AgentRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(agents).where(eq(agents.key, key)).limit(1),
  );
  const row = rows[0] ?? null;
  if (row && !(await canAccessAgent(db, ctx, row.id))) return null;
  return row;
}

export async function getAgentById(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<AgentRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(agents).where(eq(agents.id, id)).limit(1),
  );
  const row = rows[0] ?? null;
  if (row && !(await canAccessAgent(db, ctx, row.id))) return null;
  return row;
}

export async function createAgent(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    key: string;
    name: string;
    systemPrompt?: string;
    provider: string;
    model: string;
    maxIterations?: number;
    workspaceMemoryEnabled?: boolean;
  },
): Promise<AgentRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(agents)
      .values({
        workspaceId: ctx.workspaceId,
        key: input.key,
        name: input.name,
        systemPrompt: input.systemPrompt ?? "",
        provider: input.provider,
        model: input.model,
        maxIterations: input.maxIterations ?? 10,
        workspaceMemoryEnabled: input.workspaceMemoryEnabled ?? true,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function updateAgent(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<{
    name: string;
    systemPrompt: string;
    provider: string;
    model: string;
    maxIterations: number;
    providerFallback: Array<{ provider: string; model: string }>;
    disabledTools: string[];
    thinkingLevel: string;
    workspaceMemoryEnabled: boolean;
    libraryWritable: boolean;
  }>,
): Promise<AgentRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(agents).set(patch).where(eq(agents.id, id)).returning(),
  );
  return rows[0] ?? null;
}

export async function deleteAgent(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id }),
  );
  return rows.length > 0;
}

export async function createSession(
  db: Db,
  ctx: WorkspaceContext,
  input: { agentId: string; title?: string; ownerUserId?: string | null },
): Promise<SessionRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(sessions)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        title: input.title ?? null,
        ownerUserId: input.ownerUserId ?? null,
      })
      .returning(),
  );
  return rows[0]!;
}

/** Member chỉ thấy phiên của chính mình (owner_user_id, 0024). */
export async function listSessions(db: Db, ctx: WorkspaceContext): Promise<SessionRow[]> {
  return withWorkspace(db, ctx, (tx) => {
    if (ctx.role === "member") {
      return tx
        .select()
        .from(sessions)
        .where(eq(sessions.ownerUserId, ctx.userId))
        .orderBy(desc(sessions.updatedAt));
    }
    return tx.select().from(sessions).orderBy(desc(sessions.updatedAt));
  });
}

export async function getSession(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<SessionRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(sessions)
      .where(
        ctx.role === "member"
          ? and(eq(sessions.id, id), eq(sessions.ownerUserId, ctx.userId))
          : eq(sessions.id, id),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function loadMessages(
  db: Db,
  ctx: WorkspaceContext,
  sessionId: string,
): Promise<StoredMessage[]> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq)),
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role as MessageRole,
    content: r.content as MessageContent,
    seq: r.seq,
  }));
}

/**
 * Ghi message mới với seq = max(seq)+1 trong session.
 * Caller phải serialize per-session (KeyedQueue) — unique index
 * (session_id, seq) là chốt chặn cuối nếu có race.
 */
export async function appendMessage(
  db: Db,
  ctx: WorkspaceContext,
  sessionId: string,
  input: { role: MessageRole; content: MessageContent },
): Promise<StoredMessage> {
  return withWorkspace(db, ctx, async (tx) => {
    const [{ next }] = (
      await tx.execute(
        sql`SELECT coalesce(max(seq), 0) + 1 AS next FROM messages WHERE session_id = ${sessionId}`,
      )
    ).rows as [{ next: string | number }];
    const seq = Number(next);
    const rows = await tx
      .insert(messages)
      .values({
        workspaceId: ctx.workspaceId,
        sessionId,
        role: input.role,
        content: input.content,
        seq,
      })
      .returning();
    await tx
      .update(sessions)
      .set({ updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
    const r = rows[0]!;
    return {
      id: r.id,
      role: r.role as MessageRole,
      content: r.content as MessageContent,
      seq: r.seq,
    };
  });
}
