import { desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { cronJobs, cronRuns } from "./schema.js";

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
