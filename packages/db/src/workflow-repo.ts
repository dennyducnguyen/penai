/**
 * Quy trình tự động (0036): định nghĩa + phiên bản, lần chạy + nhật ký bước,
 * khóa bí mật của workspace, nonce webhook HMAC. Hàm SECURITY DEFINER chỉ dùng
 * cho việc chưa biết workspace (bộ chạy lịch, webhook công khai, dọn dẹp).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import {
  workflowLocks,
  workflowRuns,
  workflowRunSteps,
  workflows,
  workflowVersions,
  workflowWebhookNonces,
  workspaceSecrets,
} from "./schema.js";

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowRunStepRow = typeof workflowRunSteps.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;

export type WorkflowChangeVia = "dashboard" | "api" | "agent" | "mcp" | "import" | "template" | "restore";

export async function createWorkflow(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    slug: string;
    name: string;
    description: string;
    enabled: boolean;
    ownerUserId: string | null;
    definition: Record<string, unknown>;
    webhookTokenEncrypted: string;
    webhookSecretEncrypted: string;
    nextRunAt: Date | null;
    createdVia: WorkflowChangeVia;
    changedByAgentId?: string | null;
    changeNote?: string;
  },
): Promise<WorkflowRow> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .insert(workflows)
      .values({
        workspaceId: ctx.workspaceId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        ownerUserId: input.ownerUserId,
        definition: input.definition,
        version: 1,
        webhookTokenEncrypted: input.webhookTokenEncrypted,
        webhookSecretEncrypted: input.webhookSecretEncrypted,
        nextRunAt: input.nextRunAt,
        createdVia: input.createdVia,
        lastChangeVia: input.createdVia,
      })
      .returning();
    const wf = rows[0]!;
    await tx.insert(workflowVersions).values({
      workspaceId: ctx.workspaceId,
      workflowId: wf.id,
      version: 1,
      definition: input.definition,
      changedByUserId: ctx.userId === ctx.workspaceId ? null : ctx.userId,
      changedByAgentId: input.changedByAgentId ?? null,
      changeVia: input.createdVia,
      changeNote: input.changeNote ?? "Tạo mới",
    });
    return wf;
  });
}

/**
 * Lưu định nghĩa mới = một phiên bản mới. expectVersion (tùy chọn) chặn ghi đè
 * khi hai người/agent cùng sửa: bản trong DB đã khác → trả null.
 */
export async function saveWorkflowVersion(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  input: {
    name: string;
    description: string;
    definition: Record<string, unknown>;
    nextRunAt: Date | null;
    changeVia: WorkflowChangeVia;
    changedByAgentId?: string | null;
    changeNote?: string;
    expectVersion?: number;
  },
): Promise<WorkflowRow | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const cur = await tx.select().from(workflows).where(eq(workflows.id, id)).limit(1).for("update");
    const row = cur[0];
    if (!row) return null;
    if (input.expectVersion !== undefined && row.version !== input.expectVersion) return null;
    const version = row.version + 1;
    const updated = await tx
      .update(workflows)
      .set({
        name: input.name,
        description: input.description,
        definition: input.definition,
        version,
        nextRunAt: input.nextRunAt,
        lastChangeVia: input.changeVia,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning();
    await tx.insert(workflowVersions).values({
      workspaceId: ctx.workspaceId,
      workflowId: id,
      version,
      definition: input.definition,
      changedByUserId: ctx.userId === ctx.workspaceId ? null : ctx.userId,
      changedByAgentId: input.changedByAgentId ?? null,
      changeVia: input.changeVia,
      changeNote: input.changeNote ?? "",
    });
    return updated[0] ?? null;
  });
}

export async function updateWorkflowMeta(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<{
    enabled: boolean;
    ownerUserId: string | null;
    nextRunAt: Date | null;
    webhookTokenEncrypted: string;
    webhookSecretEncrypted: string;
    lastChangeVia: string | null;
  }>,
): Promise<WorkflowRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(workflows)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workflows.id, id))
      .returning(),
  );
  return rows[0] ?? null;
}

