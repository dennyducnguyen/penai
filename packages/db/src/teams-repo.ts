import { and, asc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { teams, teamMembers, teamTasks, agentLinks } from "./schema.js";

export type TeamRow = typeof teams.$inferSelect;
export type TeamTaskRow = typeof teamTasks.$inferSelect;

export async function createTeam(db: Db, ctx: WorkspaceContext, name: string): Promise<TeamRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.insert(teams).values({ workspaceId: ctx.workspaceId, name }).returning(),
  );
  return rows[0]!;
}

export async function listTeams(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(teams));
}

export async function addTeamMember(
  db: Db,
  ctx: WorkspaceContext,
  teamId: string,
  agentId: string,
  role = "member",
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(teamMembers)
      .values({ teamId, agentId, workspaceId: ctx.workspaceId, role })
      .onConflictDoNothing(),
  );
}

export async function listTeamMembers(db: Db, ctx: WorkspaceContext, teamId: string) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(teamMembers).where(eq(teamMembers.teamId, teamId)),
  );
}

/** Team đầu tiên mà agent là thành viên (null nếu không thuộc team nào). */
export async function getAgentTeam(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<string | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.agentId, agentId))
      .limit(1),
  );
  return rows[0]?.teamId ?? null;
}

// ===== Task board =====

export async function createTeamTask(
  db: Db,
  ctx: WorkspaceContext,
  input: { teamId: string; title: string; description?: string },
): Promise<TeamTaskRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(teamTasks)
      .values({
        workspaceId: ctx.workspaceId,
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? "",
      })
      .returning(),
  );
  return rows[0]!;
}

export async function listTeamTasks(db: Db, ctx: WorkspaceContext, teamId: string) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(teamTasks)
      .where(eq(teamTasks.teamId, teamId))
      .orderBy(asc(teamTasks.createdAt)),
  );
}

/** Claim 1 task todo (atomic, SKIP LOCKED). Null nếu không còn task. */
export async function claimTeamTask(
  db: Db,
  ctx: WorkspaceContext,
  teamId: string,
  agentId: string,
): Promise<{ id: string; title: string; description: string } | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM claim_team_task(${teamId}, ${agentId})`);
    const r = res.rows[0] as { id: string; title: string; description: string } | undefined;
    return r ?? null;
  });
}

export async function completeTeamTask(
  db: Db,
  ctx: WorkspaceContext,
  taskId: string,
  result: string,
  status: "done" | "failed" = "done",
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .update(teamTasks)
      .set({ status, result, updatedAt: new Date() })
      .where(eq(teamTasks.id, taskId)),
  );
}

// ===== Delegation links =====

export async function createAgentLink(
  db: Db,
  ctx: WorkspaceContext,
  fromAgentId: string,
  toAgentId: string,
  mode: "sync" | "async" = "sync",
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(agentLinks)
      .values({ workspaceId: ctx.workspaceId, fromAgentId, toAgentId, mode })
      .onConflictDoNothing(),
  );
}

export async function canDelegate(
  db: Db,
  ctx: WorkspaceContext,
  fromAgentId: string,
  toAgentId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: agentLinks.id })
      .from(agentLinks)
      .where(and(eq(agentLinks.fromAgentId, fromAgentId), eq(agentLinks.toAgentId, toAgentId)))
      .limit(1),
  );
  return rows.length > 0;
}

export async function listAgentLinks(db: Db, ctx: WorkspaceContext, fromAgentId: string) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(agentLinks).where(eq(agentLinks.fromAgentId, fromAgentId)),
  );
}
