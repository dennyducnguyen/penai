import { asc, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext, WorkspaceRole } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import {
  agents,
  vaultChunks,
  vaultCollectionGrants,
  vaultCollections,
  vaultDocuments,
  vaultIngestionJobs,
  vaultSettings,
} from "./schema.js";

export interface VaultAccessContext {
  agentId: string;
  principalId?: string;
  conversationId?: string;
  role?: WorkspaceRole;
}

export interface VaultChunkInput {
  ordinal: number;
  headingPath: string;
  content: string;
  searchText: string;
  tokenCount: number;
  embedding?: number[];
  embeddingModel?: string;
}

export interface VaultCandidate {
  chunkId: string;
  documentId: string;
  collectionId: string;
  collectionName: string;
  collectionPriority: number;
  retrievalMode: "auto" | "always_full" | "search_only";
  slug: string;
  title: string;
  ordinal: number;
  headingPath: string;
  content: string;
  tokenCount: number;
  score: number;
}

/** Tài liệu đầy đủ (dùng cho đường nạp TOÀN VĂN vào context). */
export interface VaultFullDocument {
  documentId: string;
  collectionId: string;
  collectionName: string;
  collectionPriority: number;
  slug: string;
  title: string;
  content: string;
  tokenCount: number;
}

export type VaultSettingsRow = typeof vaultSettings.$inferSelect;
export type VaultCollectionRow = typeof vaultCollections.$inferSelect;
export type VaultGrantRow = typeof vaultCollectionGrants.$inferSelect;

export async function getVaultSettings(db: Db, ctx: WorkspaceContext): Promise<VaultSettingsRow> {
  return withWorkspace(db, ctx, async (tx) => {
    // Đọc trước — hàm này chạy trên MỌI lượt chat, không được ghi-khi-đọc
    const existing = await tx.select().from(vaultSettings).limit(1);
    if (existing[0]) return existing[0];
    const rows = await tx
      .insert(vaultSettings)
      .values({ workspaceId: ctx.workspaceId })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];
    const retry = await tx.select().from(vaultSettings).limit(1);
    return retry[0]!;
  });
}

export async function updateVaultSettings(
  db: Db,
  ctx: WorkspaceContext,
  patch: Partial<Pick<VaultSettingsRow, "chunkTokens" | "chunkOverlapTokens" | "contextTokens" | "retrievalLimit" | "autoRetrieve" | "fullDocTokens">>,
): Promise<VaultSettingsRow> {
  await getVaultSettings(db, ctx);
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(vaultSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(vaultSettings.workspaceId, ctx.workspaceId))
      .returning(),
  );
  return rows[0]!;
}

export async function listVaultCollections(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(vaultCollections).orderBy(desc(vaultCollections.isDefault), desc(vaultCollections.priority), asc(vaultCollections.name)),
  );
}

export async function getVaultCollection(db: Db, ctx: WorkspaceContext, id: string) {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(vaultCollections).where(eq(vaultCollections.id, id)).limit(1),
  );
  return rows[0] ?? null;
}

export async function getDefaultVaultCollection(db: Db, ctx: WorkspaceContext): Promise<VaultCollectionRow> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx.select().from(vaultCollections).where(eq(vaultCollections.isDefault, true)).limit(1);
    if (rows[0]) return rows[0];
    const created = await tx
      .insert(vaultCollections)
      .values({
        workspaceId: ctx.workspaceId,
        slug: "kho-dung-chung",
        name: "Kho dùng chung",
        description: "Collection mặc định",
        isDefault: true,
      })
      .returning();
    await tx.insert(vaultCollectionGrants).values({
      workspaceId: ctx.workspaceId,
      collectionId: created[0]!.id,
      audienceType: "all",
    });
    return created[0]!;
  });
}

export async function createVaultCollection(
  db: Db,
  ctx: WorkspaceContext,
  input: { slug: string; name: string; description?: string; priority?: number },
): Promise<VaultCollectionRow> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    const created = await tx
      .insert(vaultCollections)
      .values({ workspaceId: ctx.workspaceId, ...input, description: input.description ?? "", priority: input.priority ?? 0 })
      .returning();
    await tx.insert(vaultCollectionGrants).values({
      workspaceId: ctx.workspaceId,
      collectionId: created[0]!.id,
      audienceType: "all",
    });
    return created;
  });
  return rows[0]!;
}

