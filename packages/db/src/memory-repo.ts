import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { memories, workspaceSemanticMemories } from "./schema.js";

export type MemoryRow = typeof memories.$inferSelect;
export type MemoryTier = "episodic" | "semantic";
export type WorkspaceSemanticMemoryRow = typeof workspaceSemanticMemories.$inferSelect;

/**
 * Phạm vi ghi nhớ:
 * - userKey = undefined/null → ghi nhớ CHUNG của agent (mọi người dùng thấy)
 * - userKey = "telegram-123" → chỉ người dùng đó thấy
 * Khi truy hồi, agent luôn thấy: memory chung + memory của chính người đang chat.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export async function addMemory(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    agentId: string;
    tier: MemoryTier;
    content: string;
    importance?: number;
    sourceSessionId?: string;
    userKey?: string;
    pinned?: boolean;
  },
): Promise<MemoryRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(memories)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        tier: input.tier,
        content: input.content,
        importance: input.importance ?? 0.5,
        sourceSessionId: input.sourceSessionId ?? null,
        userKey: input.userKey ?? null,
        pinned: input.pinned ?? false,
        contentHash: hashContent(input.content),
      })
      // ghi nhớ trùng nội dung (agent nhắc lại nhiều lần) → bỏ qua, không nhân bản
      .onConflictDoNothing()
      .returning(),
  );
  return rows[0] ?? null;
}

/** Điều kiện phạm vi: memory chung + memory của người dùng đang chat. */
/**
 * Hư từ và đại từ hay gặp trong câu hỏi — bỏ khi dò trí nhớ để câu hỏi tự
 * nhiên ("Cho tôi biết chính sách đổi trả") vẫn khớp ghi nhớ ("Chính sách đổi
 * trả sản phẩm…"). Chỉ gồm từ chức năng, không có từ mang nội dung.
 */
const RECALL_STOPWORDS = new Set(
  (
    "cho tôi mình tớ ta bạn anh chị em ông bà họ nó chúng biết hãy giúp xin vui lòng làm ơn là của và " +
    "có không gì nào được với này đó kia ấy một các những thì mà như để về ở trong ngoài ra vào lên " +
    "xuống từ theo khi nếu nhưng hay hoặc rằng bị sẽ đã đang vẫn cũng rất quá nữa thế sao vậy à ạ " +
    "nhé nha ơi hả nhỉ chứ đâu ai bao nhiêu mấy cái việc điều hỏi muốn xem " +
    "the a an is are was were be to of and or in on at for with by me my you your i we our it this " +
    "that what which who how please tell about can could would do does"
  ).split(" "),
);

/**
 * Tách câu hỏi thành từ khóa để dò trí nhớ. plainto_tsquery bắt MỌI từ phải
 * có mặt nên câu hỏi tự nhiên hầu như không khớp gì; ở đây bỏ hư từ rồi chỉ
 * cần khớp một phần từ khóa (≥ 1 khi có 1–2 từ, ≥ nửa số từ và tối đa 3 khi
 * nhiều hơn), kết quả xếp theo số từ khớp trước, độ liên quan sau.
 */
export function recallTerms(query: string): { terms: string[]; minMatch: number } {
  const seen = new Set<string>();
  for (const word of query.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!RECALL_STOPWORDS.has(word)) seen.add(word);
    if (seen.size >= 12) break;
  }
  const terms = [...seen];
  return { terms, minMatch: terms.length <= 2 ? 1 : Math.min(3, Math.ceil(terms.length / 2)) };
}

/** Phần SQL: tsquery "khớp bất kỳ từ khóa" + biểu thức đếm số từ khóa khớp (cột tsv). */
function recallSql(terms: string[]) {
  return {
    any: sql`to_tsquery('simple', ${terms.join(" | ")})`,
    matched: sql.join(
      terms.map((t) => sql`(tsv @@ to_tsquery('simple', ${t}))::int`),
      sql` + `,
    ),
  };
}

function scopeCond(userKey?: string) {
  return userKey
    ? sql`(user_key IS NULL OR user_key = ${userKey})`
    : sql`user_key IS NULL`;
}

/** L0: fact semantic quan trọng nhất + memory được ghim, luôn nạp vào prompt. */
export async function getL0Memories(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  limit = 10,
  minImportance = 0.7,
  userKey?: string,
): Promise<MemoryRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM memories
      WHERE agent_id = ${agentId}
        AND tier = 'semantic'
        AND (pinned = true OR importance >= ${minImportance})
        AND ${scopeCond(userKey)}
      ORDER BY pinned DESC, importance DESC, created_at DESC
      LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map(mapRow);
  });
}

/**
 * L1: tìm memory liên quan tới query bằng full-text (tsvector), xếp hạng
 * theo ts_rank * (0.5 + importance). Chỉ trong phạm vi người dùng đang chat.
 */
