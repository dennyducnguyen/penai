import { desc, eq, sql } from "drizzle-orm";
import { generateApiKey, sha256hex, type WorkspaceContext, type WorkspaceRole } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { apiKeys, auditLog, sessions } from "./schema.js";

// ===== API keys management =====

/** Tạo API key mới cho workspace hiện tại. Trả về key thô (chỉ 1 lần). */
export async function createApiKey(
  db: Db,
  ctx: WorkspaceContext,
  input: { name: string; role: WorkspaceRole; expiresAt?: Date },
): Promise<{ id: string; apiKey: string }> {
  const raw = generateApiKey();
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        keyHash: sha256hex(raw),
        keyPrefix: raw.slice(0, 12),
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        role: input.role,
        name: input.name,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({ id: apiKeys.id }),
  );
  return { id: rows[0]!.id, apiKey: raw };
}

export async function listApiKeys(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        role: apiKeys.role,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt)),
  );
}

export async function revokeApiKey(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id }),
  );
  return rows.length > 0;
}

// ===== Sessions delete =====

export async function deleteSession(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    await tx.execute(sql`DELETE FROM messages WHERE session_id = ${id}`);
    await tx.execute(sql`DELETE FROM channel_sessions WHERE session_id = ${id}`);
    await tx.execute(sql`DELETE FROM traces WHERE session_id = ${id}`);
    await tx.execute(sql`UPDATE memories SET source_session_id = NULL WHERE source_session_id = ${id}`);
    const res = await tx.execute(sql`DELETE FROM sessions WHERE id = ${id} RETURNING id`);
    return res.rows.length > 0;
  });
}

// ===== Audit log =====

export async function recordAudit(
  db: Db,
  ctx: WorkspaceContext,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await withWorkspace(db, ctx, (tx) =>
      tx.insert(auditLog).values({
        workspaceId: ctx.workspaceId,
        actor: ctx.userId,
        action,
        detail,
      }),
    );
  } catch {
    // audit không được chặn hành động chính
  }
}

export async function listAudit(db: Db, ctx: WorkspaceContext, limit = 100) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit),
  );
}