export async function updateVaultCollection(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<Pick<VaultCollectionRow, "name" | "description" | "enabled" | "priority" | "retrievalMode">>,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(vaultCollections).set({ ...patch, updatedAt: new Date() }).where(eq(vaultCollections.id, id)).returning({ id: vaultCollections.id }),
  );
  return rows.length > 0;
}

export async function deleteVaultCollection(db: Db, ctx: WorkspaceContext, id: string): Promise<"deleted" | "default" | "not_empty" | "missing"> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx.select().from(vaultCollections).where(eq(vaultCollections.id, id)).limit(1);
    if (!rows[0]) return "missing";
    if (rows[0].isDefault) return "default";
    const docs = await tx.select({ id: vaultDocuments.id }).from(vaultDocuments).where(eq(vaultDocuments.collectionId, id)).limit(1);
    if (docs[0]) return "not_empty";
    await tx.delete(vaultCollections).where(eq(vaultCollections.id, id));
    return "deleted";
  });
}

export async function listVaultCollectionGrants(db: Db, ctx: WorkspaceContext, collectionId?: string) {
  return withWorkspace(db, ctx, (tx) => {
    const q = tx.select().from(vaultCollectionGrants);
    return collectionId ? q.where(eq(vaultCollectionGrants.collectionId, collectionId)) : q;
  });
}

export async function replaceVaultCollectionGrants(
  db: Db,
  ctx: WorkspaceContext,
  collectionId: string,
  grants: Array<{
    agentId?: string;
    audienceType: "all" | "principal" | "conversation" | "role";
    principalId?: string;
    conversationId?: string;
    role?: WorkspaceRole;
  }>,
): Promise<void> {
  await withWorkspace(db, ctx, async (tx) => {
    const collection = await tx.select({ id: vaultCollections.id }).from(vaultCollections).where(eq(vaultCollections.id, collectionId)).limit(1);
    if (!collection[0]) throw new Error("Collection không tồn tại");
    await tx.delete(vaultCollectionGrants).where(eq(vaultCollectionGrants.collectionId, collectionId));
    if (!grants.length) return;
    await tx.insert(vaultCollectionGrants).values(
      grants.map((grant) => ({
        workspaceId: ctx.workspaceId,
        collectionId,
        agentId: grant.agentId ?? null,
        audienceType: grant.audienceType,
        principalId: grant.principalId ?? null,
        conversationId: grant.conversationId ?? null,
        role: grant.role ?? null,
      })),
    );
  });
}

export async function markVaultDocumentIndexing(
  db: Db,
  ctx: WorkspaceContext,
  documentId: string,
  input: { providerName?: string; embeddingModel?: string; chunkTokens: number },
): Promise<string> {
  return withWorkspace(db, ctx, async (tx) => {
    await tx.update(vaultDocuments).set({ indexStatus: "indexing", indexError: null }).where(eq(vaultDocuments.id, documentId));
    const rows = await tx
      .insert(vaultIngestionJobs)
      .values({
        workspaceId: ctx.workspaceId,
        documentId,
        status: "running",
        providerName: input.providerName ?? null,
        embeddingModel: input.embeddingModel ?? null,
        chunkTokens: input.chunkTokens,
        startedAt: new Date(),
      })
      .returning({ id: vaultIngestionJobs.id });
    return rows[0]!.id;
  });
}

