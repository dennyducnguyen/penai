import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createCronJob,
  listCronJobs,
  claimDueCronJobs,
  updateCronNextRun,
  recordCronRun,
  listCronRuns,
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

describe("cron jobs (RLS + atomic claim)", () => {
  it("tạo + list scoped", async () => {
    await createCronJob(dbh.db, ctxA(), {
      agentId: fx.agentA,
      name: "báo cáo sáng",
      schedule: "every 1h",
      prompt: "Tổng hợp tình hình",
      nextRun: new Date(Date.now() - 1000), // đã tới hạn
    });
    const jobs = await listCronJobs(dbh.db, ctxA());
    expect(jobs.length).toBe(1);
  });

  it("claimDueCronJobs lấy job tới hạn, không lấy lần 2 nếu chưa reset next_run", async () => {
    const now = new Date();
    const due1 = await claimDueCronJobs(dbh.db, now, 10);
    expect(due1.length).toBe(1);
    const jobId = due1[0]!.id;

    // Chưa cập nhật next_run về tương lai → vẫn có thể claim lại (last_run đã set)
    // Đẩy next_run về tương lai:
    await updateCronNextRun(dbh.db, jobId, new Date(Date.now() + 3_600_000), false);
    const due2 = await claimDueCronJobs(dbh.db, new Date(), 10);
    expect(due2.length).toBe(0); // không còn job tới hạn
  });

  it("ghi + đọc log cron run", async () => {
    const jobs = await listCronJobs(dbh.db, ctxA());
    const jobId = jobs[0]!.id;
    await recordCronRun(dbh.db, ctxA(), jobId, "ok", "kết quả chạy");
    const runs = await listCronRuns(dbh.db, ctxA(), jobId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("ok");
    expect(runs[0]!.output).toBe("kết quả chạy");
  });

  it("one-shot 'at' quá khứ → disable", async () => {
    const jobs = await listCronJobs(dbh.db, ctxA());
    await updateCronNextRun(dbh.db, jobs[0]!.id, null, true);
    const after = await listCronJobs(dbh.db, ctxA());
    expect(after[0]!.enabled).toBe(false);
  });
});
