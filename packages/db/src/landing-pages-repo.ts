import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { landingPages } from "./schema.js";

export type LandingPageRow = typeof landingPages.$inferSelect;

export async function saveLandingPage(
  db: Db,
  ctx: WorkspaceContext,
  input: { slug: string; title: string; html: string; createdByAgentId?: string },
): Promise<LandingPageRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(landingPages)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .onConflictDoUpdate({
        target: [landingPages.workspaceId, landingPages.slug],
        set: {
          title: input.title,
          html: input.html,
          version: sql`${landingPages.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning(),
  );
  return rows[0]!;
}

export async function getLandingPageBySlug(
  db: Db,
  ctx: WorkspaceContext,
  slug: string,
): Promise<LandingPageRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(landingPages)
      .where(and(eq(landingPages.workspaceId, ctx.workspaceId), eq(landingPages.slug, slug)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listLandingPages(
  db: Db,
  ctx: WorkspaceContext,
  query?: string,
  limit = 50,
): Promise<LandingPageRow[]> {
  const q = query?.trim();
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select()
      .from(landingPages)
      .where(
        q
          ? or(ilike(landingPages.slug, `%${q}%`), ilike(landingPages.title, `%${q}%`))
          : undefined,
      )
      .orderBy(desc(landingPages.updatedAt))
      .limit(limit),
  );
}

export interface PublicLandingPage {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  html: string;
  version: number;
  updatedAt: Date;
}

export async function getPublicLandingPage(
  db: Db,
  id: string,
): Promise<PublicLandingPage | null> {
  const res = await db.execute(sql`SELECT * FROM get_public_landing_page(${id}::uuid)`);
  const r = (res.rows as Array<Record<string, unknown>>)[0];
  if (!r) return null;
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    slug: r.slug as string,
    title: r.title as string,
    html: r.html as string,
    version: Number(r.version),
    updatedAt: new Date(r.updated_at as string),
  };
}