/** Ghi lịch kế tiếp (không đổi updated_at — bộ chạy lịch gọi thường xuyên). */
export async function setWorkflowNextRun(db: Db, ctx: WorkspaceContext, id: string, next: Date | null): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.update(workflows).set({ nextRunAt: next }).where(eq(workflows.id, id)));
}

export async function listWorkflows(db: Db, ctx: WorkspaceContext): Promise<WorkflowRow[]> {
  return withWorkspace(db, ctx, (tx) => tx.select().from(workflows).orderBy(asc(workflows.name)));
}

export async function getWorkflow(db: Db, ctx: WorkspaceContext, id: string): Promise<WorkflowRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.select().from(workflows).where(eq(workflows.id, id)).limit(1));
  return rows[0] ?? null;
}

export async function getWorkflowBySlug(db: Db, ctx: WorkspaceContext, slug: string): Promise<WorkflowRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.select().from(workflows).where(eq(workflows.slug, slug)).limit(1));
  return rows[0] ?? null;
}

export async function deleteWorkflow(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.delete(workflows).where(eq(workflows.id, id)).returning({ id: workflows.id }));
  return rows.length > 0;
}

export async function countEnabledWorkflows(db: Db, ctx: WorkspaceContext): Promise<number> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(workflows).where(eq(workflows.enabled, true)),
  );
  return rows[0]?.n ?? 0;
}

export async function listWorkflowVersions(db: Db, ctx: WorkspaceContext, workflowId: string, limit = 50): Promise<WorkflowVersionRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).orderBy(desc(workflowVersions.version)).limit(limit),
  );
}

export async function getWorkflowVersion(db: Db, ctx: WorkspaceContext, workflowId: string, version: number): Promise<WorkflowVersionRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)))
      .limit(1),
  );
  return rows[0] ?? null;
}

// ---------------- lần chạy ----------------

export async function createWorkflowRun(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    workflowId: string;
    version: number;
    triggerType: string;
    trigger: Record<string, unknown>;
    inputs: Record<string, unknown>;
    isTest?: boolean;
    dryRun?: boolean;
    parentRunId?: string | null;
  },
): Promise<WorkflowRunRow> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    const r = await tx
      .insert(workflowRuns)
      .values({
        workspaceId: ctx.workspaceId,
        workflowId: input.workflowId,
        version: input.version,
        triggerType: input.triggerType,
        trigger: input.trigger,
        inputs: input.inputs,
        isTest: input.isTest ?? false,
        dryRun: input.dryRun ?? false,
        parentRunId: input.parentRunId ?? null,
      })
      .returning();
    if (!input.isTest) {
      await tx.update(workflows).set({ lastRunAt: new Date(), lastRunStatus: "running" }).where(eq(workflows.id, input.workflowId));
    }
    return r;
  });
  return rows[0]!;
}

export async function finishWorkflowRun(
  db: Db,
  ctx: WorkspaceContext,
  runId: string,
  input: {
    status: string;
    error: string | null;
    output: unknown;
    response: unknown;
    stepCount: number;
    durationMs: number;
    updateWorkflow: boolean;
  },
): Promise<void> {
  await withWorkspace(db, ctx, async (tx) => {
    const r = await tx
      .update(workflowRuns)
      .set({
        status: input.status,
        error: input.error,
        output: (input.output ?? null) as never,
        response: (input.response ?? null) as never,
        stepCount: input.stepCount,
        durationMs: input.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId))
      .returning({ workflowId: workflowRuns.workflowId });
    const wfId = r[0]?.workflowId;
    if (wfId && input.updateWorkflow) {
      await tx.update(workflows).set({ lastRunStatus: input.status }).where(eq(workflows.id, wfId));
    }
  });
}

