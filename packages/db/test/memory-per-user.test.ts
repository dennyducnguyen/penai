import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  addMemory,
  getL0Memories,
  searchMemories,
  listMemories,
  listMemoryUserKeys,
  updateMemory,
  touchMemories,
  pruneMemories,
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

const U1 = "telegram-111";
const U2 = "telegram-222";

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("memory theo từng người dùng", () => {
  it("người dùng không thấy ghi nhớ của người khác, nhưng thấy ghi nhớ chung", async () => {
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Nguoi dung 1 ten la An, thich ca phe",
      importance: 0.9,
      userKey: U1,
    });
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Nguoi dung 2 ten la Binh, thich tra sua",
      importance: 0.9,
      userKey: U2,
    });
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Cong ty lam viec tu 8h den 17h",
      importance: 0.9, // ghi nhớ CHUNG (không có userKey)
    });

    const l0u1 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 10, 0.7, U1);
    const texts1 = l0u1.map((m) => m.content);
    expect(texts1.some((t) => t.includes("An"))).toBe(true);
    expect(texts1.some((t) => t.includes("Binh"))).toBe(false); // KHÔNG thấy người kia
    expect(texts1.some((t) => t.includes("Cong ty"))).toBe(true); // thấy ghi nhớ chung

    const l0u2 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 10, 0.7, U2);
    expect(l0u2.map((m) => m.content).some((t) => t.includes("An"))).toBe(false);

    // tìm kiếm cũng bị giới hạn phạm vi
    const found = await searchMemories(dbh.db, ctxA(), fx.agentA, "ten la", 10, U1);
    expect(found.some((m) => m.content.includes("Binh"))).toBe(false);
  });

  it("không truyền userKey (chat dashboard/cron) chỉ thấy ghi nhớ chung", async () => {
    const l0 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 10, 0.7);
    const texts = l0.map((m) => m.content);
    expect(texts.some((t) => t.includes("Cong ty"))).toBe(true);
    expect(texts.some((t) => t.includes("An"))).toBe(false);
  });

  it("chống trùng: ghi nhớ y hệt không bị nhân bản", async () => {
    const first = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Ghi nho lap lai nhieu lan",
      userKey: U1,
    });
    const second = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "  ghi nho lap lai nhieu lan  ", // khác hoa/thường + khoảng trắng
      userKey: U1,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // bị chặn bởi dedup
    // nhưng người dùng KHÁC vẫn ghi được nội dung đó cho riêng mình
    const other = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Ghi nho lap lai nhieu lan",
      userKey: U2,
    });
    expect(other).not.toBeNull();
  });

  it("ghim luôn được nạp dù importance thấp", async () => {
    const m = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "semantic",
      content: "Ghi nho quan trong nhung diem thap",
      importance: 0.1,
      userKey: U1,
    });
    let l0 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 20, 0.7, U1);
    expect(l0.some((x) => x.id === m!.id)).toBe(false);
    await updateMemory(dbh.db, ctxA(), m!.id, { pinned: true });
    l0 = await getL0Memories(dbh.db, ctxA(), fx.agentA, 20, 0.7, U1);
    expect(l0.some((x) => x.id === m!.id)).toBe(true);
  });

  it("liệt kê danh sách người dùng có ghi nhớ riêng", async () => {
    const keys = await listMemoryUserKeys(dbh.db, ctxA(), fx.agentA);
    expect(keys).toContain(U1);
    expect(keys).toContain(U2);
  });

  it("lọc danh sách theo 1 người dùng", async () => {
    const rows = await listMemories(dbh.db, ctxA(), fx.agentA, 100, U1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userKey === U1)).toBe(true);
  });

  it("touch tăng số lần dùng", async () => {
    const rows = await listMemories(dbh.db, ctxA(), fx.agentA, 1, U1);
    const id = rows[0]!.id;
    await touchMemories(dbh.db, ctxA(), [id]);
    const after = (await listMemories(dbh.db, ctxA(), fx.agentA, 100, U1)).find((r) => r.id === id);
    expect(after!.accessCount).toBe(1);
    expect(after!.lastAccessed).not.toBeNull();
  });

  it("prune xóa episodic ít quan trọng, giữ ghi nhớ đã ghim", async () => {
    const old = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "episodic",
      content: "ghi nho episodic rat cu",
      importance: 0.3,
    });
    const pinned = await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "episodic",
      content: "episodic cu nhung da ghim",
      importance: 0.3,
    });
    await updateMemory(dbh.db, ctxA(), pinned!.id, { pinned: true });
    // olderThanDays = 0 → mọi bản ghi tạo trước thời điểm chạy đều đủ điều kiện
    const removed = await pruneMemories(dbh.db, ctxA(), {
      agentId: fx.agentA,
      olderThanDays: 0,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    const rest = await listMemories(dbh.db, ctxA(), fx.agentA, 200);
    expect(rest.some((r) => r.id === pinned!.id)).toBe(true); // ghim → giữ lại
    expect(rest.some((r) => r.id === old!.id)).toBe(false);
    // semantic quan trọng không bị đụng tới
    expect(rest.some((r) => r.content.includes("Cong ty"))).toBe(true);
  });
});
