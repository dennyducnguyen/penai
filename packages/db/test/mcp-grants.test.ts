import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createMcpServer,
  setMcpVisibility,
  grantMcpToAgent,
  revokeMcpFromAgent,
  listMcpWithGrantStatus,
  listMcpAccessForAgent,
  listEnabledMcpServers,
  saveMcpOauth,
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

describe("MCP phân quyền theo agent (visibility + grants + tool_allow)", () => {
  let wsServerId = "";
  let grantedServerId = "";

  it("visibility=workspace (mặc định): mọi agent có full quyền", async () => {
    const s = await createMcpServer(dbh.db, ctxA(), {
      name: "fs-chung",
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-fs"],
    });
    wsServerId = s.id;
    const access = await listMcpAccessForAgent(dbh.db, ctxA(), fx.agentA);
    expect(access.has(s.id)).toBe(true);
    expect(access.get(s.id)).toBeNull(); // null = mọi tool
  });

  it("visibility=granted: cần grant; tool_allow lọc từng tool", async () => {
    const s = await createMcpServer(dbh.db, ctxA(), {
      name: "kho-rieng",
      transport: "http",
      url: "https://example.com/mcp",
    });
    grantedServerId = s.id;
    await setMcpVisibility(dbh.db, ctxA(), s.id, "granted");

    // chưa grant → không có quyền
    let access = await listMcpAccessForAgent(dbh.db, ctxA(), fx.agentA);
    expect(access.has(s.id)).toBe(false);

    // grant full → null (mọi tool)
    await grantMcpToAgent(dbh.db, ctxA(), s.id, fx.agentA);
    access = await listMcpAccessForAgent(dbh.db, ctxA(), fx.agentA);
    expect(access.get(s.id)).toBeNull();

    // grant lại kèm tool_allow → set tool
    await grantMcpToAgent(dbh.db, ctxA(), s.id, fx.agentA, { toolAllow: ["read_file"] });
    access = await listMcpAccessForAgent(dbh.db, ctxA(), fx.agentA);
    const allow = access.get(s.id);
    expect(allow).toBeInstanceOf(Set);
    expect(allow!.has("read_file")).toBe(true);
    expect(allow!.has("write_file")).toBe(false);

    // revoke → mất quyền
    await revokeMcpFromAgent(dbh.db, ctxA(), s.id, fx.agentA);
    access = await listMcpAccessForAgent(dbh.db, ctxA(), fx.agentA);
    expect(access.has(s.id)).toBe(false);
  });

  it("listMcpWithGrantStatus trả cờ granted + toolAllow", async () => {
    await grantMcpToAgent(dbh.db, ctxA(), grantedServerId, fx.agentA, { toolAllow: ["read_file"] });
    const rows = await listMcpWithGrantStatus(dbh.db, ctxA(), fx.agentA);
    const rieng = rows.find((r) => r.name === "kho-rieng");
    const chung = rows.find((r) => r.name === "fs-chung");
    expect(rieng?.granted).toBe(true);
    expect(rieng?.toolAllow).toEqual(["read_file"]);
    expect(chung?.granted).toBe(false);
  });

  it("boot list (SECURITY DEFINER) trả visibility + oauth", async () => {
    await saveMcpOauth(dbh.db, ctxA(), grantedServerId, "ma-hoa-gia");
    const boot = await listEnabledMcpServers(dbh.db);
    const rieng = boot.find((s) => s.id === grantedServerId);
    expect(rieng?.visibility).toBe("granted");
    expect(rieng?.oauthEncrypted).toBe("ma-hoa-gia");
    expect(boot.find((s) => s.id === wsServerId)?.visibility).toBe("workspace");
  });

  it("cách ly workspace: agent B không thấy server workspace A", async () => {
    const access = await listMcpAccessForAgent(dbh.db, ctxB(), fx.agentB);
    expect(access.size).toBe(0);
  });
});