export async function addWorkflowRunSteps(
  db: Db,
  ctx: WorkspaceContext,
  runId: string,
  rows: Array<{
    seq: number;
    stepId: string;
    type: string;
    path: string;
    iteration: number | null;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
    attempts: number;
    startedAt: Date;
    durationMs: number;
  }>,
): Promise<void> {
  if (!rows.length) return;
  await withWorkspace(db, ctx, (tx) =>
    tx.insert(workflowRunSteps).values(
      rows.map((r) => ({
        workspaceId: ctx.workspaceId,
        runId,
        seq: r.seq,
        stepId: r.stepId,
        type: r.type,
        path: r.path,
        iteration: r.iteration,
        status: r.status,
        input: (r.input ?? null) as never,
        output: (r.output ?? null) as never,
        error: r.error,
        attempts: r.attempts,
        startedAt: r.startedAt,
        durationMs: Math.round(r.durationMs),
      })),
    ),
  );
}

export async function listWorkflowRuns(
  db: Db,
  ctx: WorkspaceContext,
  workflowId: string,
  opts: { limit?: number; status?: string; includeTests?: boolean } = {},
): Promise<WorkflowRunRow[]> {
  return withWorkspace(db, ctx, (tx) => {
    const conds = [eq(workflowRuns.workflowId, workflowId)];
    if (opts.status) conds.push(eq(workflowRuns.status, opts.status));
    if (opts.includeTests === false) conds.push(eq(workflowRuns.isTest, false));
    return tx
      .select()
      .from(workflowRuns)
      .where(and(...conds))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(Math.min(opts.limit ?? 50, 500));
  });
}

export async function getWorkflowRun(db: Db, ctx: WorkspaceContext, runId: string): Promise<WorkflowRunRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1));
  return rows[0] ?? null;
}

export async function listWorkflowRunSteps(db: Db, ctx: WorkspaceContext, runId: string, limit = 2000): Promise<WorkflowRunStepRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, runId)).orderBy(asc(workflowRunSteps.seq)).limit(limit),
  );
}

/** Kết quả gần nhất của từng bước (lần chạy gần nhất) — UI hiện "→ steps.x.output". */
export async function lastRunStepOutputs(db: Db, ctx: WorkspaceContext, workflowId: string): Promise<{ runId: string; steps: WorkflowRunStepRow[] } | null> {
  const runs = await listWorkflowRuns(db, ctx, workflowId, { limit: 1 });
  const run = runs[0];
  if (!run) return null;
  return { runId: run.id, steps: await listWorkflowRunSteps(db, ctx, run.id, 500) };
}

