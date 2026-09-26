import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import {
  apiConversations,
  apiIdempotency,
  apiKeyPolicies,
  apiUsageDaily,
} from "./schema.js";

// ===== Chính sách theo API key =====

export interface ApiKeyPolicy {
  apiKeyId: string;
  models: string[] | null;
  agents: string[] | null;
  rpm: number | null;
  maxConcurrent: number | null;
  monthlyTokens: number | null;
  paused: boolean;
  note: string;
}

export async function getApiKeyPolicy(
  db: Db,
  ctx: WorkspaceContext,
  apiKeyId: string,
): Promise<ApiKeyPolicy | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(apiKeyPolicies).where(eq(apiKeyPolicies.apiKeyId, apiKeyId)),
  );
  const r = rows[0];
  if (!r) return null;
  return {
    apiKeyId: r.apiKeyId,
    models: r.models ?? null,
    agents: r.agents ?? null,
    rpm: r.rpm ?? null,
    maxConcurrent: r.maxConcurrent ?? null,
    monthlyTokens: r.monthlyTokens ?? null,
    paused: r.paused,
    note: r.note,
  };
}

export async function upsertApiKeyPolicy(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    apiKeyId: string;
    models?: string[] | null;
    agents?: string[] | null;
    rpm?: number | null;
    maxConcurrent?: number | null;
    monthlyTokens?: number | null;
    paused?: boolean;
    note?: string;
  },
): Promise<void> {
  const values = {
    apiKeyId: input.apiKeyId,
    workspaceId: ctx.workspaceId,
    models: input.models ?? null,
    agents: input.agents ?? null,
    rpm: input.rpm ?? null,
    maxConcurrent: input.maxConcurrent ?? null,
    monthlyTokens: input.monthlyTokens ?? null,
    paused: input.paused ?? false,
    note: input.note ?? "",
  };
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(apiKeyPolicies)
      .values(values)
      .onConflictDoUpdate({
        target: apiKeyPolicies.apiKeyId,
        set: { ...values, updatedAt: new Date() },
      }),
  );
}

export async function listApiKeyPolicies(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(apiKeyPolicies));
}

// ===== Usage theo key theo ngày =====

export async function bumpApiUsage(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    apiKeyId: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    images?: number;
    isError?: boolean;
    queuedMs?: number;
    durationMs?: number;
  },
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(apiUsageDaily)
      .values({
        workspaceId: ctx.workspaceId,
        apiKeyId: input.apiKeyId,
        day,
        model: input.model,
        requests: 1,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        images: input.images ?? 0,
        errors: input.isError ? 1 : 0,
        queuedMs: input.queuedMs ?? 0,
        durationMs: input.durationMs ?? 0,
      })
      .onConflictDoUpdate({
        target: [apiUsageDaily.apiKeyId, apiUsageDaily.day, apiUsageDaily.model],
        set: {
          requests: sql`${apiUsageDaily.requests} + 1`,
          inputTokens: sql`${apiUsageDaily.inputTokens} + ${input.inputTokens ?? 0}`,
          outputTokens: sql`${apiUsageDaily.outputTokens} + ${input.outputTokens ?? 0}`,
          images: sql`${apiUsageDaily.images} + ${input.images ?? 0}`,
          errors: sql`${apiUsageDaily.errors} + ${input.isError ? 1 : 0}`,
          queuedMs: sql`${apiUsageDaily.queuedMs} + ${input.queuedMs ?? 0}`,
          durationMs: sql`${apiUsageDaily.durationMs} + ${input.durationMs ?? 0}`,
        },
      }),
  );
}

export async function listApiUsage(db: Db, ctx: WorkspaceContext, days = 30) {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(apiUsageDaily)
      .where(sql`${apiUsageDaily.day} >= ${from}`)
      .orderBy(desc(apiUsageDaily.day)),
  );
}

