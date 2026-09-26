import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import {
  skills,
  skillAgentGrants,
  skillFiles,
  skillVersions,
  agents,
  customTools,
  mcpServers,
  mcpAgentGrants,
  mcpUserGrants,
} from "./schema.js";

export type SkillRow = typeof skills.$inferSelect;
export type CustomToolRow = typeof customTools.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;

// ===== Skills =====

export async function createSkill(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    slug: string;
    name: string;
    description: string;
    content: string;
    visibility?: "workspace" | "granted";
  },
): Promise<SkillRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.insert(skills).values({ workspaceId: ctx.workspaceId, ...input }).returning(),
  );
  return rows[0]!;
}

export async function listSkills(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(skills).orderBy(desc(skills.createdAt)),
  );
}

export async function getSkillBySlug(
  db: Db,
  ctx: WorkspaceContext,
  slug: string,
): Promise<SkillRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(skills).where(eq(skills.slug, slug)).limit(1),
  );
  return rows[0] ?? null;
}

export async function updateSkill(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: { name?: string; description?: string; content?: string },
): Promise<SkillRow | null> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.content !== undefined) values.content = patch.content;
  if (!Object.keys(values).length) return null;
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(skills).set(values).where(eq(skills.id, id)).returning(),
  );
  return rows[0] ?? null;
}

export async function deleteSkill(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id }),
  );
  return rows.length > 0;
}

/** Tìm skill theo full-text (tsvector) — trả name+description+slug. */
export async function searchSkills(
  db: Db,
  ctx: WorkspaceContext,
  query: string,
  limit = 5,
): Promise<Array<{ slug: string; name: string; description: string; rank: number }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT slug, name, description,
             ts_rank(tsv, plainto_tsquery('simple', ${query})) AS rank
      FROM skills
      WHERE enabled = true AND tsv @@ plainto_tsquery('simple', ${query})
      ORDER BY rank DESC LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      slug: r.slug as string,
      name: r.name as string,
      description: r.description as string,
      rank: Number(r.rank),
    }));
  });
}

// ===== Skill grants per-agent (skill_agent_grants) =====

/** Bật/tắt skill. */
export async function toggleSkill(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(skills).set({ enabled }).where(eq(skills.id, id)).returning({ id: skills.id }),
  );
  return rows.length > 0;
}

/** Đổi phạm vi skill: workspace (mọi agent) | granted (chỉ agent được cấp). */
export async function setSkillVisibility(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  visibility: "workspace" | "granted",
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(skills).set({ visibility }).where(eq(skills.id, id)).returning({ id: skills.id }),
  );
  return rows.length > 0;
}

export async function grantSkillToAgent(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  agentId: string,
  opts: { canManage?: boolean; grantedBy?: string } = {},
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => {
    const base = tx.insert(skillAgentGrants).values({
      workspaceId: ctx.workspaceId,
      skillId,
      agentId,
      canManage: opts.canManage ?? false,
      grantedBy: opts.grantedBy ?? ctx.userId,
    });
    // Nêu rõ canManage thì grant lại phải cập nhật nó; không nêu thì giữ nguyên
    return opts.canManage === undefined
      ? base.onConflictDoNothing()
      : base.onConflictDoUpdate({
          target: [skillAgentGrants.workspaceId, skillAgentGrants.skillId, skillAgentGrants.agentId],
          set: { canManage: opts.canManage },
        });
  });
}

export async function revokeSkillFromAgent(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .delete(skillAgentGrants)
      .where(
        and(eq(skillAgentGrants.skillId, skillId), eq(skillAgentGrants.agentId, agentId)),
      )
      .returning({ id: skillAgentGrants.id }),
  );
  return rows.length > 0;
}