/** Số lần chạy theo trạng thái trong N ngày (thống kê trang Tổng quan / danh sách). */
export async function workflowRunStats(
  db: Db,
  ctx: WorkspaceContext,
  days = 7,
): Promise<Array<{ workflowId: string; total: number; failed: number; avgMs: number }>> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({
        workflowId: workflowRuns.workflowId,
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${workflowRuns.status} IN ('failed','timeout'))::int`,
        avgMs: sql<number>`coalesce(avg(${workflowRuns.durationMs}), 0)::int`,
      })
      .from(workflowRuns)
      .where(and(sql`${workflowRuns.startedAt} >= ${since}`, eq(workflowRuns.isTest, false)))
      .groupBy(workflowRuns.workflowId),
  );
  return rows;
}

export async function countRunningWorkflowRuns(db: Db, ctx: WorkspaceContext, workflowId: string): Promise<number> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.status, "running"))),
  );
  return rows[0]?.n ?? 0;
}

// ---------------- khóa bí mật ----------------

export type WorkspaceSecretMeta = {
  id: string;
  name: string;
  note: string;
  createdAt: Date;
  updatedAt: Date;
  workflowWritable: boolean;
  expiresAt: Date | null;
  version: number;
  updatedVia: string;
};

const secretMetaCols = {
  id: workspaceSecrets.id,
  name: workspaceSecrets.name,
  note: workspaceSecrets.note,
  createdAt: workspaceSecrets.createdAt,
  updatedAt: workspaceSecrets.updatedAt,
  workflowWritable: workspaceSecrets.workflowWritable,
  expiresAt: workspaceSecrets.expiresAt,
  version: workspaceSecrets.version,
  updatedVia: workspaceSecrets.updatedVia,
};

export async function listWorkspaceSecrets(db: Db, ctx: WorkspaceContext): Promise<WorkspaceSecretMeta[]> {
  return withWorkspace(db, ctx, (tx) => tx.select(secretMetaCols).from(workspaceSecrets).orderBy(asc(workspaceSecrets.name)));
}

export async function getWorkspaceSecretMeta(db: Db, ctx: WorkspaceContext, name: string): Promise<WorkspaceSecretMeta | null> {
  const r = await withWorkspace(db, ctx, (tx) => tx.select(secretMetaCols).from(workspaceSecrets).where(eq(workspaceSecrets.name, name)).limit(1));
  return r[0] ?? null;
}

/** Giá trị đã mã hóa của mọi khóa (bộ chạy giải mã khi cần). */
export async function listWorkspaceSecretValues(db: Db, ctx: WorkspaceContext): Promise<Array<{ name: string; valueEncrypted: string }>> {
  return withWorkspace(db, ctx, (tx) =>
    tx.select({ name: workspaceSecrets.name, valueEncrypted: workspaceSecrets.valueEncrypted }).from(workspaceSecrets),
  );
}

export async function upsertWorkspaceSecret(
  db: Db,
  ctx: WorkspaceContext,
  input: { name: string; valueEncrypted?: string; note?: string; workflowWritable?: boolean; expiresAt?: Date | null; via?: string },
): Promise<WorkspaceSecretMeta> {
  return withWorkspace(db, ctx, async (tx) => {
    const cur = await tx.select().from(workspaceSecrets).where(eq(workspaceSecrets.name, input.name)).limit(1);
    if (cur[0]) {
      const changedValue = input.valueEncrypted !== undefined;
      const rows = await tx
        .update(workspaceSecrets)
        .set({
          ...(changedValue ? { valueEncrypted: input.valueEncrypted, version: cur[0].version + 1, updatedVia: input.via ?? "dashboard", updatedByWorkflow: null } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.workflowWritable !== undefined ? { workflowWritable: input.workflowWritable } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workspaceSecrets.id, cur[0].id))
        .returning(secretMetaCols);
      return rows[0]!;
    }
    if (input.valueEncrypted === undefined) throw new Error("Khóa mới cần giá trị");
    const rows = await tx
      .insert(workspaceSecrets)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        valueEncrypted: input.valueEncrypted,
        note: input.note ?? "",
        createdBy: ctx.userId === ctx.workspaceId ? null : ctx.userId,
        workflowWritable: input.workflowWritable ?? false,
        expiresAt: input.expiresAt ?? null,
        updatedVia: input.via ?? "dashboard",
      })
      .returning(secretMetaCols);
    return rows[0]!;
  });
}

export class SecretNotWritableError extends Error {}

/**
 * Quy trình ghi khóa (bước secret op=set). Khóa có sẵn mà chưa bật "Quy trình được
 * ghi" → từ chối; khóa mới do quy trình tạo thì quy trình được ghi về sau.
 */
export async function workflowWriteSecret(
  db: Db,
  ctx: WorkspaceContext,
  input: { name: string; valueEncrypted: string; expiresAt: Date | null; note?: string; workflowId: string },
): Promise<WorkspaceSecretMeta> {
  return withWorkspace(db, ctx, async (tx) => {
    const cur = await tx.select().from(workspaceSecrets).where(eq(workspaceSecrets.name, input.name)).limit(1).for("update");
    if (cur[0]) {
      if (!cur[0].workflowWritable) {
        throw new SecretNotWritableError(
          "Khóa " + input.name + " do người nhập tay, quy trình không được ghi đè. Bật \"Quy trình được ghi\" cho khóa này ở Dashboard → Quy trình → 🔑 Khóa bí mật, hoặc dùng tên khóa khác.",
        );
      }
      const rows = await tx
        .update(workspaceSecrets)
        .set({
          valueEncrypted: input.valueEncrypted,
          expiresAt: input.expiresAt,
          version: cur[0].version + 1,
          updatedVia: "workflow",
          updatedByWorkflow: input.workflowId,
          updatedAt: new Date(),
          ...(input.note !== undefined ? { note: input.note } : {}),
        })
        .where(eq(workspaceSecrets.id, cur[0].id))
        .returning(secretMetaCols);
      return rows[0]!;
    }
    const rows = await tx
      .insert(workspaceSecrets)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        valueEncrypted: input.valueEncrypted,
        note: input.note ?? "Do quy trình tạo",
        workflowWritable: true,
        expiresAt: input.expiresAt,
        updatedVia: "workflow",
        updatedByWorkflow: input.workflowId,
      })
      .returning(secretMetaCols);
    return rows[0]!;
  });
}

export async function workflowDeleteSecret(db: Db, ctx: WorkspaceContext, name: string): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    const cur = await tx.select().from(workspaceSecrets).where(eq(workspaceSecrets.name, name)).limit(1);
    if (!cur[0]) return false;
    if (!cur[0].workflowWritable) throw new SecretNotWritableError("Khóa " + name + " do người nhập tay, quy trình không được xóa.");
    await tx.delete(workspaceSecrets).where(eq(workspaceSecrets.id, cur[0].id));
    return true;
  });
}

// ---------------- khóa giữa các lần chạy ----------------

/** Thử lấy khóa (không chờ). true = lần chạy này đang giữ khóa. */
export async function tryAcquireWorkflowLock(db: Db, ctx: WorkspaceContext, name: string, runId: string, ttlMs: number): Promise<boolean> {
  const exp = new Date(Date.now() + ttlMs);
  return withWorkspace(db, ctx, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO workflow_locks (workspace_id, name, run_id, expires_at)
      VALUES (${ctx.workspaceId}, ${name}, ${runId}, ${exp})
      ON CONFLICT (workspace_id, name) DO UPDATE SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at, created_at = now()
      WHERE workflow_locks.expires_at < now() OR workflow_locks.run_id = EXCLUDED.run_id
      RETURNING run_id`);
    return r.rows.length > 0;
  });
}

