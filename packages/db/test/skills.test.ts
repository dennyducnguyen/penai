import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createSkill,
  listSkills,
  getSkillBySlug,
  searchSkills,
  createCustomTool,
  listEnabledCustomToolsByWorkspace,
  createMcpServer,
  listMcpServers,
  type DbHandle,
} from "../src/index.js";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("skills (tsvector search + RLS)", () => {
  it("tạo + tìm theo full-text", async () => {
    await createSkill(dbh.db, ctxA(), {
      slug: "viet-email",
      name: "Viết email chuyên nghiệp",
      description: "Hướng dẫn soạn email bán hàng lịch sự",
      content: "Bước 1: chào hỏi. Bước 2: nêu giá trị. Bước 3: kêu gọi hành động.",
    });
    const found = await searchSkills(dbh.db, ctxA(), "email bán hàng", 5);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.slug).toBe("viet-email");

    const s = await getSkillBySlug(dbh.db, ctxA(), "viet-email");
    expect(s!.content).toContain("kêu gọi hành động");
  });

  it("cách ly workspace", async () => {
    expect((await listSkills(dbh.db, ctxB())).length).toBe(0);
    expect((await searchSkills(dbh.db, ctxB(), "email", 5)).length).toBe(0);
  });
});

describe("custom tools + mcp servers (RLS + boot list)", () => {
  it("tạo custom tool + list enabled theo workspace", async () => {
    await createCustomTool(dbh.db, ctxA(), {
      name: "ping_api",
      description: "gọi API nội bộ",
      commandTemplate: "curl -s {{url}}",
      paramsSchema: { type: "object", properties: { url: { type: "string" } } },
    });
    const list = await listEnabledCustomToolsByWorkspace(dbh.db, fx.wsA);
    expect(list.map((t) => t.name)).toContain("ping_api");
    const listB = await listEnabledCustomToolsByWorkspace(dbh.db, fx.wsB);
    expect(listB.length).toBe(0);
  });

  it("tạo mcp server + list", async () => {
    await createMcpServer(dbh.db, ctxA(), {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    const servers = await listMcpServers(dbh.db, ctxA());
    expect(servers.map((s) => s.name)).toContain("fs");
  });
});