/** Tổng token API của một key trong tháng hiện tại (cho hạn mức riêng của key). */
export async function apiKeyMonthTokens(
  db: Db,
  ctx: WorkspaceContext,
  apiKeyId: string,
): Promise<number> {
  const from = new Date().toISOString().slice(0, 8) + "01";
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({
        n: sql<string>`COALESCE(SUM(${apiUsageDaily.inputTokens} + ${apiUsageDaily.outputTokens}), 0)`,
      })
      .from(apiUsageDaily)
      .where(and(eq(apiUsageDaily.apiKeyId, apiKeyId), sql`${apiUsageDaily.day} >= ${from}`)),
  );
  return Number(rows[0]?.n ?? 0);
}

// ===== Neo hội thoại API → session =====

export async function getApiConversation(
  db: Db,
  ctx: WorkspaceContext,
  input: { apiKeyId: string; conversationId: string; agentId: string },
): Promise<{ sessionId: string } | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ sessionId: apiConversations.sessionId })
      .from(apiConversations)
      .where(
        and(
          eq(apiConversations.apiKeyId, input.apiKeyId),
          eq(apiConversations.conversationId, input.conversationId),
          eq(apiConversations.agentId, input.agentId),
        ),
      ),
  );
  return rows[0] ?? null;
}

export async function saveApiConversation(
  db: Db,
  ctx: WorkspaceContext,
  input: { apiKeyId: string; conversationId: string; agentId: string; sessionId: string },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(apiConversations)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .onConflictDoUpdate({
        target: [
          apiConversations.apiKeyId,
          apiConversations.conversationId,
          apiConversations.agentId,
        ],
        set: { sessionId: input.sessionId, lastUsedAt: new Date() },
      }),
  );
}

// ===== Idempotency =====

export type IdempotencyState =
  | { kind: "fresh" }
  | { kind: "running" }
  | { kind: "done"; response: unknown }
  | { kind: "conflict" };

/**
 * Ghi chỗ cho một Idempotency-Key. "fresh" = caller được chạy thật; "running" =
 * một request y hệt đang chạy; "done" = trả lại response cũ; "conflict" = cùng
 * key nhưng body khác (client dùng sai).
 */
export async function beginIdempotency(
  db: Db,
  ctx: WorkspaceContext,
  input: { apiKeyId: string; idemKey: string; requestHash: string },
): Promise<IdempotencyState> {
  const inserted = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(apiIdempotency)
      .values({
        workspaceId: ctx.workspaceId,
        apiKeyId: input.apiKeyId,
        idemKey: input.idemKey,
        requestHash: input.requestHash,
        status: "running",
      })
      .onConflictDoNothing({
        target: [apiIdempotency.apiKeyId, apiIdempotency.idemKey],
      })
      .returning({ id: apiIdempotency.id }),
  );
  if (inserted.length) return { kind: "fresh" };

  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(apiIdempotency)
      .where(
        and(
          eq(apiIdempotency.apiKeyId, input.apiKeyId),
          eq(apiIdempotency.idemKey, input.idemKey),
        ),
      ),
  );
  const row = rows[0];
  if (!row) return { kind: "fresh" };
  if (row.requestHash !== input.requestHash) return { kind: "conflict" };
  if (row.status === "succeeded") return { kind: "done", response: row.response };
  if (row.status === "failed") return { kind: "fresh" };
  return { kind: "running" };
}

export async function finishIdempotency(
  db: Db,
  ctx: WorkspaceContext,
  input: { apiKeyId: string; idemKey: string; ok: boolean; response?: unknown },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .update(apiIdempotency)
      .set({
        status: input.ok ? "succeeded" : "failed",
        response: (input.response ?? null) as never,
      })
      .where(
        and(
          eq(apiIdempotency.apiKeyId, input.apiKeyId),
          eq(apiIdempotency.idemKey, input.idemKey),
        ),
      ),
  );
}

/** Dọn bản ghi idempotency quá hạn (gọi định kỳ). */
export async function purgeIdempotency(db: Db, olderThanHours = 24): Promise<number> {
  const res = await db.execute(
    sql`DELETE FROM api_idempotency WHERE created_at < now() - (${olderThanHours} || ' hours')::interval`,
  );
  return res.rowCount ?? 0;
}
