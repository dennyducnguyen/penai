import { desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { publishedFiles } from "./schema.js";

export type PublishedFileRow = typeof publishedFiles.$inferSelect;

export async function createPublishedFile(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    tokenHash: string;
    absPath: string;
    fileName: string;
    contentType: string;
    createdBy: string;
    expiresAt: Date;
  },
): Promise<PublishedFileRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(publishedFiles)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .returning(),
  );
  return rows[0]!;
}

export interface PublishedFileLookup {
  id: string;
  workspaceId: string;
  absPath: string;
  fileName: string;
  contentType: string;
  expiresAt: Date;
  revoked: boolean;
}

/** Route public GET /f/:token — không có workspace context, tra qua SECURITY DEFINER. */
export async function getPublishedFileByHash(
  db: Db,
  tokenHash: string,
): Promise<PublishedFileLookup | null> {
  const res = await db.execute(sql`SELECT * FROM get_published_file(${tokenHash})`);
  const r = (res.rows as Array<Record<string, unknown>>)[0];
  if (!r) return null;
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    absPath: r.abs_path as string,
    fileName: r.file_name as string,
    contentType: r.content_type as string,
    expiresAt: new Date(r.expires_at as string),
    revoked: r.revoked as boolean,
  };
}

export async function listPublishedFiles(
  db: Db,
  ctx: WorkspaceContext,
  limit = 100,
): Promise<PublishedFileRow[]> {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(publishedFiles)
      .orderBy(desc(publishedFiles.createdAt))
      .limit(limit),
  );
}

export async function revokePublishedFile(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(publishedFiles)
      .set({ revoked: true })
      .where(eq(publishedFiles.id, id))
      .returning({ id: publishedFiles.id }),
  );
  return rows.length > 0;
}
