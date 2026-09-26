import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, type PenaiConfig, type WorkspaceContext } from "@penai/shared";
import {
  addMemory,
  addWorkspaceSemanticMemory,
  createDb,
  getAgentById,
  type DbHandle,
} from "@penai/db";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry, type ProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry, type ToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";
import { agentOpts, buildLoopDeps } from "../src/agent-runtime.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;
let config: PenaiConfig;
let providers: ProviderRegistry;
let tools: ToolRegistry;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  config = PenaiConfigSchema.parse({
    dataDir: await mkdtemp(join(tmpdir(), "penai-workspace-memory-")),
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  providers = createProviderRegistry(config.providers);
  tools = createDefaultToolRegistry();
  app = buildApp({ db: dbh, providers, tools, config });
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Workspace Semantic API + runtime", () => {
  it("chỉ ws_admin được ghi, mọi role được đọc và RLS cách ly workspace", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aOperator),
      payload: { content: "Không được tạo", importance: 0.8 },
    });
    expect(denied.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aAdmin),
      payload: { content: "Sai mức", importance: 2 },
    });
    expect(invalid.statusCode).toBe(400);

    const pinned = await app.inject({
      method: "POST",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aAdmin),
      payload: {
        content: "Quy tắc workspace luôn xưng hô lịch sự",
        importance: 0.4,
        pinned: true,
      },
    });
    expect(pinned.statusCode).toBe(201);

    const related = await app.inject({
      method: "POST",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aAdmin),
      payload: {
        content: "Chính sách đổi trả sản phẩm trong vòng ba mươi ngày",
        importance: 0.9,
        pinned: false,
      },
    });
    expect(related.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aAdmin),
      payload: { content: "  chính sách đổi trả sản phẩm trong vòng ba mươi ngày  " },
    });
    expect(duplicate.statusCode).toBe(409);

    const listA = await app.inject({
      method: "GET",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.aViewer),
    });
    expect(listA.statusCode).toBe(200);
    expect((listA.json() as { memories: unknown[] }).memories).toHaveLength(2);

    const listB = await app.inject({
      method: "GET",
      url: "/v1/workspace-memories",
      headers: auth(fx.keys.bOperator),
    });
    expect((listB.json() as { memories: unknown[] }).memories).toHaveLength(0);
  });

  it("runtime chỉ luôn nạp mục ghim và truy hồi mục không ghim khi liên quan", async () => {
    const agent = await getAgentById(dbh.db, ctxA(), fx.agentA);
    const enabledDeps = await buildLoopDeps(
      { db: dbh, providers, tools, config },
      ctxA(),
      agent!.provider,
      agentOpts(agent!),
    );
    const unrelated = await enabledDeps.buildContextPrefix!("Xin chào");
    expect(unrelated).toContain("Quy tắc workspace luôn xưng hô lịch sự");
    expect(unrelated).not.toContain("Chính sách đổi trả sản phẩm");

    const related = await enabledDeps.buildContextPrefix!("Cho tôi biết chính sách đổi trả");
    expect(related).toContain("Quy tắc workspace luôn xưng hô lịch sự");
    expect(related).toContain("[Workspace] Chính sách đổi trả sản phẩm");

    const toolResult = await enabledDeps.memory!.search("chính sách đổi trả", 5);
    expect(toolResult).toContain("[Workspace] Chính sách đổi trả sản phẩm");

    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Thông tin trùng phải ưu tiên phạm vi agent",
      importance: 0.8,
    });
    await addWorkspaceSemanticMemory(dbh.db, ctxA(), {
      content: "Thông tin trùng phải ưu tiên phạm vi agent",
      importance: 0.8,
    });
    const deduped = await enabledDeps.memory!.search("thông tin trùng ưu tiên phạm vi", 5);
    expect(deduped.match(/Thông tin trùng phải ưu tiên phạm vi agent/g)).toHaveLength(1);
    expect(deduped).not.toContain("[Workspace] Thông tin trùng");
  });

  it("tắt trên agent loại Workspace Semantic khỏi auto-context và memory_search", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: auth(fx.keys.aAdmin),
      payload: { workspaceMemoryEnabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { agent: { workspaceMemoryEnabled: boolean } }).agent.workspaceMemoryEnabled).toBe(false);

    const agent = await getAgentById(dbh.db, ctxA(), fx.agentA);
    const disabledDeps = await buildLoopDeps(
      { db: dbh, providers, tools, config },
      ctxA(),
      agent!.provider,
      agentOpts(agent!),
    );
    const prefix = await disabledDeps.buildContextPrefix!("chính sách đổi trả");
    expect(prefix).not.toContain("Quy tắc workspace luôn xưng hô lịch sự");
    expect(prefix).not.toContain("Chính sách đổi trả sản phẩm");
    expect(await disabledDeps.memory!.search("chính sách đổi trả", 5)).toBe(
      "(không tìm thấy trong bộ nhớ)",
    );
  });
});