export async function releaseWorkflowLock(db: Db, ctx: WorkspaceContext, name: string, runId: string): Promise<boolean> {
  const r = await withWorkspace(db, ctx, (tx) =>
    tx.delete(workflowLocks).where(and(eq(workflowLocks.name, name), eq(workflowLocks.runId, runId))).returning({ n: workflowLocks.name }),
  );
  return r.length > 0;
}

/** Nhả mọi khóa của lần chạy (kết thúc) + dọn khóa quá hạn của mọi workspace. */
export async function releaseRunLocks(db: Db, runId: string): Promise<void> {
  await db.execute(sql`SELECT release_workflow_locks(${runId}::uuid)`);
}

/** Che giá trị bí mật mới (quy trình vừa lưu token) trong nhật ký bước ĐÃ ghi của lần chạy. */
export async function scrubWorkflowRunSteps(db: Db, ctx: WorkspaceContext, runId: string, values: string[]): Promise<void> {
  const vals = values.filter((v) => v && v.length >= 4).map((v) => JSON.stringify(v).slice(1, -1));
  if (!vals.length) return;
  await withWorkspace(db, ctx, async (tx) => {
    for (const v of vals) {
      await tx.execute(sql`
        UPDATE workflow_run_steps SET
          input = CASE WHEN input IS NULL THEN NULL ELSE replace(input::text, ${v}, '***')::jsonb END,
          output = CASE WHEN output IS NULL THEN NULL ELSE replace(output::text, ${v}, '***')::jsonb END,
          error = replace(error, ${v}, '***')
        WHERE run_id = ${runId} AND (strpos(COALESCE(input::text, ''), ${v}) > 0 OR strpos(COALESCE(output::text, ''), ${v}) > 0 OR strpos(COALESCE(error, ''), ${v}) > 0)`);
    }
  });
}

