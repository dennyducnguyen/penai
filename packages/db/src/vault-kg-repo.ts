import { desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { vaultCollections, vaultDocuments, kgEntities, kgRelations } from "./schema.js";

export type VaultDocRow = typeof vaultDocuments.$inferSelect;

/** Trích các [[wikilink]] trong nội dung. */
export function extractWikilinks(content: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) out.add(m[1]!.trim());
  return [...out];
}

// ===== Vault =====

export async function upsertVaultDoc(
  db: Db,
  ctx: WorkspaceContext,
  input: { slug: string; title: string; content: string; collectionId?: string; sourceFile?: string },
): Promise<VaultDocRow> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    let collectionId = input.collectionId;
    if (!collectionId) {
      const defaults = await tx
        .select({ id: vaultCollections.id })
        .from(vaultCollections)
        .where(eq(vaultCollections.isDefault, true))
        .limit(1);
      collectionId = defaults[0]?.id;
    }
    if (!collectionId) {
      // Workspace mới chưa từng mở trang Vault → tự tạo Collection mặc định
      // (cùng logic getDefaultVaultCollection) để ghi tài liệu không bị chặn.
      const created = await tx.execute(sql`
        INSERT INTO vault_collections (workspace_id, slug, name, description, is_default)
        VALUES (${ctx.workspaceId}, 'kho-dung-chung', 'Kho dùng chung', 'Collection mặc định', true)
        ON CONFLICT (workspace_id, slug) DO UPDATE SET is_default = true
        RETURNING id
      `);
      collectionId = (created.rows[0] as { id: string }).id;
      await tx.execute(sql`
        INSERT INTO vault_collection_grants (workspace_id, collection_id, audience_type)
        VALUES (${ctx.workspaceId}, ${collectionId}, 'all')
        ON CONFLICT DO NOTHING
      `);
    }
    const contentHash = createHash("sha256").update(input.content).digest("hex");
    // Nội dung + collection không đổi → GIỮ index_status/index_version hiện tại
    // (caller thấy indexStatus='ready' thì bỏ qua re-chunk/re-embed — không tốn
    // tiền API embedding khi upload lại file y hệt).
    const unchanged = sql`vault_documents.content_hash = ${contentHash} AND vault_documents.collection_id = ${collectionId}`;
    return tx
      .insert(vaultDocuments)
      .values({
        workspaceId: ctx.workspaceId,
        collectionId,
        slug: input.slug,
        title: input.title,
        content: input.content,
        contentHash,
        indexStatus: "pending",
        indexError: null,
        tokenCount: Math.max(1, Math.ceil(input.content.length / 4)),
        sourceFile: input.sourceFile ?? null,
      })
      .onConflictDoUpdate({
        target: [vaultDocuments.workspaceId, vaultDocuments.slug],
        set: {
          collectionId,
          title: input.title,
          content: input.content,
          contentHash,
          indexStatus: sql`CASE WHEN ${unchanged} THEN vault_documents.index_status ELSE 'pending' END`,
          indexError: sql`CASE WHEN ${unchanged} THEN vault_documents.index_error ELSE NULL END`,
          updatedAt: new Date(),
          indexVersion: sql`CASE WHEN ${unchanged} THEN vault_documents.index_version ELSE vault_documents.index_version + 1 END`,
          ...(input.sourceFile !== undefined ? { sourceFile: input.sourceFile } : {}),
        },
      })
      .returning();
  });
  return rows[0]!;
}

export async function getVaultDoc(
  db: Db,
  ctx: WorkspaceContext,
  slug: string,
): Promise<VaultDocRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(vaultDocuments).where(eq(vaultDocuments.slug, slug)).limit(1),
  );
  return rows[0] ?? null;
}

export async function listVaultDocs(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(vaultDocuments).orderBy(desc(vaultDocuments.updatedAt)),
  );
}

export async function deleteVaultDoc(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(vaultDocuments).where(eq(vaultDocuments.id, id)).returning({ id: vaultDocuments.id }),
  );
  return rows.length > 0;
}