/** Mọi skill trong workspace kèm cờ granted cho 1 agent — cho UI tab skill. */
export async function listSkillsWithGrantStatus(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<Array<SkillRow & { granted: boolean }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .select({
        skill: skills,
        grantId: skillAgentGrants.id,
      })
      .from(skills)
      .leftJoin(
        skillAgentGrants,
        and(eq(skillAgentGrants.skillId, skills.id), eq(skillAgentGrants.agentId, agentId)),
      )
      .orderBy(desc(skills.createdAt));
    return rows.map((r) => ({ ...r.skill, granted: r.grantId !== null }));
  });
}

/** Skill 1 agent nhìn thấy: enabled && (visibility=workspace || được grant). */
export async function listSkillsForAgent(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<Array<{ slug: string; name: string; description: string }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT s.slug, s.name, s.description
      FROM skills s
      WHERE s.enabled = true
        AND (s.visibility = 'workspace' OR EXISTS (
          SELECT 1 FROM skill_agent_grants g
          WHERE g.skill_id = s.id AND g.agent_id = ${agentId}
        ))
      ORDER BY s.created_at DESC
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      slug: r.slug as string,
      name: r.name as string,
      description: r.description as string,
    }));
  });
}

/** Như searchSkills nhưng chỉ trong phạm vi skill agent thấy được. */
export async function searchSkillsForAgent(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  query: string,
  limit = 5,
): Promise<Array<{ slug: string; name: string; description: string; rank: number }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT s.slug, s.name, s.description,
             ts_rank(s.tsv, plainto_tsquery('simple', ${query})) AS rank
      FROM skills s
      WHERE s.enabled = true AND s.tsv @@ plainto_tsquery('simple', ${query})
        AND (s.visibility = 'workspace' OR EXISTS (
          SELECT 1 FROM skill_agent_grants g
          WHERE g.skill_id = s.id AND g.agent_id = ${agentId}
        ))
      ORDER BY rank DESC LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      slug: r.slug as string,
      name: r.name as string,
      description: r.description as string,
      rank: Number(r.rank),
    }));
  });
}

/** Agent có được phép đọc skill này không (dùng cho use_skill). */
export async function agentCanUseSkill(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  slug: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT 1 FROM skills s
      WHERE s.slug = ${slug} AND s.enabled = true
        AND (s.visibility = 'workspace' OR EXISTS (
          SELECT 1 FROM skill_agent_grants g
          WHERE g.skill_id = s.id AND g.agent_id = ${agentId}
        ))
      LIMIT 1
    `);
    return res.rows;
  });
  return rows.length > 0;
}

// ===== Skill files (scripts/, references/) — DB là nguồn chuẩn =====

export type SkillFileRow = typeof skillFiles.$inferSelect;

export async function getSkillById(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<SkillRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(skills).where(eq(skills.id, id)).limit(1),
  );
  return rows[0] ?? null;
}

export async function listSkillFiles(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
): Promise<SkillFileRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(skillFiles).where(eq(skillFiles.skillId, skillId)).orderBy(skillFiles.path),
  );
}

export async function upsertSkillFile(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  path: string,
  contentB64: string,
): Promise<void> {
  const sizeBytes = Buffer.from(contentB64, "base64").length;
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(skillFiles)
      .values({ workspaceId: ctx.workspaceId, skillId, path, contentB64, sizeBytes })
      .onConflictDoUpdate({
        target: [skillFiles.workspaceId, skillFiles.skillId, skillFiles.path],
        set: { contentB64, sizeBytes, updatedAt: new Date() },
      }),
  );
}

export async function deleteSkillFile(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  path: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .delete(skillFiles)
      .where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.path, path)))
      .returning({ id: skillFiles.id }),
  );
  return rows.length > 0;
}

/** Thay toàn bộ file của skill (ZIP import / khôi phục phiên bản). */
export async function replaceSkillFiles(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  files: Array<{ path: string; contentB64: string }>,
): Promise<void> {
  await withWorkspace(db, ctx, async (tx) => {
    await tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId));
    if (files.length) {
      await tx.insert(skillFiles).values(
        files.map((f) => ({
          workspaceId: ctx.workspaceId,
          skillId,
          path: f.path,
          contentB64: f.contentB64,
          sizeBytes: Buffer.from(f.contentB64, "base64").length,
        })),
      );
    }
  });
}

/** Agent có quyền quản lý (sửa/ghi đè) skill này không — dùng cho publish_skill. */
export async function agentCanManageSkill(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  skillId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: skillAgentGrants.id })
      .from(skillAgentGrants)
      .where(
        and(
          eq(skillAgentGrants.skillId, skillId),
          eq(skillAgentGrants.agentId, agentId),
          eq(skillAgentGrants.canManage, true),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/** Boot: metadata skill enabled để materialize SKILL.md ra đĩa. */
export async function listEnabledSkillsForSync(
  db: Db,
): Promise<Array<{ workspaceId: string; slug: string; content: string }>> {
  const res = await db.execute(sql`SELECT * FROM list_enabled_skills_for_sync()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    workspaceId: r.workspace_id as string,
    slug: r.slug as string,
    content: r.content as string,
  }));
}