export async function searchMemories(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  query: string,
  limit = 5,
  userKey?: string,
): Promise<Array<MemoryRow & { rank: number }>> {
  const { terms, minMatch } = recallTerms(query);
  if (!terms.length) return [];
  const { any, matched } = recallSql(terms);
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM (
        SELECT *, (${matched}) AS matched, ts_rank(tsv, ${any}) * (0.5 + importance) AS rank
        FROM memories
        WHERE agent_id = ${agentId}
          AND tsv @@ ${any}
          AND ${scopeCond(userKey)}
      ) m
      WHERE m.matched >= ${minMatch}
      ORDER BY m.matched DESC, m.rank DESC
      LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      ...mapRow(r),
      rank: Number(r.rank),
    }));
  });
}

/** Ghi nhận đã dùng memory (phục vụ xếp hạng/dọn dẹp sau này). */
export async function touchMemories(
  db: Db,
  ctx: WorkspaceContext,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed = now()
      WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    `),
  );
}

export async function listMemories(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  limit = 50,
  userKey?: string,
): Promise<MemoryRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = userKey
      ? await tx.execute(sql`
          SELECT * FROM memories
          WHERE agent_id = ${agentId} AND user_key = ${userKey}
          ORDER BY pinned DESC, created_at DESC LIMIT ${limit}
        `)
      : await tx.execute(sql`
          SELECT * FROM memories
          WHERE agent_id = ${agentId}
          ORDER BY pinned DESC, created_at DESC LIMIT ${limit}
        `);
    return (res.rows as Array<Record<string, unknown>>).map(mapRow);
  });
}

/** Danh sách người dùng đang có ghi nhớ riêng (cho bộ lọc trong dashboard). */
export async function listMemoryUserKeys(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
): Promise<string[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT DISTINCT user_key FROM memories
      WHERE agent_id = ${agentId} AND user_key IS NOT NULL
      ORDER BY user_key
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => r.user_key as string);
  });
}

export async function updateMemory(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: { content?: string; importance?: number; pinned?: boolean },
): Promise<MemoryRow | null> {
  const values: Record<string, unknown> = {};
  if (patch.content !== undefined) {
    values.content = patch.content;
    values.contentHash = hashContent(patch.content);
  }
  if (patch.importance !== undefined) values.importance = patch.importance;
  if (patch.pinned !== undefined) values.pinned = patch.pinned;
  if (!Object.keys(values).length) return null;
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(memories).set(values).where(eq(memories.id, id)).returning(),
  );
  return rows[0] ?? null;
}

export async function deleteMemory(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }),
  );
  return rows.length > 0;
}

/** Xóa memory episodic cũ, ít quan trọng, chưa ghim (dọn dẹp định kỳ). */
export async function pruneMemories(
  db: Db,
  ctx: WorkspaceContext,
  opts: { agentId: string; olderThanDays: number; maxImportance?: number },
): Promise<number> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      DELETE FROM memories
      WHERE agent_id = ${opts.agentId}
        AND tier = 'episodic'
        AND pinned = false
        AND importance <= ${opts.maxImportance ?? 0.5}
        AND created_at < now() - (${opts.olderThanDays} || ' days')::interval
      RETURNING id
    `);
    return res.rows.length;
  });
}

// ===== Workspace Semantic (kiến thức dùng chung, không gắn agent/user) =====

export async function addWorkspaceSemanticMemory(
  db: Db,
  ctx: WorkspaceContext,
  input: { content: string; importance?: number; pinned?: boolean },
): Promise<WorkspaceSemanticMemoryRow | null> {
  const content = input.content.trim();
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(workspaceSemanticMemories)
      .values({
        workspaceId: ctx.workspaceId,
        content,
        importance: input.importance ?? 0.8,
        pinned: input.pinned ?? false,
        contentHash: hashContent(content),
      })
      .onConflictDoNothing()
      .returning(),
  );
  return rows[0] ?? null;
}

export async function listWorkspaceSemanticMemories(
  db: Db,
  ctx: WorkspaceContext,
  limit = 100,
): Promise<WorkspaceSemanticMemoryRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(workspaceSemanticMemories)
      .orderBy(
        desc(workspaceSemanticMemories.pinned),
        desc(workspaceSemanticMemories.importance),
        desc(workspaceSemanticMemories.updatedAt),
      )
      .limit(limit),
  );
}

/** Chỉ mục ghim được nạp thường trực; importance không tự biến memory workspace thành L0. */
export async function getPinnedWorkspaceSemanticMemories(
  db: Db,
  ctx: WorkspaceContext,
  limit = 4,
): Promise<WorkspaceSemanticMemoryRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(workspaceSemanticMemories)
      .where(eq(workspaceSemanticMemories.pinned, true))
      .orderBy(
        desc(workspaceSemanticMemories.importance),
        desc(workspaceSemanticMemories.updatedAt),
      )
      .limit(limit),
  );
}

