import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  addWorkspaceSemanticMemory,
  createDb,
  deleteWorkspaceSemanticMemory,
  getAgentById,
  getPinnedWorkspaceSemanticMemories,
  listWorkspaceSemanticMemories,
  searchWorkspaceSemanticMemories,
  touchWorkspaceSemanticMemories,
  updateAgent,
  updateWorkspaceSemanticMemory,
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

describe("Workspace Semantic", () => {
  it("agent mặc định bật và có thể tắt riêng", async () => {
    expect((await getAgentById(dbh.db, ctxA(), fx.agentA))!.workspaceMemoryEnabled).toBe(true);
    await updateAgent(dbh.db, ctxA(), fx.agentA, { workspaceMemoryEnabled: false });
    expect((await getAgentById(dbh.db, ctxA(), fx.agentA))!.workspaceMemoryEnabled).toBe(false);
    await updateAgent(dbh.db, ctxA(), fx.agentA, { workspaceMemoryEnabled: true });
  });

  it("RLS giữ memory trong đúng workspace", async () => {
    await addWorkspaceSemanticMemory(dbh.db, ctxA(), {
      content: "Quy định bảo hành workspace A là mười hai tháng",
      importance: 0.9,
    });
    expect((await listWorkspaceSemanticMemories(dbh.db, ctxA())).length).toBe(1);
    expect((await listWorkspaceSemanticMemories(dbh.db, ctxB())).length).toBe(0);
    expect((await searchWorkspaceSemanticMemories(dbh.db, ctxB(), "bảo hành")).length).toBe(0);
  });

  it("chỉ mục ghim được lấy cho context thường trực", async () => {
    const unpinned = await addWorkspaceSemanticMemory(dbh.db, ctxA(), {
      content: "Kho hàng làm việc từ tám giờ sáng",
      importance: 1,
      pinned: false,
    });
    const pinned = await addWorkspaceSemanticMemory(dbh.db, ctxA(), {
      content: "Không được tiết lộ thông tin nội bộ",
      importance: 0.2,
      pinned: true,
    });
    const rows = await getPinnedWorkspaceSemanticMemories(dbh.db, ctxA(), 10);
    expect(rows.map((r) => r.id)).toContain(pinned!.id);
    expect(rows.map((r) => r.id)).not.toContain(unpinned!.id);
  });

  it("tìm kiếm, touch, sửa và chống trùng", async () => {
    const found = await searchWorkspaceSemanticMemories(dbh.db, ctxA(), "bảo hành", 5);
    expect(found[0]!.content).toContain("bảo hành");
    await touchWorkspaceSemanticMemories(dbh.db, ctxA(), [found[0]!.id]);
    const touched = (await listWorkspaceSemanticMemories(dbh.db, ctxA())).find(
      (r) => r.id === found[0]!.id,
    );
    expect(touched!.accessCount).toBe(1);
    expect(touched!.lastAccessed).not.toBeNull();

    const updated = await updateWorkspaceSemanticMemory(dbh.db, ctxA(), found[0]!.id, {
      content: "Quy định bảo hành workspace A là hai mươi bốn tháng",
      importance: 0.95,
      pinned: true,
    });
    expect(updated).toMatchObject({ importance: 0.95, pinned: true });
    expect(updated!.content).toContain("hai mươi bốn");

    const duplicate = await addWorkspaceSemanticMemory(dbh.db, ctxA(), {
      content: "  quy định bảo hành workspace a là hai mươi bốn tháng  ",
    });
    expect(duplicate).toBeNull();
  });

  it("xóa đúng bản ghi trong workspace", async () => {
    const row = await addWorkspaceSemanticMemory(dbh.db, ctxB(), {
      content: "Kiến thức tạm để kiểm tra xóa",
    });
    expect(await deleteWorkspaceSemanticMemory(dbh.db, ctxA(), row!.id)).toBe(false);
    expect(await deleteWorkspaceSemanticMemory(dbh.db, ctxB(), row!.id)).toBe(true);
  });
});