/** Boot: materialize file skill ra đĩa (mọi workspace, SECURITY DEFINER). */
export async function listAllSkillFiles(
  db: Db,
): Promise<Array<{ workspaceId: string; slug: string; path: string; contentB64: string }>> {
  const res = await db.execute(sql`SELECT * FROM list_all_skill_files()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    workspaceId: r.workspace_id as string,
    slug: r.slug as string,
    path: r.path as string,
    contentB64: r.content_b64 as string,
  }));
}

// ===== Skill versions (snapshot + khôi phục) =====

export type SkillVersionRow = typeof skillVersions.$inferSelect;

const KEEP_VERSIONS = 10;

/** Chụp snapshot skill hiện tại (metadata + SKILL.md + files) vào lịch sử. */
export async function snapshotSkill(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
  note = "",
): Promise<void> {
  await withWorkspace(db, ctx, async (tx) => {
    const s = (await tx.select().from(skills).where(eq(skills.id, skillId)).limit(1))[0];
    if (!s) return;
    const files = await tx.select().from(skillFiles).where(eq(skillFiles.skillId, skillId));
    await tx
      .insert(skillVersions)
      .values({
        workspaceId: ctx.workspaceId,
        skillId,
        version: s.version,
        name: s.name,
        description: s.description,
        content: s.content,
        files: files.map((f) => ({ path: f.path, contentB64: f.contentB64 })),
        note,
      })
      .onConflictDoUpdate({
        target: [skillVersions.workspaceId, skillVersions.skillId, skillVersions.version],
        set: {
          name: s.name,
          description: s.description,
          content: s.content,
          files: files.map((f) => ({ path: f.path, contentB64: f.contentB64 })),
          note,
        },
      });
    // giữ tối đa KEEP_VERSIONS bản gần nhất
    await tx.execute(sql`
      DELETE FROM skill_versions
      WHERE skill_id = ${skillId}
        AND version NOT IN (
          SELECT version FROM skill_versions WHERE skill_id = ${skillId}
          ORDER BY version DESC LIMIT ${KEEP_VERSIONS}
        )
    `);
  });
}

/** Tăng số phiên bản (gọi SAU khi đã snapshot bản cũ). */
export async function bumpSkillVersion(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
): Promise<number> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(skills)
      .set({ version: sql`${skills.version} + 1` })
      .where(eq(skills.id, skillId))
      .returning({ version: skills.version }),
  );
  return rows[0]?.version ?? 1;
}

/** Danh sách phiên bản (không kèm nội dung nặng). */
export async function listSkillVersions(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
): Promise<Array<{ id: string; version: number; name: string; note: string; fileCount: number; createdAt: Date }>> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)),
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    note: r.note,
    fileCount: Array.isArray(r.files) ? (r.files as unknown[]).length : 0,
    createdAt: r.createdAt,
  }));
}

export async function getSkillVersion(
  db: Db,
  ctx: WorkspaceContext,
  versionId: string,
): Promise<SkillVersionRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(skillVersions).where(eq(skillVersions.id, versionId)).limit(1),
  );
  return rows[0] ?? null;
}

// ===== Grants theo chiều skill (cho dialog Phân quyền trong trang Skills) =====

/** Mọi agent trong workspace kèm cờ granted/canManage với 1 skill. */
export async function listAgentsWithSkillGrant(
  db: Db,
  ctx: WorkspaceContext,
  skillId: string,
): Promise<Array<{ agentId: string; key: string; name: string; granted: boolean; canManage: boolean }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .select({
        agentId: agents.id,
        key: agents.key,
        name: agents.name,
        grantId: skillAgentGrants.id,
        canManage: skillAgentGrants.canManage,
      })
      .from(agents)
      .leftJoin(
        skillAgentGrants,
        and(eq(skillAgentGrants.agentId, agents.id), eq(skillAgentGrants.skillId, skillId)),
      )
      .orderBy(agents.key);
    return rows.map((r) => ({
      agentId: r.agentId,
      key: r.key,
      name: r.name,
      granted: r.grantId !== null,
      canManage: r.canManage ?? false,
    }));
  });
}

// ===== Custom tools =====

export interface EnabledCustomTool {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  commandTemplate: string;
  paramsSchema: Record<string, unknown>;
  envEncrypted: string | null;
  requiresApproval: boolean;
}

export async function createCustomTool(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    name: string;
    description: string;
    commandTemplate: string;
    paramsSchema?: Record<string, unknown>;
    envEncrypted?: string;
    requiresApproval?: boolean;
  },
): Promise<CustomToolRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(customTools)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        description: input.description,
        commandTemplate: input.commandTemplate,
        paramsSchema: input.paramsSchema ?? {},
        envEncrypted: input.envEncrypted ?? null,
        requiresApproval: input.requiresApproval ?? true,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function listCustomTools(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(customTools));
}

export async function deleteCustomTool(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(customTools).where(eq(customTools.id, id)).returning({ id: customTools.id }),
  );
  return rows.length > 0;
}

/** Boot: custom tools enabled theo workspace (không cần context). */
export async function listEnabledCustomToolsByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<EnabledCustomTool[]> {
  const res = await db.execute(sql`SELECT * FROM list_enabled_custom_tools()`);
  return (res.rows as Array<Record<string, unknown>>)
    .filter((r) => r.workspace_id === workspaceId)
    .map((r) => ({
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      name: r.name as string,
      description: r.description as string,
      commandTemplate: r.command_template as string,
      paramsSchema: (r.params_schema as Record<string, unknown>) ?? {},
      envEncrypted: (r.env_encrypted as string) ?? null,
      requiresApproval: r.requires_approval as boolean,
    }));
}

// ===== MCP servers =====

export interface EnabledMcpServer {
  id: string;
  workspaceId: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  envEncrypted: string | null;
  visibility: "workspace" | "granted";
  oauthEncrypted: string | null;
}

export async function createMcpServer(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    name: string;
    transport: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    url?: string;
    envEncrypted?: string;
  },
): Promise<McpServerRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(mcpServers)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        transport: input.transport,
        command: input.command ?? null,
        args: input.args ?? [],
        url: input.url ?? null,
        envEncrypted: input.envEncrypted ?? null,
      })
      .returning(),
  );
  return rows[0]!;
}

export async function listMcpServers(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(mcpServers));
}

export async function deleteMcpServer(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(mcpServers).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id }),
  );
  return rows.length > 0;
}

export async function listEnabledMcpServers(db: Db): Promise<EnabledMcpServer[]> {
  const res = await db.execute(sql`SELECT * FROM list_enabled_mcp_servers()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    transport: r.transport as string,
    command: (r.command as string) ?? null,
    args: (r.args as string[]) ?? [],
    url: (r.url as string) ?? null,
    envEncrypted: (r.env_encrypted as string) ?? null,
    visibility: (r.visibility as "workspace" | "granted") ?? "workspace",
    oauthEncrypted: (r.oauth_encrypted as string) ?? null,
  }));
}