export async function deleteWorkspaceSecret(db: Db, ctx: WorkspaceContext, name: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(workspaceSecrets).where(eq(workspaceSecrets.name, name)).returning({ id: workspaceSecrets.id }),
  );
  return rows.length > 0;
}

// ---------------- dùng chung mọi workspace (SECURITY DEFINER) ----------------

export async function claimDueWorkflows(db: Db, now: Date, limit: number): Promise<Array<{ id: string; workspaceId: string; dueAt: Date }>> {
  const res = await db.execute(sql`SELECT * FROM claim_due_workflows(${now}, ${limit})`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    dueAt: new Date(r.due_at as string),
  }));
}

export async function listWorkflowsNeedingSchedule(db: Db): Promise<Array<{ id: string; workspaceId: string }>> {
  const res = await db.execute(sql`SELECT * FROM list_workflows_needing_schedule()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({ id: r.id as string, workspaceId: r.workspace_id as string }));
}

export interface WorkflowWebhookLookup {
  id: string;
  workspaceId: string;
  enabled: boolean;
  webhookTokenEncrypted: string | null;
  webhookSecretEncrypted: string | null;
  definition: Record<string, unknown>;
}

export async function lookupWorkflowWebhook(db: Db, id: string): Promise<WorkflowWebhookLookup | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await db.execute(sql`SELECT * FROM lookup_workflow_webhook(${id})`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    enabled: r.enabled as boolean,
    webhookTokenEncrypted: (r.webhook_token_encrypted as string | null) ?? null,
    webhookSecretEncrypted: (r.webhook_secret_encrypted as string | null) ?? null,
    definition: (typeof r.definition === "string" ? JSON.parse(r.definition) : r.definition) as Record<string, unknown>,
  };
}

export async function failInterruptedWorkflowRuns(db: Db): Promise<number> {
  const res = await db.execute(sql`SELECT fail_interrupted_workflow_runs() AS n`);
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

export async function pruneWorkflowData(db: Db, keepRuns: number): Promise<number> {
  const res = await db.execute(sql`SELECT prune_workflow_data(${keepRuns}) AS n`);
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/** Ghi nonce webhook HMAC; false = đã dùng (gửi lại). */
export async function consumeWorkflowNonce(db: Db, ctx: WorkspaceContext, workflowId: string, nonce: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(workflowWebhookNonces)
      .values({ workspaceId: ctx.workspaceId, workflowId, nonce })
      .onConflictDoNothing()
      .returning({ nonce: workflowWebhookNonces.nonce }),
  );
  return rows.length > 0;
}

export async function getWorkflowsByIds(db: Db, ctx: WorkspaceContext, ids: string[]): Promise<WorkflowRow[]> {
  if (!ids.length) return [];
  return withWorkspace(db, ctx, (tx) => tx.select().from(workflows).where(inArray(workflows.id, ids)));
}

/** Cuộc trò chuyện gần đây trên các kênh (chọn nơi gửi tin trong quy trình). */
export async function listRecentChannelChats(
  db: Db,
  ctx: WorkspaceContext,
  limit = 200,
): Promise<Array<{ channelId: string; chatKey: string; title: string; lastAt: Date }>> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      SELECT cs.channel_id, cs.chat_key, coalesce(s.title, cs.chat_key) AS title, s.updated_at
      FROM channel_sessions cs JOIN sessions s ON s.id = cs.session_id
      ORDER BY s.updated_at DESC
      LIMIT ${limit}`),
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    channelId: r.channel_id as string,
    chatKey: r.chat_key as string,
    title: String(r.title ?? r.chat_key),
    lastAt: new Date(r.updated_at as string),
  }));
}
