import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  addMemory,
  searchMemories,
  getL0Memories,
  listMemories,
  deleteMemory,
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

describe("memory (tsvector search + L0 + RLS)", () => {
  it("thêm + tìm theo full-text", async () => {
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Khách hàng thích màu xanh và giao hàng buổi sáng",
      importance: 0.8,
    });
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Ngân sách quảng cáo tháng này là 50 triệu",
      importance: 0.9,
    });
    const hits = await searchMemories(dbh.db, ctxA(), fx.agentA, "ngân sách quảng cáo", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("Ngân sách");
  });

  it("L0 = semantic importance cao", async () => {
    const l0 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 10, 0.7);
    expect(l0.length).toBe(2);
    // sắp theo importance giảm dần
    expect(l0[0]!.importance).toBeGreaterThanOrEqual(l0[1]!.importance);
  });

  it("cách ly workspace", async () => {
    const inB = await listMemories(dbh.db, ctxB(), fx.agentB);
    expect(inB.length).toBe(0);
    const hitsB = await searchMemories(dbh.db, ctxB(), fx.agentB, "ngân sách", 5);
    expect(hitsB.length).toBe(0);
  });

  it("xóa memory", async () => {
    const list = await listMemories(dbh.db, ctxA(), fx.agentA);
    const ok = await deleteMemory(dbh.db, ctxA(), list[0]!.id);
    expect(ok).toBe(true);
    const after = await listMemories(dbh.db, ctxA(), fx.agentA);
    expect(after.length).toBe(list.length - 1);
  });
});
