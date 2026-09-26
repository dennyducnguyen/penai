import { desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { agents, llmProviders } from "./schema.js";

export type LlmProviderKind = "openai" | "gemini" | "qwen" | "openai-compat" | "anthropic";

export type LlmProviderRow = typeof llmProviders.$inferSelect;

export async function createLlmProvider(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    name: string;
    kind: LlmProviderKind;
    baseUrl?: string;
    apiKeyEncrypted?: string;
    defaultModel?: string;
    defaultEmbeddingModel?: string;
    embeddingDimensions?: number;
    isDefaultEmbedding?: boolean;
  },
): Promise<LlmProviderRow> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    if (input.isDefaultEmbedding) {
      await tx.update(llmProviders).set({ isDefaultEmbedding: false, updatedAt: new Date() });
    }
    return tx
      .insert(llmProviders)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl ?? null,
        apiKeyEncrypted: input.apiKeyEncrypted ?? null,
        defaultModel: input.defaultModel ?? null,
        defaultEmbeddingModel: input.defaultEmbeddingModel ?? null,
        embeddingDimensions: input.embeddingDimensions ?? null,
        isDefaultEmbedding: input.isDefaultEmbedding ?? false,
      })
      .returning();
  });
  return rows[0]!;
}

export async function listLlmProviders(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(llmProviders).orderBy(desc(llmProviders.createdAt)),
  );
}

export async function updateLlmProvider(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<{
    baseUrl: string | null;
    apiKeyEncrypted: string | null;
    defaultModel: string | null;
    defaultEmbeddingModel: string | null;
    embeddingDimensions: number | null;
    isDefaultEmbedding: boolean;
    enabled: boolean;
  }>,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, async (tx) => {
    if (patch.isDefaultEmbedding) {
      await tx.update(llmProviders).set({ isDefaultEmbedding: false, updatedAt: new Date() });
    }
    return tx
      .update(llmProviders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(llmProviders.id, id))
      .returning({ id: llmProviders.id });
  });
  return rows.length > 0;
}

export async function countAgentsUsingProvider(
  db: Db,
  ctx: WorkspaceContext,
  name: string,
): Promise<number> {
  return withWorkspace(db, ctx, async (tx) => {
    const result = await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM ${agents}
      WHERE ${agents.provider} = ${name}
         OR ${agents.providerFallback} @> ${JSON.stringify([{ provider: name }])}::jsonb
    `);
    return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
  });
}

export async function deleteLlmProvider(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(llmProviders).where(eq(llmProviders.id, id)).returning({ id: llmProviders.id }),
  );
  return rows.length > 0;
}

export interface EnabledLlmProvider {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
  defaultModel: string | null;
  defaultEmbeddingModel: string | null;
  embeddingDimensions: number | null;
  isDefaultEmbedding: boolean;
}

/** Boot: mọi provider enabled (SECURITY DEFINER — không cần workspace context). */
export async function listEnabledLlmProviders(db: Db): Promise<EnabledLlmProvider[]> {
  const res = await db.execute(sql`SELECT * FROM list_enabled_llm_providers()`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    kind: r.kind as string,
    baseUrl: (r.base_url as string) ?? null,
    apiKeyEncrypted: (r.api_key_encrypted as string) ?? null,
    defaultModel: (r.default_model as string) ?? null,
    defaultEmbeddingModel: (r.default_embedding_model as string) ?? null,
    embeddingDimensions: (r.embedding_dimensions as number) ?? null,
    isDefaultEmbedding: Boolean(r.is_default_embedding),
  }));
}
