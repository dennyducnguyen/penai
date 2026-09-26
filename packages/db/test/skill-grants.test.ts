import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createSkill,
  toggleSkill,
  setSkillVisibility,
  grantSkillToAgent,
  revokeSkillFromAgent,
  listSkillsWithGrantStatus,
  listSkillsForAgent,
  searchSkillsForAgent,
  agentCanUseSkill,
  createLlmProvider,
  listLlmProviders,
  listEnabledLlmProviders,
  deleteLlmProvider,
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

describe("skill grants per-agent", () => {
  let wsSkillId = "";
  let grantedSkillId = "";

  it("skill visibility=workspace: mọi agent thấy", async () => {
    const s = await createSkill(dbh.db, ctxA(), {
      slug: "ky-nang-chung",
      name: "Kỹ năng chung",
      description: "Ai cũng dùng được kỹ năng chung này",
      content: "Nội dung chung",
    });
    wsSkillId = s.id;
    const visible = await listSkillsForAgent(dbh.db, ctxA(), fx.agentA);
    expect(visible.map((x) => x.slug)).toContain("ky-nang-chung");
    expect(await agentCanUseSkill(dbh.db, ctxA(), fx.agentA, "ky-nang-chung")).toBe(true);
  });

  it("visibility=granted: chỉ agent được grant mới thấy", async () => {
    const s = await createSkill(dbh.db, ctxA(), {
      slug: "ky-nang-rieng",
      name: "Kỹ năng riêng",
      description: "Kỹ năng bảo mật chỉ cấp riêng",
      content: "Nội dung riêng",
    });
    grantedSkillId = s.id;
    await setSkillVisibility(dbh.db, ctxA(), s.id, "granted");

    // chưa grant → không thấy
    let visible = await listSkillsForAgent(dbh.db, ctxA(), fx.agentA);
    expect(visible.map((x) => x.slug)).not.toContain("ky-nang-rieng");
    expect(await agentCanUseSkill(dbh.db, ctxA(), fx.agentA, "ky-nang-rieng")).toBe(false);

    // grant → thấy
    await grantSkillToAgent(dbh.db, ctxA(), s.id, fx.agentA);
    visible = await listSkillsForAgent(dbh.db, ctxA(), fx.agentA);
    expect(visible.map((x) => x.slug)).toContain("ky-nang-rieng");
    expect(await agentCanUseSkill(dbh.db, ctxA(), fx.agentA, "ky-nang-rieng")).toBe(true);

    // search theo phạm vi agent
    const found = await searchSkillsForAgent(dbh.db, ctxA(), fx.agentA, "bảo mật", 5);
    expect(found.map((x) => x.slug)).toContain("ky-nang-rieng");

    // revoke → mất
    await revokeSkillFromAgent(dbh.db, ctxA(), s.id, fx.agentA);
    expect(await agentCanUseSkill(dbh.db, ctxA(), fx.agentA, "ky-nang-rieng")).toBe(false);
  });

  it("listSkillsWithGrantStatus trả cờ granted", async () => {
    await grantSkillToAgent(dbh.db, ctxA(), grantedSkillId, fx.agentA);
    const rows = await listSkillsWithGrantStatus(dbh.db, ctxA(), fx.agentA);
    const riebg = rows.find((r) => r.slug === "ky-nang-rieng");
    const chung = rows.find((r) => r.slug === "ky-nang-chung");
    expect(riebg?.granted).toBe(true);
    expect(chung?.granted).toBe(false);
  });

  it("toggle enabled=false → agent không thấy nữa", async () => {
    await toggleSkill(dbh.db, ctxA(), wsSkillId, false);
    const visible = await listSkillsForAgent(dbh.db, ctxA(), fx.agentA);
    expect(visible.map((x) => x.slug)).not.toContain("ky-nang-chung");
    await toggleSkill(dbh.db, ctxA(), wsSkillId, true);
  });

  it("cách ly workspace: agent B không thấy skill workspace A", async () => {
    const visible = await listSkillsForAgent(dbh.db, ctxB(), fx.agentB);
    expect(visible.length).toBe(0);
  });
});

describe("llm_providers (DB provider + RLS)", () => {
  it("tạo + list + boot list + xóa", async () => {
    const p = await createLlmProvider(dbh.db, ctxA(), {
      name: "qwen-test",
      kind: "qwen",
      apiKeyEncrypted: "khong-phai-key-that",
      defaultModel: "qwen3-max",
    });
    const rows = await listLlmProviders(dbh.db, ctxA());
    expect(rows.map((r) => r.name)).toContain("qwen-test");
    // workspace B không thấy
    expect((await listLlmProviders(dbh.db, ctxB())).length).toBe(0);
    // boot list (SECURITY DEFINER) thấy
    const boot = await listEnabledLlmProviders(dbh.db);
    expect(boot.map((r) => r.name)).toContain("qwen-test");
    await deleteLlmProvider(dbh.db, ctxA(), p.id);
    expect((await listLlmProviders(dbh.db, ctxA())).map((r) => r.name)).not.toContain("qwen-test");
  });
});
