import { and, count, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { cronJobs, cronRuns, type CronOrigin } from "./schema.js";

export type CronJobRow = typeof cronJobs.$inferSelect;

export interface DueCronJob {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  kind: string;
  schedule: string;
  prompt: string;
}

export async function createCronJob(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    agentId: string;
    name: string;
    schedule: string;
    prompt: string;
    kind?: string;
    nextRun: Date;
    timezone?: string | null;
    createdVia?: "dashboard" | "agent";
    ownerKey?: string | null;
    origin?: CronOrigin | null;
  },
): Promise<CronJobRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(cronJobs)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        kind: input.kind ?? "cron",
        nextRun: input.nextRun,
        timezone: input.timezone ?? null,
        createdVia: input.createdVia ?? "dashboard",
        ownerKey: input.ownerKey ?? null,
        origin: input.origin ?? null,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function listCronJobs(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(cronJobs).orderBy(desc(cronJobs.createdAt)),
  );
}

export async function getCronJob(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<CronJobRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(cronJobs).where(eq(cronJobs.id, id)).limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Lịch của một agent mà người đang chat được xem/sửa (tool cron_list...):
 * - all: mọi lịch của agent (quản trị viên chat trên web);
 * - còn lại: lịch người đó nhờ tạo + lịch gửi về chính cuộc trò chuyện này
 *   (nhóm chat: thành viên quản lý chung lịch của nhóm).
 */
export async function listCronJobsForAgent(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  scope: { all: true } | { ownerKey: string; chat?: { channelId: string; chatKey: string } },
  opts: { includeDisabled?: boolean; limit?: number } = {},
): Promise<CronJobRow[]> {
  const conds: SQL[] = [eq(cronJobs.agentId, agentId)];
  if (!("all" in scope)) {
    const mine = eq(cronJobs.ownerKey, scope.ownerKey);
    conds.push(
      scope.chat
        ? or(
            mine,
            sql`(${cronJobs.origin}->>'channelId' = ${scope.chat.channelId}
                 AND ${cronJobs.origin}->>'chatKey' = ${scope.chat.chatKey})`,
          )!
        : mine,
    );
  }
  if (!opts.includeDisabled) conds.push(eq(cronJobs.enabled, true));
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(cronJobs)
      .where(and(...conds))
      .orderBy(desc(cronJobs.createdAt))
      .limit(opts.limit ?? 50),
  );
}

/** Số lịch ĐANG BẬT của một người (giới hạn mỗi người). */
export async function countActiveCronJobsByOwner(
  db: Db,
  ctx: WorkspaceContext,
  ownerKey: string,
): Promise<number> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ n: count() })
      .from(cronJobs)
      .where(and(eq(cronJobs.ownerKey, ownerKey), eq(cronJobs.enabled, true))),
  );
  return Number(rows[0]?.n ?? 0);
}

/** Sửa lịch (tên, lịch, nội dung, bật/tắt, lần chạy kế tiếp). Trả bản ghi mới. */
export async function updateCronJob(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: {
    name?: string;
    schedule?: string;
    prompt?: string;
    enabled?: boolean;
    nextRun?: Date;
    timezone?: string | null;
  },
): Promise<CronJobRow | null> {
  const set: Partial<typeof cronJobs.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.schedule !== undefined) set.schedule = patch.schedule;
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.nextRun !== undefined) set.nextRun = patch.nextRun;
  if (patch.timezone !== undefined) set.timezone = patch.timezone;
  if (Object.keys(set).length === 0) return getCronJob(db, ctx, id);
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(cronJobs).set(set).where(eq(cronJobs.id, id)).returning(),
  );
  return rows[0] ?? null;
}

export async function setCronEnabled(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  enabled: boolean,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.update(cronJobs).set({ enabled }).where(eq(cronJobs.id, id)),
  );
}

export async function deleteCronJob(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(cronJobs).where(eq(cronJobs.id, id)).returning({ id: cronJobs.id }),
  );
  return rows.length > 0;
}

export async function listCronRuns(
  db: Db,
  ctx: WorkspaceContext,
  cronJobId: string,
  limit = 20,
) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.cronJobId, cronJobId))
      .orderBy(desc(cronRuns.runAt))
      .limit(limit),
  );
}

// ===== Dùng bởi CronRunner (không có workspace context) =====

/** Lấy + claim (atomic, SKIP LOCKED) các job tới hạn. */
export async function claimDueCronJobs(
  db: Db,
  now: Date,
  limit: number,
): Promise<DueCronJob[]> {
  const res = await db.execute(
    sql`SELECT * FROM claim_due_cron_jobs(${now}, ${limit})`,
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    name: r.name as string,
    kind: r.kind as string,
    schedule: r.schedule as string,
    prompt: r.prompt as string,
  }));
}

export async function updateCronNextRun(
  db: Db,
  id: string,
  next: Date | null,
  disable: boolean,
): Promise<void> {
  await db.execute(
    sql`SELECT update_cron_next_run(${id}, ${next}, ${disable})`,
  );
}

/** Ghi log 1 lần chạy cron (dùng workspace context của job). */
export async function recordCronRun(
  db: Db,
  ctx: WorkspaceContext,
  cronJobId: string,
  status: "ok" | "error",
  output: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.insert(cronRuns).values({
      workspaceId: ctx.workspaceId,
      cronJobId,
      status,
      output: output.slice(0, 8000),
    }),
  );
}
