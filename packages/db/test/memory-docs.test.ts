import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  upsertMemoryDoc,
  getMemoryDoc,
  deleteMemoryDocByPath,
  deleteMemoryDocById,
  listMemoryDocs,
  getMemoryDocById,
  searchMemoryDocs,
  listSessionsNeedingConsolidation,
  getSessionChannelUserKey,
  createSession,
  appendMessage,
  addMemory,
  createChannel,
  mapChannelSession,
  withWorkspace,
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

const U1 = "telegram-111";

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("memory documents (file ghi nhớ)", () => {
  it("upsert + get: bản riêng người dùng thắng bản chung, không có bản riêng thì rơi về chung", async () => {
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "MEMORY.md",
      content: "ghi nho chung cua agent",
    });
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "MEMORY.md",
      content: "ghi nho rieng cua user 1",
      userKey: U1,
    });

    const user = await getMemoryDoc(dbh.db, ctxA(), fx.agentA, "MEMORY.md", U1);
    expect(user?.content).toBe("ghi nho rieng cua user 1");

    const global = await getMemoryDoc(dbh.db, ctxA(), fx.agentA, "MEMORY.md");
    expect(global?.content).toBe("ghi nho chung cua agent");

    // user khác chưa có bản riêng → thấy bản chung
    const fallback = await getMemoryDoc(dbh.db, ctxA(), fx.agentA, "MEMORY.md", "telegram-999");
    expect(fallback?.content).toBe("ghi nho chung cua agent");
  });

  it("upsert lần 2 cùng path ghi đè nội dung (không nhân bản)", async () => {
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "memory/2026-08-05.md",
      content: "ban dau",
      userKey: U1,
    });
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "memory/2026-08-05.md",
      content: "da cap nhat noi dung moi",
      userKey: U1,
    });
    const doc = await getMemoryDoc(dbh.db, ctxA(), fx.agentA, "memory/2026-08-05.md", U1);
    expect(doc?.content).toBe("da cap nhat noi dung moi");
    const docs = await listMemoryDocs(dbh.db, ctxA(), fx.agentA, U1);
    expect(docs.filter((d) => d.path === "memory/2026-08-05.md")).toHaveLength(1);
  });

  it("search: tìm full-text đúng phạm vi người dùng, có snippet + path", async () => {
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "memory/du-an.md",
      content: "Khach hang Hoa Sen muon lam website ban hang, deadline thang 9",
      userKey: U1,
    });
    const hits = await searchMemoryDocs(dbh.db, ctxA(), fx.agentA, "deadline Hoa Sen", 5, U1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe("memory/du-an.md");
    // ts_headline đánh dấu từng từ khớp bằng »«
    expect(hits[0]!.snippet).toContain("»Hoa«");
    expect(hits[0]!.snippet).toContain("»deadline«");

    // người dùng khác không thấy file riêng của U1
    const other = await searchMemoryDocs(dbh.db, ctxA(), fx.agentA, "deadline Hoa Sen", 5, "telegram-999");
    expect(other.find((h) => h.path === "memory/du-an.md")).toBeUndefined();
  });

  it("RLS: workspace khác không đọc được file ghi nhớ", async () => {
    const doc = await getMemoryDoc(dbh.db, ctxB(), fx.agentA, "MEMORY.md").catch(() => null);
    expect(doc).toBeNull();
    const docs = await listMemoryDocs(dbh.db, ctxB(), fx.agentA);
    expect(docs).toHaveLength(0);
  });

  it("delete theo path đúng scope + delete theo id", async () => {
    await upsertMemoryDoc(dbh.db, ctxA(), {
      agentId: fx.agentA,
      path: "memory/xoa-toi.md",
      content: "se bi xoa",
      userKey: U1,
    });
    expect(await deleteMemoryDocByPath(dbh.db, ctxA(), fx.agentA, "memory/xoa-toi.md", U1)).toBe(true);
    expect(await getMemoryDoc(dbh.db, ctxA(), fx.agentA, "memory/xoa-toi.md", U1)).toBeNull();

    const all = await listMemoryDocs(dbh.db, ctxA(), fx.agentA);
    const target = all.find((d) => d.path === "MEMORY.md" && d.userKey === null);
    expect(target).toBeDefined();
    const full = await getMemoryDocById(dbh.db, ctxA(), target!.id);
    expect(full?.content).toBe("ghi nho chung cua agent");
    expect(await deleteMemoryDocById(dbh.db, ctxA(), target!.id)).toBe(true);
  });
});