export async function completeVaultDocumentIndex(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    documentId: string;
    jobId: string;
    chunks: VaultChunkInput[];
    documentTokenCount: number;
    indexVersion: number;
    /** Hash nội dung TẠI LÚC chunk/embed — nội dung đã đổi thì bỏ kết quả (chống race 2 lần lưu song song). */
    expectedContentHash?: string;
  },
): Promise<"ok" | "stale"> {
  return withWorkspace(db, ctx, async (tx) => {
    const docs = await tx
      .select({ collectionId: vaultDocuments.collectionId, contentHash: vaultDocuments.contentHash })
      .from(vaultDocuments)
      .where(eq(vaultDocuments.id, input.documentId))
      .limit(1);
    if (!docs[0]) throw new Error("Tài liệu không tồn tại");
    if (input.expectedContentHash && docs[0].contentHash !== input.expectedContentHash) {
      // Một lượt lưu mới hơn đã đổi nội dung — job này lỗi thời, không được ghi đè
      await tx
        .update(vaultIngestionJobs)
        .set({ status: "stale", finishedAt: new Date() })
        .where(eq(vaultIngestionJobs.id, input.jobId));
      return "stale";
    }
    await tx.delete(vaultChunks).where(eq(vaultChunks.documentId, input.documentId));
    if (input.chunks.length) {
      await tx.insert(vaultChunks).values(input.chunks.map((chunk) => ({
        workspaceId: ctx.workspaceId,
        collectionId: docs[0]!.collectionId,
        documentId: input.documentId,
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        content: chunk.content,
        searchText: chunk.searchText,
        tokenCount: chunk.tokenCount,
        embedding: chunk.embedding ?? null,
        embeddingModel: chunk.embeddingModel ?? null,
        indexVersion: input.indexVersion,
      })));
    }
    await tx.update(vaultDocuments).set({
      indexStatus: "ready",
      indexError: null,
      tokenCount: input.documentTokenCount,
      chunkCount: input.chunks.length,
      indexVersion: input.indexVersion,
      updatedAt: new Date(),
    }).where(eq(vaultDocuments.id, input.documentId));
    await tx.update(vaultIngestionJobs).set({ status: "complete", finishedAt: new Date() }).where(eq(vaultIngestionJobs.id, input.jobId));
    return "ok" as const;
  });
}

/**
 * Toàn bộ tài liệu ready trong các Collection retrieval_mode='always_full'
 * mà access context được phép — nạp nguyên văn vào MỌI lượt chat.
 */
export async function listAlwaysFullDocuments(
  db: Db,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
): Promise<VaultFullDocument[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT d.id AS document_id, d.collection_id, c.name AS collection_name,
             c.priority AS collection_priority, d.slug, d.title, d.content, d.token_count
      FROM vault_documents d
      JOIN vault_collections c ON c.id = d.collection_id
      WHERE c.retrieval_mode = 'always_full' AND ${aclSql(access)}
      ORDER BY c.priority DESC, d.updated_at DESC
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      documentId: r.document_id as string,
      collectionId: r.collection_id as string,
      collectionName: r.collection_name as string,
      collectionPriority: Number(r.collection_priority ?? 0),
      slug: r.slug as string,
      title: r.title as string,
      content: r.content as string,
      tokenCount: Number(r.token_count),
    }));
  });
}

export async function failVaultDocumentIndex(db: Db, ctx: WorkspaceContext, documentId: string, jobId: string | undefined, error: string): Promise<void> {
  await withWorkspace(db, ctx, async (tx) => {
    await tx.update(vaultDocuments).set({ indexStatus: "error", indexError: error.slice(0, 2000) }).where(eq(vaultDocuments.id, documentId));
    if (jobId) await tx.update(vaultIngestionJobs).set({ status: "error", error: error.slice(0, 2000), finishedAt: new Date() }).where(eq(vaultIngestionJobs.id, jobId));
  });
}

