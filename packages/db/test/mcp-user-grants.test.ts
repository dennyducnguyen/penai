import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createMcpServer,
  setMcpUserPolicy,
  upsertMcpUserGrant,
  revokeMcpUserGrant,
  listMcpUserGrants,
  listMcpUserAccess,
  upsertContact,
  createPublishedFile,
  getPublishedFileByHash,
  listPublishedFiles,
  revokePublishedFile,
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

describe("MCP phân quyền theo người dùng cuối (0021)", () => {
  let serverId = "";
  const userKey = "telegram-111222";

  it("mặc định user_policy=all; đổi được sang granted", async () => {
    const s = await createMcpServer(dbh.db, ctxA(), {
      name: "canva",
      transport: "http",
      url: "https://mcp.canva.com/mcp",
    });
    serverId = s.id;
    let rows = await listMcpUserAccess(dbh.db, ctxA(), userKey);
    expect(rows.find((r) => r.serverId === serverId)?.userPolicy).toBe("all");

    await setMcpUserPolicy(dbh.db, ctxA(), serverId, "granted");
    rows = await listMcpUserAccess(dbh.db, ctxA(), userKey);
    const r = rows.find((x) => x.serverId === serverId)!;
    expect(r.userPolicy).toBe("granted");
    expect(r.hasGrant).toBe(false);
  });

  it("upsert grant kèm tool_allow/tool_deny; upsert lại thì cập nhật", async () => {
    await upsertMcpUserGrant(dbh.db, ctxA(), serverId, userKey, {
      toolAllow: ["generate-design"],
      toolDeny: ["delete-design"],
    });
    let rows = await listMcpUserAccess(dbh.db, ctxA(), userKey);
    let r = rows.find((x) => x.serverId === serverId)!;
    expect(r.hasGrant).toBe(true);
    expect(r.grantEnabled).toBe(true);
    expect(r.toolAllow).toEqual(["generate-design"]);
    expect(r.toolDeny).toEqual(["delete-design"]);

    // upsert lại: đổi enabled=false (veto) + allow rỗng
    await upsertMcpUserGrant(dbh.db, ctxA(), serverId, userKey, { enabled: false });
    rows = await listMcpUserAccess(dbh.db, ctxA(), userKey);
    r = rows.find((x) => x.serverId === serverId)!;
    expect(r.grantEnabled).toBe(false);
    expect(r.toolAllow).toEqual([]);
  });

  it("listMcpUserGrants join tên hiển thị từ contacts", async () => {
    await upsertContact(dbh.db, ctxA(), {
      channelKind: "telegram",
      externalId: "111222",
      displayName: "Anh Bảy",
    });
    const grants = await listMcpUserGrants(dbh.db, ctxA(), serverId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.userKey).toBe(userKey);
    expect(grants[0]!.displayName).toBe("Anh Bảy");
  });

  it("revoke xóa grant; workspace khác không thấy gì", async () => {
    expect(await revokeMcpUserGrant(dbh.db, ctxA(), serverId, userKey)).toBe(true);
    expect(await listMcpUserGrants(dbh.db, ctxA(), serverId)).toHaveLength(0);
    expect(await listMcpUserAccess(dbh.db, ctxB(), userKey)).toHaveLength(0);
  });
});

describe("Published files (0020 — link công khai cho file)", () => {
  const token = "token-test-abcdefghijklmnop";
  const hash = createHash("sha256").update(token).digest("hex");

  it("tạo + tra theo hash (SECURITY DEFINER, không cần ws context)", async () => {
    await createPublishedFile(dbh.db, ctxA(), {
      tokenHash: hash,
      absPath: "/data/ws-a/users/telegram-1/banner.png",
      fileName: "banner.png",
      contentType: "image/png",
      createdBy: "telegram-1",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const row = await getPublishedFileByHash(dbh.db, hash);
    expect(row).not.toBeNull();
    expect(row!.fileName).toBe("banner.png");
    expect(row!.revoked).toBe(false);
    expect(row!.workspaceId).toBe(fx.wsA);
  });

  it("hash sai → null", async () => {
    expect(await getPublishedFileByHash(dbh.db, "khong-ton-tai")).toBeNull();
  });

  it("thu hồi → revoked=true (route sẽ trả 404)", async () => {
    const rows = await listPublishedFiles(dbh.db, ctxA());
    expect(rows).toHaveLength(1);
    expect(await revokePublishedFile(dbh.db, ctxA(), rows[0]!.id)).toBe(true);
    const row = await getPublishedFileByHash(dbh.db, hash);
    expect(row!.revoked).toBe(true);
  });

  it("cách ly workspace: B không thấy link của A", async () => {
    expect(await listPublishedFiles(dbh.db, ctxB())).toHaveLength(0);
  });
});