// ===== MCP phân quyền theo agent (tương tự skill grants, thêm tool_allow) =====

/** Đổi phạm vi server: workspace (mọi agent) | granted (chỉ agent được cấp). */
export async function setMcpVisibility(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  visibility: "workspace" | "granted",
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(mcpServers).set({ visibility }).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id }),
  );
  return rows.length > 0;
}

export async function grantMcpToAgent(
  db: Db,
  ctx: WorkspaceContext,
  mcpServerId: string,
  agentId: string,
  opts: { toolAllow?: string[]; grantedBy?: string } = {},
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(mcpAgentGrants)
      .values({
        workspaceId: ctx.workspaceId,
        mcpServerId,
        agentId,
        toolAllow: opts.toolAllow ?? [],
        grantedBy: opts.grantedBy ?? ctx.userId,
      })
      .onConflictDoUpdate({
        target: [mcpAgentGrants.workspaceId, mcpAgentGrants.mcpServerId, mcpAgentGrants.agentId],
        set: { toolAllow: opts.toolAllow ?? [] },
      }),
  );
}

export async function revokeMcpFromAgent(
  db: Db,
  ctx: WorkspaceContext,
  mcpServerId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .delete(mcpAgentGrants)
      .where(
        and(eq(mcpAgentGrants.mcpServerId, mcpServerId), eq(mcpAgentGrants.agentId, agentId)),
      )
      .returning({ id: mcpAgentGrants.id }),
  );
  return rows.length > 0;
}