function ftsExpression(query: string): string {
  return [...new Set(query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").split(/[^a-z0-9]+/).filter((v) => v.length >= 2))]
    .slice(0, 16)
    .map((v) => `${v}:*`)
    .join(" | ");
}

const candidateColumns = sql.raw(`
  ch.id AS chunk_id, ch.document_id, ch.collection_id,
  c.name AS collection_name, c.priority AS collection_priority,
  c.retrieval_mode, d.slug, d.title, ch.ordinal,
  ch.heading_path, ch.content, ch.token_count
`);

function mapCandidates(rows: Array<Record<string, unknown>>, scoreColumn: string): VaultCandidate[] {
  return rows.map((r) => ({
    chunkId: r.chunk_id as string,
    documentId: r.document_id as string,
    collectionId: r.collection_id as string,
    collectionName: r.collection_name as string,
    collectionPriority: Number(r.collection_priority ?? 0),
    retrievalMode: (r.retrieval_mode as VaultCandidate["retrievalMode"]) ?? "auto",
    slug: r.slug as string,
    title: r.title as string,
    ordinal: Number(r.ordinal),
    headingPath: (r.heading_path as string) ?? "",
    content: r.content as string,
    tokenCount: Number(r.token_count),
    score: Number(r[scoreColumn] ?? 0),
  }));
}

function aclSql(access: VaultAccessContext) {
  return sql`
    c.enabled AND d.index_status = 'ready'
    AND EXISTS (
      SELECT 1 FROM vault_collection_grants g
      WHERE g.collection_id = c.id
        AND (g.agent_id IS NULL OR g.agent_id = ${access.agentId})
        AND (
          g.audience_type = 'all'
          OR (g.audience_type = 'principal' AND g.principal_id = ${access.principalId ?? null})
          OR (g.audience_type = 'conversation' AND g.conversation_id = ${access.conversationId ?? null})
          OR (g.audience_type = 'role' AND g.role = ${access.role ?? null})
        )
    )
  `;
}

export async function searchVaultLexical(
  db: Db,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  query: string,
  limit: number,
): Promise<VaultCandidate[]> {
  const fts = ftsExpression(query);
  if (!fts) return [];
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT ${candidateColumns}, ts_rank_cd(ch.tsv, to_tsquery('simple', ${fts})) AS lexical_score
      FROM vault_chunks ch
      JOIN vault_documents d ON d.id = ch.document_id
      JOIN vault_collections c ON c.id = ch.collection_id
      WHERE ${aclSql(access)}
        AND ch.tsv @@ to_tsquery('simple', ${fts})
      ORDER BY lexical_score DESC, c.priority DESC, d.updated_at DESC
      LIMIT ${limit}
    `);
    return mapCandidates(res.rows as Array<Record<string, unknown>>, "lexical_score");
  });
}

export async function searchVaultVector(
  db: Db,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  vector: number[],
  embeddingModel: string,
  limit: number,
): Promise<VaultCandidate[]> {
  const encoded = `[${vector.join(",")}]`;
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT ${candidateColumns}, 1 - (ch.embedding <=> ${encoded}::vector) AS vector_score
      FROM vault_chunks ch
      JOIN vault_documents d ON d.id = ch.document_id
      JOIN vault_collections c ON c.id = ch.collection_id
      WHERE ${aclSql(access)}
        AND ch.embedding IS NOT NULL AND ch.embedding_model = ${embeddingModel}
      ORDER BY ch.embedding <=> ${encoded}::vector
      LIMIT ${limit}
    `);
    return mapCandidates(res.rows as Array<Record<string, unknown>>, "vector_score");
  });
}

export async function getAccessibleVaultDocument(
  db: Db,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  slug: string,
) {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT d.*, c.name AS collection_name
      FROM vault_documents d JOIN vault_collections c ON c.id = d.collection_id
      WHERE d.slug = ${slug} AND ${aclSql(access)}
      LIMIT 1
    `);
    return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
  });
}

export async function getAccessibleNeighborChunks(
  db: Db,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  documentId: string,
  fromOrdinal: number,
  toOrdinal: number,
): Promise<VaultCandidate[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT ${candidateColumns}, 0::float AS neighbor_score
      FROM vault_chunks ch
      JOIN vault_documents d ON d.id = ch.document_id
      JOIN vault_collections c ON c.id = ch.collection_id
      WHERE ${aclSql(access)} AND d.id = ${documentId}
        AND ch.ordinal BETWEEN ${fromOrdinal} AND ${toOrdinal}
      ORDER BY ch.ordinal
    `);
    return mapCandidates(res.rows as Array<Record<string, unknown>>, "neighbor_score");
  });
}

export async function listVaultDocumentsForReindex(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select().from(vaultDocuments).orderBy(asc(vaultDocuments.createdAt)));
}

export async function listVaultAccessAgents(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) => tx.select({ id: agents.id, key: agents.key, name: agents.name }).from(agents).orderBy(asc(agents.name)));
}
