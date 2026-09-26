import { logger, type WorkspaceContext } from "@penai/shared";
import {
  completeVaultDocumentIndex,
  failVaultDocumentIndex,
  getAccessibleNeighborChunks,
  getAccessibleVaultDocument,
  getVaultSettings,
  listAlwaysFullDocuments,
  listLlmProviders,
  listVaultDocumentsForReindex,
  markVaultDocumentIndexing,
  searchVaultLexical,
  searchVaultVector,
  upsertVaultDoc,
  type DbHandle,
  type VaultAccessContext,
  type VaultCandidate,
  type VaultDocRow,
  type VaultSettingsRow,
} from "@penai/db";
import { isEmbeddingProvider, type EmbeddingProvider, type Provider, type ProviderRegistry } from "@penai/providers";
import { chunkVaultMarkdown, estimateTokens, normalizeVaultText } from "./vault-chunker.js";

export interface VaultRuntimeDeps {
  db: DbHandle;
  providers: ProviderRegistry;
}

export interface HybridVaultHit extends VaultCandidate {
  rrfScore: number;
  sources: Array<"lexical" | "vector">;
}

interface EmbeddingRuntime {
  providerName: string;
  model: string;
  dimensions: number;
  provider: Provider & EmbeddingProvider;
}

async function resolveEmbeddingRuntime(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
): Promise<EmbeddingRuntime | null> {
  const rows = await listLlmProviders(rt.db.db, ctx);
  const row = rows.find((p) => p.enabled && p.isDefaultEmbedding && p.defaultEmbeddingModel);
  if (!row?.defaultEmbeddingModel) return null;
  if (row.embeddingDimensions !== 768) {
    logger.warn(`Vault: provider embedding mặc định ${row.name} không phải 768D`);
    return null;
  }
  try {
    const provider = rt.providers.get(row.name, ctx.workspaceId);
    if (!isEmbeddingProvider(provider)) return null;
    return {
      providerName: row.name,
      model: row.defaultEmbeddingModel,
      dimensions: row.embeddingDimensions,
      provider,
    };
  } catch (error) {
    logger.warn(`Vault: không nạp được provider embedding ${row.name}: ${(error as Error).message}`);
    return null;
  }
}

export async function indexVaultDocument(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
  doc: VaultDocRow,
): Promise<{ chunks: number; embedded: boolean; warning?: string; stale?: boolean }> {
  const settings = await getVaultSettings(rt.db.db, ctx);
  const embedding = await resolveEmbeddingRuntime(rt, ctx);
  let jobId: string | undefined;
  try {
    jobId = await markVaultDocumentIndexing(rt.db.db, ctx, doc.id, {
      chunkTokens: settings.chunkTokens,
      ...(embedding ? { providerName: embedding.providerName, embeddingModel: embedding.model } : {}),
    });
    const chunks = chunkVaultMarkdown(doc.content, settings.chunkTokens, settings.chunkOverlapTokens);
    let vectors: number[][] | undefined;
    let warning: string | undefined;
    if (embedding && chunks.length) {
      try {
        vectors = [];
        const batchSize = 24;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          // Title nằm trong input text (KHÔNG truyền param title — gemini sẽ
          // prepend thêm lần nữa thành trùng lặp; các provider khác lại bỏ qua).
          const result = await embedding.provider.embed({
            model: embedding.model,
            dimensions: embedding.dimensions,
            inputType: "document",
            inputs: batch.map((chunk) => `${doc.title}\n${chunk.headingPath}\n${chunk.content}`),
          });
          if (result.vectors.length !== batch.length || result.vectors.some((v) => v.length !== 768)) {
            throw new Error("Provider trả số vector hoặc số chiều không hợp lệ");
          }
          vectors.push(...result.vectors);
        }
      } catch (error) {
        vectors = undefined;
        warning = `Embedding lỗi, index FTS-only: ${(error as Error).message}`;
        logger.warn(`Vault ${doc.slug}: ${warning}`);
      }
    } else if (!embedding) {
      warning = "Chưa có provider embedding mặc định 768D; index FTS-only";
    }

    const outcome = await completeVaultDocumentIndex(rt.db.db, ctx, {
      documentId: doc.id,
      jobId,
      documentTokenCount: estimateTokens(doc.content),
      indexVersion: doc.indexVersion,
      expectedContentHash: doc.contentHash,
      chunks: chunks.map((chunk, i) => ({
        ...chunk,
        searchText: normalizeVaultText(`${doc.title} ${chunk.headingPath} ${chunk.content}`),
        ...(vectors?.[i] ? { embedding: vectors[i], embeddingModel: embedding!.model } : {}),
      })),
    });
    if (outcome === "stale") {
      logger.warn(`Vault ${doc.slug}: nội dung đã đổi trong lúc index — bỏ kết quả (stale)`);
      return { chunks: chunks.length, embedded: Boolean(vectors), stale: true };
    }
    return { chunks: chunks.length, embedded: Boolean(vectors), ...(warning ? { warning } : {}) };
  } catch (error) {
    await failVaultDocumentIndex(rt.db.db, ctx, doc.id, jobId, (error as Error).message).catch(() => undefined);
    throw error;
  }
}