export async function searchWorkspaceSemanticMemories(
  db: Db,
  ctx: WorkspaceContext,
  query: string,
  limit = 5,
): Promise<Array<WorkspaceSemanticMemoryRow & { rank: number }>> {
  const { terms, minMatch } = recallTerms(query);
  if (!terms.length) return [];
  const { any, matched } = recallSql(terms);
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM (
        SELECT *, (${matched}) AS matched, ts_rank(tsv, ${any}) * (0.5 + importance) AS rank
        FROM workspace_semantic_memories
        WHERE tsv @@ ${any}
      ) m
      WHERE m.matched >= ${minMatch}
      ORDER BY m.matched DESC, m.rank DESC, m.updated_at DESC
      LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      ...mapWorkspaceSemanticRow(r),
      rank: Number(r.rank),
    }));
  });
}

export async function updateWorkspaceSemanticMemory(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: { content?: string; importance?: number; pinned?: boolean },
): Promise<WorkspaceSemanticMemoryRow | null> {
  const values: Partial<typeof workspaceSemanticMemories.$inferInsert> = {};
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    values.content = content;
    values.contentHash = hashContent(content);
  }
  if (patch.importance !== undefined) values.importance = patch.importance;
  if (patch.pinned !== undefined) values.pinned = patch.pinned;
  if (!Object.keys(values).length) return null;
  values.updatedAt = new Date();
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(workspaceSemanticMemories)
      .set(values)
      .where(eq(workspaceSemanticMemories.id, id))
      .returning(),
  );
  return rows[0] ?? null;
}

export async function deleteWorkspaceSemanticMemory(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .delete(workspaceSemanticMemories)
      .where(eq(workspaceSemanticMemories.id, id))
      .returning({ id: workspaceSemanticMemories.id }),
  );
  return rows.length > 0;
}

export async function touchWorkspaceSemanticMemories(
  db: Db,
  ctx: WorkspaceContext,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      UPDATE workspace_semantic_memories
      SET access_count = access_count + 1, last_accessed = now()
      WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    `),
  );
}

// ===== Memory dạng FILE (memory_documents) =====

export interface MemoryDocRow {
  id: string;
  workspaceId: string;
  agentId: string;
  userKey: string | null;
  path: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

function mapDocRow(r: Record<string, unknown>): MemoryDocRow {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    userKey: (r.user_key as string) ?? null,
    path: r.path as string,
    content: r.content as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

/** Ghi/cập nhật 1 file ghi nhớ (upsert theo agent + user + path). */
export async function upsertMemoryDoc(
  db: Db,
  ctx: WorkspaceContext,
  input: { agentId: string; path: string; content: string; userKey?: string },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO memory_documents (workspace_id, agent_id, user_key, path, content)
      VALUES (${ctx.workspaceId}, ${input.agentId}, ${input.userKey ?? null}, ${input.path}, ${input.content})
      ON CONFLICT (workspace_id, agent_id, coalesce(user_key, ''), path)
      DO UPDATE SET content = EXCLUDED.content, updated_at = now()
    `),
  );
}

/**
 * Đọc 1 file ghi nhớ theo path. Có userKey thì ưu tiên bản riêng người dùng,
 * không có bản riêng thì rơi về bản chung của agent (user_key NULL).
 */
export async function getMemoryDoc(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  path: string,
  userKey?: string,
): Promise<MemoryDocRow | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM memory_documents
      WHERE agent_id = ${agentId} AND path = ${path}
        AND ${scopeCond(userKey)}
      ORDER BY user_key NULLS LAST
      LIMIT 1
    `);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapDocRow(row) : null;
  });
}

/** Xóa 1 file ghi nhớ đúng scope (không đụng bản của scope khác). */
export async function deleteMemoryDocByPath(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  path: string,
  userKey?: string,
): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      DELETE FROM memory_documents
      WHERE agent_id = ${agentId} AND path = ${path}
        AND ${userKey ? sql`user_key = ${userKey}` : sql`user_key IS NULL`}
      RETURNING id
    `);
    return res.rows.length > 0;
  });
}

export async function deleteMemoryDocById(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(
      sql`DELETE FROM memory_documents WHERE id = ${id} RETURNING id`,
    );
    return res.rows.length > 0;
  });
}

