import { and, eq, inArray, sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { loadConfig, type WorkspaceContext } from "../packages/shared/src/index.js";
import {
  addWorkspaceSemanticMemory,
  apiKeys,
  auditLog,
  createApiKey,
  createAgent,
  createDb,
  deleteAgent,
  deleteWorkspaceSemanticMemory,
  updateAgent,
  workspaceMembers,
  withWorkspace,
} from "../packages/db/src/index.js";
import { createProviderRegistry } from "../packages/providers/src/index.js";
import { createDefaultToolRegistry } from "../packages/tools/src/index.js";
import { agentOpts, buildLoopDeps } from "../apps/server/src/agent-runtime.js";
import { buildApp } from "../apps/server/src/app.js";

const workspaceId = process.env.PENAI_SMOKE_WORKSPACE_ID;
if (!workspaceId) throw new Error("Thiếu PENAI_SMOKE_WORKSPACE_ID");

const config = loadConfig();
const db = createDb(config.databaseUrl);
const providers = createProviderRegistry(config.providers);
const tools = createDefaultToolRegistry();
const provider = providers.names()[0];
if (!provider) throw new Error("Không có provider cấu hình để dựng runtime");

const ctx: WorkspaceContext = { workspaceId, userId: workspaceId, role: "ws_admin" };
const suffix = Date.now().toString(36);
let agentId: string | undefined;
const memoryIds: string[] = [];
let apiKeyId: string | undefined;
let apiMemoryId: string | undefined;
let apiActorId: string | undefined;
let app: ReturnType<typeof buildApp> | undefined;

try {
  const agent = await createAgent(db.db, ctx, {
    key: `smoke-workspace-memory-${suffix}`,
    name: "Smoke Workspace Memory",
    provider,
    model: "smoke-model",
  });
  agentId = agent.id;
  const pinnedText = `SMOKE pinned workspace ${suffix}`;
  const relatedText = `SMOKE chính sách đổi trả ${suffix}`;
  const pinned = await addWorkspaceSemanticMemory(db.db, ctx, {
    content: pinnedText,
    importance: 0.2,
    pinned: true,
  });
  const related = await addWorkspaceSemanticMemory(db.db, ctx, {
    content: relatedText,
    importance: 0.9,
    pinned: false,
  });
  if (!pinned || !related) throw new Error("Không tạo được dữ liệu smoke");
  memoryIds.push(pinned.id, related.id);

  const enabledDeps = await buildLoopDeps(
    { db, providers, tools, config },
    ctx,
    agent.provider,
    agentOpts(agent),
  );
  const unrelatedPrefix = await enabledDeps.buildContextPrefix!("xin chào");
  const relatedPrefix = await enabledDeps.buildContextPrefix!("chính sách đổi trả");
  const searchResult = await enabledDeps.memory!.search("chính sách đổi trả", 5);

  const disabledAgent = await updateAgent(db.db, ctx, agent.id, {
    workspaceMemoryEnabled: false,
  });
  if (!disabledAgent) throw new Error("Không tắt được Workspace Semantic trên agent smoke");
  const disabledDeps = await buildLoopDeps(
    { db, providers, tools, config },
    ctx,
    disabledAgent.provider,
    agentOpts(disabledAgent),
  );
  const disabledPrefix = await disabledDeps.buildContextPrefix!("chính sách đổi trả");
  const disabledSearch = await disabledDeps.memory!.search("chính sách đổi trả", 5);

  const members = await withWorkspace(db.db, ctx, (tx) =>
    tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .limit(1),
  );
  apiActorId = members[0]?.userId;
  if (!apiActorId) throw new Error("Workspace smoke không có thành viên để tạo API key tạm");
  const apiCtx: WorkspaceContext = { ...ctx, userId: apiActorId };
  const apiCredential = await createApiKey(db.db, apiCtx, {
    name: `Smoke Workspace Memory ${suffix}`,
    role: "ws_admin",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  apiKeyId = apiCredential.id;
  const authHeaders = { authorization: `Bearer ${apiCredential.apiKey}` };
  const apiText = `SMOKE API workspace ${suffix}`;
  app = buildApp({ db, providers, tools, config });

  const created = await app.inject({
    method: "POST",
    url: "/v1/workspace-memories",
    headers: authHeaders,
    payload: { content: apiText, importance: 0.7 },
  });
  apiMemoryId = (created.json() as { memory?: { id?: string } }).memory?.id;
  if (!apiMemoryId) throw new Error(`API create failed (${created.statusCode}): ${created.body}`);
  memoryIds.push(apiMemoryId);

  const listed = await app.inject({
    method: "GET",
    url: `/v1/workspace-memories?search=${encodeURIComponent("SMOKE API workspace")}`,
    headers: authHeaders,
  });
  const listRows = (listed.json() as { memories?: Array<{ id: string }> }).memories ?? [];
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/workspace-memories/${apiMemoryId}`,
    headers: authHeaders,
    payload: { pinned: true, importance: 0.85 },
  });
  const patchedRow = (patched.json() as { memory?: { pinned?: boolean; importance?: number } }).memory;
  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/workspace-memories/${apiMemoryId}`,
    headers: authHeaders,
  });
  if (deleted.statusCode === 200) {
    memoryIds.splice(memoryIds.indexOf(apiMemoryId), 1);
  }

  const checks = {
    pinnedAlwaysInjected: unrelatedPrefix.includes(pinnedText),
    unpinnedNotInjectedWhenUnrelated: !unrelatedPrefix.includes(relatedText),
    unpinnedRetrievedWhenRelated: relatedPrefix.includes(relatedText),
    memorySearchIncludesWorkspace: searchResult.includes(relatedText),
    disabledRemovesAutoContext:
      !disabledPrefix.includes(pinnedText) && !disabledPrefix.includes(relatedText),
    disabledRemovesMemorySearch: !disabledSearch.includes(relatedText),
    apiCreate: created.statusCode === 201,
    apiSearch: listed.statusCode === 200 && listRows.some((row) => row.id === apiMemoryId),
    apiUpdate:
      patched.statusCode === 200 && patchedRow?.pinned === true && patchedRow.importance === 0.85,
    apiDelete: deleted.statusCode === 200,
  };
  if (Object.values(checks).some((ok) => !ok)) {
    throw new Error(`Smoke failed: ${JSON.stringify(checks)}`);
  }
  console.log(JSON.stringify(checks));
} finally {
  if (app) await app.close().catch(() => undefined);
  for (const id of memoryIds) {
    await deleteWorkspaceSemanticMemory(db.db, ctx, id).catch(() => false);
  }
  if (apiMemoryId) {
    const actorId = apiActorId;
    await withWorkspace(db.db, ctx, (tx) =>
      tx
        .delete(auditLog)
        .where(
          and(
            actorId ? eq(auditLog.actor, actorId) : sql`false`,
            inArray(auditLog.action, [
              "workspace_memory.create",
              "workspace_memory.update",
              "workspace_memory.delete",
            ]),
            sql`${auditLog.detail}->>'id' = ${apiMemoryId}`,
          ),
        ),
    ).catch(() => undefined);
  }
  if (apiKeyId) {
    const keyId = apiKeyId;
    await withWorkspace(db.db, ctx, (tx) =>
      tx.delete(apiKeys).where(eq(apiKeys.id, keyId)),
    ).catch(() => undefined);
  }
  if (agentId) await deleteAgent(db.db, ctx, agentId).catch(() => false);
  await db.close();
}