/** Mọi MCP server trong workspace kèm cờ granted cho 1 agent — cho dialog cấu hình agent. */
export async function listMcpWithGrantStatus(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<Array<McpServerRow & { granted: boolean; toolAllow: string[] }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .select({ server: mcpServers, grantId: mcpAgentGrants.id, toolAllow: mcpAgentGrants.toolAllow })
      .from(mcpServers)
      .leftJoin(
        mcpAgentGrants,
        and(eq(mcpAgentGrants.mcpServerId, mcpServers.id), eq(mcpAgentGrants.agentId, agentId)),
      )
      .orderBy(desc(mcpServers.createdAt));
    return rows.map((r) => ({
      ...r.server,
      granted: r.grantId !== null,
      toolAllow: Array.isArray(r.toolAllow) ? (r.toolAllow as string[]) : [],
    }));
  });
}

/**
 * Quyền MCP của 1 agent: map serverId → danh sách tool được phép (null = mọi tool).
 * Server visibility=workspace: mọi agent, mọi tool. visibility=granted: cần grant,
 * tool_allow rỗng = mọi tool của server.
 */
export async function listMcpAccessForAgent(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<Map<string, Set<string> | null>> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT s.id, s.visibility, g.tool_allow
      FROM mcp_servers s
      LEFT JOIN mcp_agent_grants g
        ON g.mcp_server_id = s.id AND g.agent_id = ${agentId}
      WHERE s.enabled = true
        AND (s.visibility = 'workspace' OR g.id IS NOT NULL)
    `);
    const out = new Map<string, Set<string> | null>();
    for (const r of res.rows as Array<Record<string, unknown>>) {
      const allow = Array.isArray(r.tool_allow) ? (r.tool_allow as string[]) : [];
      // visibility=workspace bỏ qua tool_allow (không có grant vẫn full quyền)
      out.set(
        r.id as string,
        r.visibility === "workspace" || allow.length === 0 ? null : new Set(allow),
      );
    }
    return out;
  });
}

// ===== MCP phân quyền theo NGƯỜI DÙNG CUỐI (0021 — mcp_user_grants) =====

/** Đổi chính sách user: all (mọi user đã pair) | granted (chỉ user được cấp). */
export async function setMcpUserPolicy(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  userPolicy: "all" | "granted",
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(mcpServers).set({ userPolicy }).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id }),
  );
  return rows.length > 0;
}

export async function upsertMcpUserGrant(
  db: Db,
  ctx: WorkspaceContext,
  mcpServerId: string,
  userKey: string,
  opts: { enabled?: boolean; toolAllow?: string[]; toolDeny?: string[]; grantedBy?: string } = {},
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(mcpUserGrants)
      .values({
        workspaceId: ctx.workspaceId,
        mcpServerId,
        userKey,
        enabled: opts.enabled ?? true,
        toolAllow: opts.toolAllow ?? [],
        toolDeny: opts.toolDeny ?? [],
        grantedBy: opts.grantedBy ?? ctx.userId,
      })
      .onConflictDoUpdate({
        target: [mcpUserGrants.workspaceId, mcpUserGrants.mcpServerId, mcpUserGrants.userKey],
        set: {
          enabled: opts.enabled ?? true,
          toolAllow: opts.toolAllow ?? [],
          toolDeny: opts.toolDeny ?? [],
        },
      }),
  );
}

export async function revokeMcpUserGrant(
  db: Db,
  ctx: WorkspaceContext,
  mcpServerId: string,
  userKey: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .delete(mcpUserGrants)
      .where(
        and(eq(mcpUserGrants.mcpServerId, mcpServerId), eq(mcpUserGrants.userKey, userKey)),
      )
      .returning({ id: mcpUserGrants.id }),
  );
  return rows.length > 0;
}

/** Grants của 1 server kèm tên hiển thị từ contacts (user_key = kind-external_id). */
export async function listMcpUserGrants(
  db: Db,
  ctx: WorkspaceContext,
  mcpServerId: string,
): Promise<
  Array<{
    userKey: string;
    enabled: boolean;
    toolAllow: string[];
    toolDeny: string[];
    displayName: string | null;
  }>
> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT g.user_key, g.enabled, g.tool_allow, g.tool_deny, c.display_name
      FROM mcp_user_grants g
      LEFT JOIN LATERAL (
        SELECT display_name FROM contacts
        WHERE (channel_kind || '-' || external_id) = g.user_key
        ORDER BY last_seen DESC
        LIMIT 1
      ) c ON true
      WHERE g.mcp_server_id = ${mcpServerId}
      ORDER BY g.created_at DESC
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      userKey: r.user_key as string,
      enabled: r.enabled as boolean,
      toolAllow: Array.isArray(r.tool_allow) ? (r.tool_allow as string[]) : [],
      toolDeny: Array.isArray(r.tool_deny) ? (r.tool_deny as string[]) : [],
      displayName: (r.display_name as string) ?? null,
    }));
  });
}

export interface McpUserAccessRow {
  serverId: string;
  userPolicy: "all" | "granted";
  hasGrant: boolean;
  grantEnabled: boolean;
  toolAllow: string[];
  toolDeny: string[];
}

/**
 * Lớp quyền theo user cho MỌI server enabled trong workspace — dùng để giao
 * với quyền agent mỗi lượt chat (và recheck lúc execute, fail-closed ở caller).
 */
export async function listMcpUserAccess(
  db: Db,
  ctx: WorkspaceContext,
  userKey: string,
): Promise<McpUserAccessRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT s.id, s.user_policy, g.id AS grant_id, g.enabled AS grant_enabled,
             g.tool_allow, g.tool_deny
      FROM mcp_servers s
      LEFT JOIN mcp_user_grants g
        ON g.mcp_server_id = s.id AND g.user_key = ${userKey}
      WHERE s.enabled = true
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      serverId: r.id as string,
      userPolicy: (r.user_policy as "all" | "granted") ?? "all",
      hasGrant: r.grant_id !== null && r.grant_id !== undefined,
      grantEnabled: r.grant_enabled === true,
      toolAllow: Array.isArray(r.tool_allow) ? (r.tool_allow as string[]) : [],
      toolDeny: Array.isArray(r.tool_deny) ? (r.tool_deny as string[]) : [],
    }));
  });
}

/** Lưu / xóa OAuth session (JSON mã hóa) của 1 MCP server. */
export async function saveMcpOauth(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  oauthEncrypted: string | null,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(mcpServers).set({ oauthEncrypted }).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id }),
  );
  return rows.length > 0;
}
