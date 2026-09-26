import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createTeam,
  addTeamMember,
  getAgentTeam,
  createTeamTask,
  claimTeamTask,
  completeTeamTask,
  listTeamTasks,
  createAgentLink,
  canDelegate,
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

describe("teams + task board (atomic claim)", () => {
  it("tạo team, thêm member, tra team của agent", async () => {
    const team = await createTeam(dbh.db, ctxA(), "Nhóm bán hàng");
    await addTeamMember(dbh.db, ctxA(), team.id, fx.agentA);
    expect(await getAgentTeam(dbh.db, ctxA(), fx.agentA)).toBe(team.id);
  });

  it("claim atomic: mỗi task chỉ 1 agent lấy được", async () => {
    const team = (await createTeam(dbh.db, ctxA(), "Nhóm claim"));
    await createTeamTask(dbh.db, ctxA(), { teamId: team.id, title: "task-1" });

    // 5 lần claim song song → chỉ 1 lấy được task, còn lại null
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimTeamTask(dbh.db, ctxA(), team.id, fx.agentA)),
    );
    const claimed = results.filter((r) => r !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.title).toBe("task-1");
  });

  it("hoàn thành task → status done", async () => {
    const team = await createTeam(dbh.db, ctxA(), "Nhóm done");
    const t = await createTeamTask(dbh.db, ctxA(), { teamId: team.id, title: "x" });
    const claimed = await claimTeamTask(dbh.db, ctxA(), team.id, fx.agentA);
    await completeTeamTask(dbh.db, ctxA(), claimed!.id, "xong rồi");
    const tasks = await listTeamTasks(dbh.db, ctxA(), team.id);
    expect(tasks.find((x) => x.id === t.id)!.status).toBe("done");
    expect(tasks.find((x) => x.id === t.id)!.result).toBe("xong rồi");
  });

  it("agent link cho phép delegate", async () => {
    expect(await canDelegate(dbh.db, ctxA(), fx.agentA, fx.agentA)).toBe(false);
    await createAgentLink(dbh.db, ctxA(), fx.agentA, fx.agentA, "sync");
    expect(await canDelegate(dbh.db, ctxA(), fx.agentA, fx.agentA)).toBe(true);
  });
});