/** Bỏ dấu tiếng Việt + lowercase; map[i] = vị trí ký tự gốc của ký tự thứ i trong chuỗi chuẩn hóa. */
function normalizeVi(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const base = s[i]!
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d");
    for (const ch of base) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

function tokenizeQuery(q: string): string[] {
  const { norm } = normalizeVi(q);
  return [...new Set(norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 12);
}

function countOccurrences(haystack: string, needle: string, cap: number): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let pos = haystack.indexOf(needle);
  while (pos !== -1 && count < cap) {
    if (first === -1) first = pos;
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return { count, first };
}

/**
 * Tìm tài liệu vault theo từ khóa: không phân biệt dấu tiếng Việt/hoa thường,
 * khớp TỪNG từ khóa (không bắt buộc khớp đủ cả câu như FTS cũ), xếp hạng theo
 * số từ khóa khớp (ưu tiên khớp tiêu đề) và trả kèm trích đoạn quanh chỗ khớp đầu tiên.
 * Chấm điểm trong TS trên toàn bộ doc của workspace — phù hợp quy mô kho tri thức nội bộ.
 */
export async function searchVault(
  db: Db,
  ctx: WorkspaceContext,
  query: string,
  limit = 5,
): Promise<Array<{ slug: string; title: string; rank: number; snippet: string }>> {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];
  const docs = await listVaultDocs(db, ctx);
  const scored: Array<{ slug: string; title: string; rank: number; snippet: string }> = [];
  for (const d of docs) {
    const title = normalizeVi(d.title);
    const content = normalizeVi(d.content);
    let rank = 0;
    let matched = 0;
    let snippetAt = -1;
    for (const t of tokens) {
      const inTitle = countOccurrences(title.norm, t, 2);
      const inContent = countOccurrences(content.norm, t, 5);
      if (inTitle.count === 0 && inContent.count === 0) continue;
      matched++;
      rank += inTitle.count * 5 + inContent.count;
      if (inContent.first !== -1 && (snippetAt === -1 || inContent.first < snippetAt)) {
        snippetAt = inContent.first;
      }
    }
    if (matched === 0) continue;
    rank += (matched / tokens.length) * 10; // thưởng độ phủ: khớp nhiều từ khóa khác nhau xếp trên
    let snippet = "";
    if (snippetAt !== -1) {
      const from = content.map[Math.max(0, snippetAt - 60)]!;
      const to = content.map[Math.min(content.map.length - 1, snippetAt + 120)]! + 1;
      snippet =
        (from > 0 ? "…" : "") +
        d.content.slice(from, to).replace(/\s+/g, " ").trim() +
        (to < d.content.length ? "…" : "");
    }
    scored.push({ slug: d.slug, title: d.title, rank, snippet });
  }
  return scored.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

// ===== Knowledge Graph =====

export async function upsertEntity(
  db: Db,
  ctx: WorkspaceContext,
  input: { name: string; type?: string; summary?: string },
): Promise<string> {
  // Unique index là (workspace_id, lower(name)) — dùng ON CONFLICT expression qua raw SQL.
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO kg_entities (workspace_id, name, type, summary)
      VALUES (${ctx.workspaceId}, ${input.name}, ${input.type ?? "entity"}, ${input.summary ?? ""})
      ON CONFLICT (workspace_id, lower(name)) DO UPDATE
      SET summary = COALESCE(NULLIF(EXCLUDED.summary, ''), kg_entities.summary)
      RETURNING id
    `);
    return (res.rows[0] as { id: string }).id;
  });
}

export async function addRelation(
  db: Db,
  ctx: WorkspaceContext,
  fromEntity: string,
  toEntity: string,
  relation: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.insert(kgRelations).values({
      workspaceId: ctx.workspaceId,
      fromEntity,
      toEntity,
      relation,
    }),
  );
}

export async function findEntityByName(
  db: Db,
  ctx: WorkspaceContext,
  name: string,
): Promise<{ id: string; name: string; summary: string } | null> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, name, summary FROM kg_entities
      WHERE lower(name) = lower(${name}) LIMIT 1
    `);
    return res.rows as Array<{ id: string; name: string; summary: string }>;
  });
  return rows[0] ?? null;
}

/** Duyệt đồ thị từ 1 entity (theo tên) tới độ sâu depth. */
export async function traverseGraph(
  db: Db,
  ctx: WorkspaceContext,
  startName: string,
  depth = 2,
): Promise<Array<{ name: string; relation: string; depth: number }>> {
  return withWorkspace(db, ctx, async (tx) => {
    const start = await tx.execute(sql`
      SELECT id FROM kg_entities WHERE lower(name) = lower(${startName}) LIMIT 1
    `);
    const startId = (start.rows[0] as { id: string } | undefined)?.id;
    if (!startId) return [];
    const res = await tx.execute(sql`SELECT * FROM kg_traverse(${startId}, ${depth})`);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      name: r.name as string,
      relation: r.relation as string,
      depth: Number(r.depth),
    }));
  });
}

export async function listEntities(db: Db, ctx: WorkspaceContext, limit = 100) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(kgEntities).orderBy(desc(kgEntities.createdAt)).limit(limit),
  );
}
