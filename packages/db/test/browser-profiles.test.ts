import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createBrowserProfile,
  createDb,
  deleteBrowserProfile,
  getAgentById,
  getBrowserProfile,
  listBrowserProfiles,
  setBrowserProfileCookies,
  updateAgent,
  updateBrowserProfile,
  type DbHandle,
} from "../src/index.js";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

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

describe("hồ sơ trình duyệt (0033)", () => {
  it("tạo/sửa/đọc — workspace khác không thấy (RLS), trùng tên bị chặn", async () => {
    const p = await createBrowserProfile(dbh.db, ctxA(), { name: "Shopee shop A", description: "test" });
    expect(p).toMatchObject({ locale: "vi-VN", timezone: "Asia/Ho_Chi_Minh", autoSave: true, cookieCount: 0 });
    expect((await listBrowserProfiles(dbh.db, ctxA())).map((x) => x.id)).toContain(p.id);
    expect((await listBrowserProfiles(dbh.db, ctxB())).map((x) => x.id)).not.toContain(p.id);
    expect(await getBrowserProfile(dbh.db, ctxB(), p.id)).toBeNull();
    await expect(createBrowserProfile(dbh.db, ctxA(), { name: "Shopee shop A" })).rejects.toThrow();
    const u = await updateBrowserProfile(dbh.db, ctxA(), p.id, { autoSave: false, userAgent: "UA test" });
    expect(u).toMatchObject({ autoSave: false, userAgent: "UA test" });
    expect(await updateBrowserProfile(dbh.db, ctxB(), p.id, { name: "chiếm" })).toBeNull();
  });

  it("cookie: quản trị viên sửa đổi phiên bản hồ sơ; tự lưu sau phiên thì không", async () => {
    const p = await createBrowserProfile(dbh.db, ctxA(), { name: "Hồ sơ cookie" });
    const a1 = await setBrowserProfileCookies(dbh.db, ctxA(), p.id, { cookiesEncrypted: "enc-1", cookieCount: 3, source: "admin" });
    expect(a1!.cookieCount).toBe(3);
    expect(a1!.updatedAt.getTime()).toBeGreaterThanOrEqual(p.updatedAt.getTime());
    await new Promise((r) => setTimeout(r, 15));
    const s1 = await setBrowserProfileCookies(dbh.db, ctxA(), p.id, { cookiesEncrypted: "enc-2", cookieCount: 4, source: "session" });
    expect(s1!.cookiesEncrypted).toBe("enc-2");
    expect(s1!.updatedAt.getTime()).toBe(a1!.updatedAt.getTime());
    expect(s1!.cookiesUpdatedAt!.getTime()).toBeGreaterThan(a1!.cookiesUpdatedAt!.getTime());
    const cleared = await setBrowserProfileCookies(dbh.db, ctxA(), p.id, { cookiesEncrypted: null, cookieCount: 0, source: "admin" });
    expect(cleared!.cookiesEncrypted).toBeNull();
  });

  it("gán cho agent; xóa hồ sơ thì agent về trình duyệt trống", async () => {
    const p = await createBrowserProfile(dbh.db, ctxA(), { name: "Gán agent" });
    const agent = await updateAgent(dbh.db, ctxA(), fx.agentA, { browserProfileId: p.id });
    expect(agent!.browserProfileId).toBe(p.id);
    expect(await deleteBrowserProfile(dbh.db, ctxB(), p.id)).toBe(false);
    expect(await deleteBrowserProfile(dbh.db, ctxA(), p.id)).toBe(true);
    expect((await getAgentById(dbh.db, ctxA(), fx.agentA))!.browserProfileId).toBeNull();
  });
});