/** Danh sách file ghi nhớ của agent (dashboard: mọi scope; lọc userKey nếu cần). */
export async function listMemoryDocs(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  userKey?: string,
): Promise<Array<Omit<MemoryDocRow, "content"> & { bytes: number }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = userKey
      ? await tx.execute(sql`
          SELECT id, workspace_id, agent_id, user_key, path,
                 octet_length(content) AS bytes, '' AS content, created_at, updated_at
          FROM memory_documents
          WHERE agent_id = ${agentId} AND user_key = ${userKey}
          ORDER BY path
        `)
      : await tx.execute(sql`
          SELECT id, workspace_id, agent_id, user_key, path,
                 octet_length(content) AS bytes, '' AS content, created_at, updated_at
          FROM memory_documents
          WHERE agent_id = ${agentId}
          ORDER BY user_key NULLS FIRST, path
        `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      ...mapDocRow(r),
      bytes: Number(r.bytes),
    }));
  });
}

export async function getMemoryDocById(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<MemoryDocRow | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM memory_documents WHERE id = ${id}`);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapDocRow(row) : null;
  });
}

export interface MemoryDocHit {
  id: string;
  path: string;
  userKey: string | null;
  snippet: string;
  rank: number;
}

/**
 * Tìm trong file ghi nhớ bằng full-text; snippet ts_headline đánh dấu chỗ khớp.
 * Phạm vi như searchMemories: bản chung + bản của người dùng đang chat.
 */
export async function searchMemoryDocs(
  db: Db,
  ctx: WorkspaceContext,
  agentId: string,
  query: string,
  limit = 5,
  userKey?: string,
): Promise<MemoryDocHit[]> {
  const { terms, minMatch } = recallTerms(query);
  if (!terms.length) return [];
  const { any, matched } = recallSql(terms);
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM (
        SELECT id, path, user_key, (${matched}) AS matched,
               ts_rank(tsv, ${any}) AS rank,
               ts_headline('simple', content, ${any},
                 'MaxFragments=2, MaxWords=40, MinWords=10, StartSel=», StopSel=«') AS snippet
        FROM memory_documents
        WHERE agent_id = ${agentId}
          AND tsv @@ ${any}
          AND ${scopeCond(userKey)}
      ) d
      WHERE d.matched >= ${minMatch}
      ORDER BY d.matched DESC, d.rank DESC
      LIMIT ${limit}
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      path: r.path as string,
      userKey: (r.user_key as string) ?? null,
      snippet: r.snippet as string,
      rank: Number(r.rank),
    }));
  });
}

// ===== Consolidation worker (session → memory episodic) =====

export interface SessionNeedingConsolidation {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  lastMsg: Date;
  msgCount: number;
}

/** Cross-workspace (SECURITY DEFINER) — chỉ worker nền dùng. */
export async function listSessionsNeedingConsolidation(
  db: Db,
  opts: { idleMinutes: number; minMessages: number; maxAgeDays: number; limit: number },
): Promise<SessionNeedingConsolidation[]> {
  const res = await db.execute(sql`
    SELECT * FROM list_sessions_needing_consolidation(
      ${opts.idleMinutes}, ${opts.minMessages}, ${opts.maxAgeDays}, ${opts.limit})
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    sessionId: r.session_id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    lastMsg: r.last_msg as Date,
    msgCount: Number(r.msg_count),
  }));
}

/**
 * userKey kênh của 1 session (vd "telegram-123") — để memory episodic từ
 * consolidation được scope đúng người dùng, không rò sang người khác.
 * Session không thuộc kênh nào (dashboard/cron) → null = memory chung.
 */
export async function getSessionChannelUserKey(
  db: Db,
  ctx: WorkspaceContext,
  sessionId: string,
): Promise<string | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT c.kind, cs.chat_key
      FROM channel_sessions cs
      JOIN channels c ON c.id = cs.channel_id
      WHERE cs.session_id = ${sessionId}
      LIMIT 1
    `);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    // chat_key nhóm/topic ("-100..:topic:5") không khớp userKey cá nhân nào →
    // memory sẽ scope theo key đó, người dùng lẻ không thấy (an toàn).
    return `${row.kind as string}-${row.chat_key as string}`;
  });
}

function mapRow(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    tier: r.tier as string,
    content: r.content as string,
    sourceSessionId: (r.source_session_id as string) ?? null,
    importance: r.importance as number,
    embedding: r.embedding ?? null,
    userKey: (r.user_key as string) ?? null,
    pinned: Boolean(r.pinned),
    accessCount: Number(r.access_count ?? 0),
    lastAccessed: (r.last_accessed as Date) ?? null,
    contentHash: (r.content_hash as string) ?? null,
    createdAt: r.created_at as Date,
  } as MemoryRow;
}

function mapWorkspaceSemanticRow(r: Record<string, unknown>): WorkspaceSemanticMemoryRow {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    content: r.content as string,
    importance: Number(r.importance),
    pinned: Boolean(r.pinned),
    accessCount: Number(r.access_count ?? 0),
    lastAccessed: (r.last_accessed as Date) ?? null,
    contentHash: r.content_hash as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}
