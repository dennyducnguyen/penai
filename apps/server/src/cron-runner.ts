import { logger } from "@penai/shared";
import {
  claimDueCronJobs,
  createSession,
  getAgentById,
  recordCronRun,
  recordTraceSafe,
  updateCronNextRun,
} from "@penai/db";
import { nextRun, runAgentText, Scheduler } from "@penai/core";
import { buildLoopDeps, agentOpts, systemContext, type RuntimeDeps } from "./agent-runtime.js";

const POLL_MS = 20_000;
const BATCH = 10;

/**
 * Chạy nền: định kỳ lấy các cron job tới hạn (atomic claim) và thực thi
 * qua lane "cron" của Scheduler. Sau mỗi lần chạy: ghi log + tính next_run
 * (one-shot "at" đã qua → disable).
 */
export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduler: Scheduler;
  private stopping = false;

  constructor(private rt: RuntimeDeps) {
    this.scheduler = new Scheduler({ cron: 2 });
  }

  start(): void {
    // chạy 1 lần ngay, rồi định kỳ
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.scheduler.drain(15_000);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    let due;
    try {
      due = await claimDueCronJobs(this.rt.db.db, new Date(), BATCH);
    } catch (err) {
      logger.warn(`CronRunner: lỗi lấy job — ${(err as Error).message}`);
      return;
    }
    for (const job of due) {
      void this.scheduler
        .schedule("cron", () => this.runJob(job), `cron:${job.id}`)
        .catch((e) => logger.error(`Cron "${job.name}" lỗi: ${(e as Error).message}`));
    }
  }

  private async runJob(job: {
    id: string;
    workspaceId: string;
    agentId: string;
    name: string;
    prompt: string;
    schedule: string;
  }): Promise<void> {
    const ctx = systemContext(job.workspaceId);
    const { db } = this.rt.db;
    let status: "ok" | "error" = "ok";
    let output = "";
    try {
      const agent = await getAgentById(db, ctx, job.agentId);
      if (!agent) throw new Error("Agent không tồn tại");
      const session = await createSession(db, ctx, {
        agentId: job.agentId,
        title: `cron:${job.name}`,
      });
      const loopDeps = await buildLoopDeps(this.rt, ctx, agent.provider, {
        ...agentOpts(agent),
        sourceKind: "cron",
        accessRole: null,
      });
      const res = await runAgentText(loopDeps, {
        ctx,
        agent: {
          systemPrompt: agent.systemPrompt,
          model: agent.model,
          maxIterations: agent.maxIterations,
        },
        sessionId: session.id,
        userMessage: job.prompt,
      });
      output = res.text;
      recordTraceSafe(db, ctx, {
        agentId: job.agentId,
        sessionId: session.id,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        iterations: res.iterations,
        durationMs: res.durationMs,
        source: "cron",
        model: agent.model,
        provider: agent.provider,
        kind: "cron",
      });
      logger.info(`Cron "${job.name}" chạy xong (${res.iterations} vòng)`);
    } catch (err) {
      status = "error";
      output = (err as Error).message;
    }

    try {
      await recordCronRun(db, ctx, job.id, status, output);
      const next = nextRun(job.schedule, new Date());
      await updateCronNextRun(db, job.id, next, next === null);
    } catch (err) {
      logger.warn(`Cron "${job.name}": cập nhật next_run lỗi — ${(err as Error).message}`);
    }
  }
}
