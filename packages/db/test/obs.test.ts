import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  recordTrace,
  listTraces,
  setUsageCap,
  monthTokens,
  isOverCap,
  createHook,
  getHooksForEvent,
  createAgentWebhook,
  lookupAgentWebhook,
  consumeNonce,
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

describe("tracing + usage cap", () => {
  it("ghi trace + tổng token tháng", async () => {
    await recordTrace(dbh.db, ctxA(), {
      agentId: fx.agentA,
      inputTokens: 100,
      outputTokens: 50,
      iterations: 2,
      durationMs: 1234,
    });
    expect((await listTraces(dbh.db, ctxA())).length).toBe(1);
    expect(await monthTokens(dbh.db, fx.wsA)).toBe(150);
  });

  it("cap: dưới hạn mức → không vượt; hạ hạn mức → vượt", async () => {
    await setUsageCap(dbh.db, ctxA(), 1000);
    expect(await isOverCap(dbh.db, fx.wsA)).toBe(false);
    await setUsageCap(dbh.db, ctxA(), 100); // đã dùng 150 > 100
    expect(await isOverCap(dbh.db, fx.wsA)).toBe(true);
  });

  it("không có cap → không vượt", async () => {
    expect(await isOverCap(dbh.db, fx.wsB)).toBe(false);
  });
});

describe("hooks + webhook nonce", () => {
  it("hook khớp event", async () => {
    await createHook(dbh.db, ctxA(), {
      event: "post_tool_use",
      matcher: "exec",
      url: "https://example.com/hook",
    });
    const rows = await getHooksForEvent(dbh.db, ctxA(), "post_tool_use");
    expect(rows.length).toBe(1);
    expect(new RegExp(rows[0]!.matcher).test("exec")).toBe(true);
  });

  it("webhook lookup + nonce chống replay", async () => {
    const wh = await createAgentWebhook(dbh.db, ctxA(), fx.agentA, "v1.secret");
    const found = await lookupAgentWebhook(dbh.db, wh.id);
    expect(found!.agentId).toBe(fx.agentA);

    expect(await consumeNonce(dbh.db, ctxA(), wh.id, "nonce-1")).toBe(true);
    expect(await consumeNonce(dbh.db, ctxA(), wh.id, "nonce-1")).toBe(false); // replay
    expect(await consumeNonce(dbh.db, ctxA(), wh.id, "nonce-2")).toBe(true);
  });
});
