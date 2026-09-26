import { desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { traces, usageCaps, hooks, agentWebhooks } from "./schema.js";

// ===== Tracing =====

/** Nguồn của một lượt chạy — tách lưu lượng app khỏi người dùng thật (0025). */
export type TraceSource =
  | "web"
  | "channel"
  | "api"
  | "cron"
  | "webhook"
  | "subagent";

export async function recordTrace(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    agentId?: string;
    sessionId?: string;
    kind?: string;
    inputTokens: number;
    outputTokens: number;
    iterations: number;
    durationMs: number;
    error?: string;
    source?: TraceSource;
    apiKeyId?: string;
    model?: string;
    provider?: string;
  },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.insert(traces).values({
      workspaceId: ctx.workspaceId,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      kind: input.kind ?? "chat",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      iterations: input.iterations,
      durationMs: input.durationMs,
      error: input.error ?? null,
      source: input.source ?? "web",
      apiKeyId: input.apiKeyId ?? null,
      model: input.model ?? "",
      provider: input.provider ?? "",
    }),
  );
}

/**
 * Ghi trace "cố gắng hết sức": không bao giờ làm hỏng lượt chạy chính.
 * Mọi đường chạy (kênh chat, cron, webhook, API, subagent) dùng hàm này —
 * trước 0025 chỉ nhánh non-stream của Dashboard ghi trace, nên bảng traces
 * gần như rỗng và không giám sát được gì.
 */
export function recordTraceSafe(
  db: Db,
  ctx: WorkspaceContext,
  input: Parameters<typeof recordTrace>[2],
): void {
  void recordTrace(db, ctx, input).catch(() => undefined);
}

export async function listTraces(db: Db, ctx: WorkspaceContext, limit = 50) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(traces).orderBy(desc(traces.createdAt)).limit(limit),
  );
}

// ===== Usage caps =====

export async function setUsageCap(
  db: Db,
  ctx: WorkspaceContext,
  monthlyTokenLimit: number,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(usageCaps)
      .values({ workspaceId: ctx.workspaceId, monthlyTokenLimit })
      .onConflictDoUpdate({ target: usageCaps.workspaceId, set: { monthlyTokenLimit } }),
  );
}

/** Tổng token đã dùng trong tháng (dùng function, không cần ws context). */
export async function monthTokens(db: Db, workspaceId: string): Promise<number> {
  const res = await db.execute(sql`SELECT workspace_month_tokens(${workspaceId}) AS n`);
  return Number((res.rows[0] as { n: string | number }).n);
}

/** Giới hạn tháng của workspace (null = không giới hạn). */
export async function workspaceCap(db: Db, workspaceId: string): Promise<number | null> {
  const res = await db.execute(sql`SELECT workspace_cap(${workspaceId}) AS n`);
  const n = (res.rows[0] as { n: string | number | null } | undefined)?.n;
  return n === null || n === undefined ? null : Number(n);
}

/** Đã vượt cap chưa? (không có cap → false). */
export async function isOverCap(db: Db, workspaceId: string): Promise<boolean> {
  const cap = await workspaceCap(db, workspaceId);
  if (cap === null) return false;
  return (await monthTokens(db, workspaceId)) >= cap;
}

// ===== Hooks =====

export async function createHook(
  db: Db,
  ctx: WorkspaceContext,
  input: { event: string; matcher?: string; url: string },
): Promise<{ id: string }> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(hooks)
      .values({
        workspaceId: ctx.workspaceId,
        event: input.event,
        matcher: input.matcher ?? ".*",
        url: input.url,
      })
      .returning({ id: hooks.id }),
  );
  return rows[0]!;
}

export async function listHooks(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(hooks));
}

export async function deleteHook(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(hooks).where(eq(hooks.id, id)).returning({ id: hooks.id }),
  );
  return rows.length > 0;
}

/** Hooks khớp 1 event của workspace (dùng runtime — không cần ws context nếu truyền wsId). */
export async function getHooksForEvent(
  db: Db,
  ctx: WorkspaceContext,
  event: string,
): Promise<Array<{ matcher: string; url: string }>> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ matcher: hooks.matcher, url: hooks.url })
      .from(hooks)
      .where(eq(hooks.event, event)),
  );
  return rows;
}

// ===== Agent webhooks =====

export async function createAgentWebhook(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  secretEncrypted: string,
): Promise<{ id: string }> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(agentWebhooks)
      .values({ workspaceId: ctx.workspaceId, agentId, secretEncrypted })
      .returning({ id: agentWebhooks.id }),
  );
  return rows[0]!;
}

export async function listAgentWebhooks(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: agentWebhooks.id, agentId: agentWebhooks.agentId, enabled: agentWebhooks.enabled })
      .from(agentWebhooks),
  );
}

export interface WebhookLookup {
  id: string;
  workspaceId: string;
  agentId: string;
  secretEncrypted: string;
  enabled: boolean;
}

export async function lookupAgentWebhook(db: Db, id: string): Promise<WebhookLookup | null> {
  const res = await db.execute(sql`SELECT * FROM lookup_agent_webhook(${id})`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    secretEncrypted: r.secret_encrypted as string,
    enabled: r.enabled as boolean,
  };
}

/** Ghi nonce; trả false nếu đã tồn tại (replay). */
export async function consumeNonce(
  db: Db,
  ctx: WorkspaceContext,
  webhookId: string,
  nonce: string,
): Promise<boolean> {
  try {
    await db.execute(
      sql`INSERT INTO webhook_nonces (webhook_id, nonce) VALUES (${webhookId}, ${nonce})`,
    );
    return true;
  } catch {
    return false; // unique violation → replay
  }
}