describe("consolidation worker queries", () => {
  async function backdateSession(sessionId: string, minutesAgo: number): Promise<void> {
    await withWorkspace(dbh.db, ctxA(), (tx) =>
      tx.execute(sql`
        UPDATE messages SET created_at = now() - make_interval(mins => ${minutesAgo})
        WHERE session_id = ${sessionId}
      `),
    );
  }

  it("session nguội + đủ tin nhắn được liệt kê; sau khi có memory thì thôi", async () => {
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA, title: "test-consolidate" });
    for (let i = 0; i < 3; i++) {
      await appendMessage(dbh.db, ctxA(), s.id, { role: "user", content: { kind: "text", text: `cau hoi ${i}` } });
      await appendMessage(dbh.db, ctxA(), s.id, { role: "assistant", content: { kind: "assistant", text: `tra loi ${i}`, toolCalls: [] } });
    }
    // chưa nguội → không được liệt kê
    let due = await listSessionsNeedingConsolidation(dbh.db, {
      idleMinutes: 30, minMessages: 4, maxAgeDays: 7, limit: 50,
    });
    expect(due.find((d) => d.sessionId === s.id)).toBeUndefined();

    await backdateSession(s.id, 60);
    due = await listSessionsNeedingConsolidation(dbh.db, {
      idleMinutes: 30, minMessages: 4, maxAgeDays: 7, limit: 50,
    });
    const found = due.find((d) => d.sessionId === s.id);
    expect(found).toBeDefined();
    expect(found!.workspaceId).toBe(fx.wsA);
    expect(found!.msgCount).toBe(6);

    // có memory episodic mới hơn tin nhắn cuối → không liệt kê nữa
    await addMemory(dbh.db, ctxA(), {
      agentId: fx.agentA,
      tier: "episodic",
      content: "tom tat phien test",
      sourceSessionId: s.id,
    });
    due = await listSessionsNeedingConsolidation(dbh.db, {
      idleMinutes: 30, minMessages: 4, maxAgeDays: 7, limit: 50,
    });
    expect(due.find((d) => d.sessionId === s.id)).toBeUndefined();
  });

  it("session quá ít tin nhắn không được liệt kê", async () => {
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA, title: "test-short" });
    await appendMessage(dbh.db, ctxA(), s.id, { role: "user", content: { kind: "text", text: "hi" } });
    await backdateSession(s.id, 60);
    const due = await listSessionsNeedingConsolidation(dbh.db, {
      idleMinutes: 30, minMessages: 4, maxAgeDays: 7, limit: 50,
    });
    expect(due.find((d) => d.sessionId === s.id)).toBeUndefined();
  });

  it("getSessionChannelUserKey: session kênh trả kind-chatKey, session thường trả null", async () => {
    const ch = await createChannel(dbh.db, ctxA(), {
      kind: "telegram",
      name: "bot-test",
      agentId: fx.agentA,
    });
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA, title: "tg" });
    await mapChannelSession(dbh.db, ctxA(), ch.id, "12345", s.id);
    expect(await getSessionChannelUserKey(dbh.db, ctxA(), s.id)).toBe("telegram-12345");

    const plain = await createSession(dbh.db, ctxA(), { agentId: fx.agentA, title: "plain" });
    expect(await getSessionChannelUserKey(dbh.db, ctxA(), plain.id)).toBeNull();
  });
});
