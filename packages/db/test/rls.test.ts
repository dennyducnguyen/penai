import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  authenticateApiKey,
  createDb,
  createSession,
  listSessions,
  sessions,
  withWorkspace,
  type DbHandle,
} from "../src/index.js";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;

const ctx = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  userId: fx.userId,
  role: "operator",
});

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});

afterAll(async () => {
  await dbh.close();
});

describe("RLS cách ly workspace (spec-workspace-rbac)", () => {
  it("AC-1: mỗi workspace chỉ thấy session của mình", async () => {
    const sA = await createSession(dbh.db, ctx(fx.wsA), { agentId: fx.agentA });
    const sB = await createSession(dbh.db, ctx(fx.wsB), { agentId: fx.agentB });

    const seenFromA = await listSessions(dbh.db, ctx(fx.wsA));
    expect(seenFromA.map((s) => s.id)).toContain(sA.id);
    expect(seenFromA.map((s) => s.id)).not.toContain(sB.id);

    const seenFromB = await listSessions(dbh.db, ctx(fx.wsB));
    expect(seenFromB.map((s) => s.id)).toContain(sB.id);
    expect(seenFromB.map((s) => s.id)).not.toContain(sA.id);
  });

  it("AC-2: fail-closed — không SET workspace context thì 0 dòng", async () => {
    // Xác nhận dữ liệu tồn tại thật (nhìn bằng quyền admin)
    const total = await adminQuery<{ n: string }>(
      "SELECT count(*) AS n FROM sessions",
    );
    expect(Number(total[0]!.n)).toBeGreaterThan(0);

    // Query qua role penai_app KHÔNG có app.workspace_id → RLS trả 0 dòng
    const rows = await dbh.pool.query("SELECT * FROM sessions");
    expect(rows.rows).toHaveLength(0);
  });

  it("AC-3: không ghi chéo workspace (WITH CHECK)", async () => {
    let err: unknown;
    try {
      await withWorkspace(dbh.db, ctx(fx.wsA), (tx) =>
        tx.insert(sessions).values({
          workspaceId: fx.wsB, // cố tình ghi sang workspace khác
          agentId: fx.agentB,
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // drizzle bọc lỗi pg trong .cause
    const cause = (err as Error & { cause?: Error }).cause;
    expect(String(cause?.message ?? (err as Error).message)).toMatch(
      /row-level security/i,
    );

    // Xác minh không có dòng nào lọt sang workspace B
    const leaked = await adminQuery<{ n: string }>(
      "SELECT count(*) AS n FROM sessions WHERE workspace_id = $1 AND agent_id = $2",
      [fx.wsB, fx.agentB],
    );
    // chỉ có đúng 1 session hợp lệ của B tạo ở AC-1
    expect(Number(leaked[0]!.n)).toBe(1);
  });
});

describe("Xác thực API key (auth_lookup_api_key)", () => {
  it("key hợp lệ → đúng workspace + role", async () => {
    const auth = await authenticateApiKey(dbh.db, fx.keys.aOperator);
    expect(auth).not.toBeNull();
    expect(auth!.workspaceId).toBe(fx.wsA);
    expect(auth!.role).toBe("operator");
  });

  it("key sai định dạng / không tồn tại → null", async () => {
    expect(await authenticateApiKey(dbh.db, "sai-dinh-dang")).toBeNull();
    expect(await authenticateApiKey(dbh.db, "psk_khongtontai123")).toBeNull();
  });

  it("AC-5: key bị revoke → null", async () => {
    const auth1 = await authenticateApiKey(dbh.db, fx.keys.aViewer);
    expect(auth1).not.toBeNull();
    await adminQuery(
      "UPDATE api_keys SET revoked_at = now() WHERE role = 'viewer' AND workspace_id = $1",
      [fx.wsA],
    );
    const auth2 = await authenticateApiKey(dbh.db, fx.keys.aViewer);
    expect(auth2).toBeNull();
    // khôi phục cho test khác dùng
    await adminQuery(
      "UPDATE api_keys SET revoked_at = NULL WHERE role = 'viewer' AND workspace_id = $1",
      [fx.wsA],
    );
  });
});