export function mergeVaultRrf(lexical: VaultCandidate[], vector: VaultCandidate[]): HybridVaultHit[] {
  const merged = new Map<string, HybridVaultHit>();
  const add = (rows: VaultCandidate[], source: "lexical" | "vector") => {
    rows.forEach((row, rank) => {
      const score = 1 / (60 + rank + 1);
      const hit = merged.get(row.chunkId);
      if (hit) {
        hit.rrfScore += score;
        if (!hit.sources.includes(source)) hit.sources.push(source);
      } else {
        merged.set(row.chunkId, { ...row, rrfScore: score, sources: [source] });
      }
    });
  };
  add(lexical, "lexical");
  add(vector, "vector");
  return [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

export async function hybridVaultSearch(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  query: string,
  requestedLimit?: number,
  presetSettings?: VaultSettingsRow,
): Promise<HybridVaultHit[]> {
  const settings = presetSettings ?? (await getVaultSettings(rt.db.db, ctx));
  const safeLimit = Number.isFinite(requestedLimit) ? requestedLimit : undefined;
  const limit = Math.max(1, Math.min(safeLimit ?? settings.retrievalLimit, 30));
  const candidateLimit = Math.min(60, limit * 4);
  const lexicalPromise = searchVaultLexical(rt.db.db, ctx, access, query, candidateLimit);
  let vectorPromise: Promise<VaultCandidate[]> = Promise.resolve([]);
  const embedding = await resolveEmbeddingRuntime(rt, ctx);
  if (embedding) {
    vectorPromise = embedding.provider
      .embed({ model: embedding.model, dimensions: 768, inputType: "query", inputs: [query] })
      .then((res) => {
        const vector = res.vectors[0];
        if (!vector || vector.length !== 768) throw new Error("Query embedding không phải 768D");
        return searchVaultVector(rt.db.db, ctx, access, vector, embedding.model, candidateLimit);
      })
      .catch((error) => {
        logger.warn(`Vault query embedding lỗi, fallback FTS: ${(error as Error).message}`);
        return [];
      });
  }
  const [lexical, vector] = await Promise.all([lexicalPromise, vectorPromise]);
  return mergeVaultRrf(lexical, vector).slice(0, limit);
}

function shouldSkipAutoRetrieve(message: string): boolean {
  const text = message.trim();
  if (text.length < 8 || text.startsWith("/")) return true;
  return /^(xin chào|chào|hello|hi|hey|cảm ơn|thanks)[!. ]*$/i.test(text);
}

/** Điểm một tài liệu = tổng điểm RRF các chunk + thưởng nhẹ theo priority collection. */
interface DocScore {
  documentId: string;
  slug: string;
  title: string;
  collectionName: string;
  retrievalMode: VaultCandidate["retrievalMode"];
  score: number;
  hitCount: number;
  hits: HybridVaultHit[];
}

export function aggregateHitsByDocument(hits: HybridVaultHit[]): DocScore[] {
  const byDoc = new Map<string, DocScore>();
  for (const hit of hits) {
    const entry = byDoc.get(hit.documentId) ?? {
      documentId: hit.documentId,
      slug: hit.slug,
      title: hit.title,
      collectionName: hit.collectionName,
      retrievalMode: hit.retrievalMode,
      // thưởng nhẹ theo priority (kẹp ±20): chỉ phân thắng khi điểm RRF sát nhau
      score: Math.max(-20, Math.min(20, hit.collectionPriority)) * 0.0005,
      hitCount: 0,
      hits: [],
    };
    entry.score += hit.rrfScore;
    entry.hitCount += 1;
    entry.hits.push(hit);
    byDoc.set(hit.documentId, entry);
  }
  return [...byDoc.values()].sort((a, b) => b.score - a.score);
}

/**
 * Ráp context "document-first": tài liệu nổi bật được nạp TOÀN VĂN (đọc bản
 * gốc, không ráp chunk), luôn kèm các collection 'always_full'; chỉ tài liệu
 * quá lớn/không nổi bật mới dùng chunk + hàng xóm. Mục tiêu người dùng chốt:
 * "thấy tài liệu phù hợp thì đưa toàn bộ nội dung vào hội thoại để AI trả lời
 * chính xác" — chunk chỉ là mục lục để tìm.
 */
export async function buildVaultContext(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
  access: VaultAccessContext,
  userMessage: string,
): Promise<string> {
  const settings = await getVaultSettings(rt.db.db, ctx);
  const budget = settings.contextTokens;
  const fullDocBudget = Math.min(settings.fullDocTokens, budget);
  let used = 0;
  const sections: string[] = [];
  const fullDocIds = new Set<string>();
  const bigDocNotes: string[] = [];

  const addFullDoc = (doc: {
    documentId: string;
    collectionName: string;
    title: string;
    slug: string;
    content: string;
    tokenCount: number;
  }): boolean => {
    if (fullDocIds.has(doc.documentId)) return true;
    const tokens = doc.tokenCount > 0 ? doc.tokenCount : estimateTokens(doc.content);
    if (tokens > fullDocBudget || used + tokens > budget) return false;
    sections.push(
      `\n[Collection: ${doc.collectionName}] [Tài liệu (TOÀN VĂN): ${doc.title} | slug=${doc.slug}]\n${doc.content}`,
    );
    used += tokens;
    fullDocIds.add(doc.documentId);
    return true;
  };

  // 1. Collection 'always_full': nạp vào mọi lượt chat (đã qua ACL)
  try {
    const pinned = await listAlwaysFullDocuments(rt.db.db, ctx, access);
    for (const doc of pinned) {
      if (!addFullDoc(doc)) {
        logger.warn(
          `Vault: tài liệu always_full "${doc.slug}" (${doc.tokenCount} token) vượt ngân sách — bỏ qua lượt này`,
        );
      }
    }
  } catch (error) {
    logger.warn(`Vault always_full lỗi: ${(error as Error).message}`);
  }

  // 2. Truy hồi theo câu hỏi
  const skipSearch = !settings.autoRetrieve || shouldSkipAutoRetrieve(userMessage);
  if (!skipSearch && used < budget) {
    const hits = await hybridVaultSearch(rt, ctx, access, userMessage, settings.retrievalLimit, settings);
    const docs = aggregateHitsByDocument(hits).filter((d) => !fullDocIds.has(d.documentId));

    // 2a. Tối đa 2 tài liệu nổi bật nhất được nạp toàn văn
    let fullLoaded = 0;
    for (const doc of docs) {
      if (fullLoaded >= 2) break;
      if (doc.retrievalMode === "search_only") continue;
      const row = await getAccessibleVaultDocument(rt.db.db, ctx, access, doc.slug);
      const content = row?.["content"] as string | undefined;
      if (!content) continue;
      const tokenCount = Number(row?.["token_count"] ?? 0) || estimateTokens(content);
      if (
        addFullDoc({
          documentId: doc.documentId,
          collectionName: doc.collectionName,
          title: doc.title,
          slug: doc.slug,
          content,
          tokenCount,
        })
      ) {
        fullLoaded += 1;
      } else {
        bigDocNotes.push(
          `- Tài liệu "${doc.title}" (slug=${doc.slug}, ~${tokenCount} token) dài quá ngân sách — mới trích một phần bên dưới; cần chi tiết khác thì gọi vault_get slug=${doc.slug}.`,
        );
      }
    }

    // 2b. Phần còn lại: chunk trúng + hàng xóm trong ngân sách còn dư
    const selected = new Map<string, VaultCandidate>();
    for (const hit of hits) {
      if (fullDocIds.has(hit.documentId)) continue;
      if (used >= budget) break;
      const neighbors = await getAccessibleNeighborChunks(
        rt.db.db,
        ctx,
        access,
        hit.documentId,
        Math.max(0, hit.ordinal - 1),
        hit.ordinal + 1,
      );
      for (const chunk of neighbors) {
        if (selected.has(chunk.chunkId)) continue;
        if (used + chunk.tokenCount > budget) continue;
        selected.set(chunk.chunkId, chunk);
        used += chunk.tokenCount;
      }
    }
    const grouped = [...selected.values()].sort((a, b) =>
      a.documentId === b.documentId ? a.ordinal - b.ordinal : a.documentId.localeCompare(b.documentId),
    );
    for (const chunk of grouped) {
      sections.push(
        `\n[Collection: ${chunk.collectionName}] [Tài liệu: ${chunk.title} | slug=${chunk.slug}] [Mục: ${chunk.headingPath || "(không tiêu đề)"}] [Chunk ${chunk.ordinal}]\n${chunk.content}`,
      );
    }
  }

  if (!sections.length) return "";
  const lines = [
    "<vault_context>",
    "Nguồn từ Kho tri thức. Trả lời DỰA TRÊN nguồn dưới đây, nêu rõ tài liệu khi trả lời; thông tin không có trong nguồn thì nói không có, không suy diễn.",
    ...(bigDocNotes.length ? ["\n[Ghi chú tài liệu dài]", ...bigDocNotes] : []),
    ...sections,
    "</vault_context>",
  ];
  return lines.join("\n");
}

export function formatVaultHits(hits: HybridVaultHit[]): string {
  if (!hits.length) return "(không tìm thấy tài liệu được phép truy cập phù hợp)";
  return hits
    .map((hit) =>
      `• [${hit.collectionName}] ${hit.slug}: ${hit.title}` +
      `${hit.headingPath ? ` — ${hit.headingPath}` : ""} (chunk ${hit.ordinal}, ${hit.sources.join("+")})\n` +
      `  ${hit.content.replace(/\s+/g, " ").slice(0, 360)}`,
    )
    .join("\n");
}

export async function writeAndIndexVaultDocument(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
  input: { slug: string; title: string; content: string; collectionId?: string; sourceFile?: string },
) {
  const doc = await upsertVaultDoc(rt.db.db, ctx, input);
  // Nội dung + collection không đổi và index còn tốt → bỏ qua re-chunk/re-embed
  if (doc.indexStatus === "ready" && doc.chunkCount > 0) {
    return { doc, index: { chunks: doc.chunkCount, embedded: true, skipped: true } };
  }
  const index = await indexVaultDocument(rt, ctx, doc);
  return { doc, index };
}

export async function reindexVault(
  rt: VaultRuntimeDeps,
  ctx: WorkspaceContext,
): Promise<Array<{ id: string; slug: string; ok: boolean; error?: string }>> {
  const docs = await listVaultDocumentsForReindex(rt.db.db, ctx);
  const out: Array<{ id: string; slug: string; ok: boolean; error?: string }> = [];
  for (const doc of docs) {
    try {
      await indexVaultDocument(rt, ctx, doc);
      out.push({ id: doc.id, slug: doc.slug, ok: true });
    } catch (error) {
      out.push({ id: doc.id, slug: doc.slug, ok: false, error: (error as Error).message });
    }
  }
  return out;
}
