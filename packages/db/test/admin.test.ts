import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import { authenticateApiKey } from "../src/auth.js";
import {
  createDb,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  recordAudit,
  listAudit,
  createSession,
  deleteSession,
  appendMessage,
  loadMessages,
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

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("API keys management", () => {
  it("tạo key → xác thực được; thu hồi → 401", async () => {
    const { id, apiKey } = await createApiKey(dbh.db, ctxA(), { name: "test", role: "operator" });
    const auth = await authenticateApiKey(dbh.db, apiKey);
    expect(auth).not.toBeNull();
    expect(auth!.role).toBe("operator");

    const keys = await listApiKeys(dbh.db, ctxA());
    expect(keys.find((k) => k.id === id)).toBeTruthy();

    await revokeApiKey(dbh.db, ctxA(), id);
    expect(await authenticateApiKey(dbh.db, apiKey)).toBeNull();
  });
});

describe("audit log", () => {
  it("ghi + đọc", async () => {
    await recordAudit(dbh.db, ctxA(), "agent.create", { key: "x" });
    const entries = await listAudit(dbh.db, ctxA());
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.action).toBe("agent.create");
  });
});

describe("session delete (cascade messages)", () => {
  it("xóa session + messages", async () => {
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA });
    await appendMessage(dbh.db, ctxA(), s.id, { role: "user", content: { kind: "text", text: "hi" } });
    expect((await loadMessages(dbh.db, ctxA(), s.id)).length).toBe(1);
    const ok = await deleteSession(dbh.db, ctxA(), s.id);
    expect(ok).toBe(true);
    expect((await loadMessages(dbh.db, ctxA(), s.id)).length).toBe(0);
  });
});
