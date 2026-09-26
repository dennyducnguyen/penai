import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import { nextRun, validateSchedule } from "../src/cron.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Scheduler lanes", () => {
  it("giới hạn concurrency mỗi lane", async () => {
    const s = new Scheduler({ main: 2 });
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(30);
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => s.schedule("main", task)));
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("serialize theo sessionKey", async () => {
    const s = new Scheduler({ main: 4 });
    const order: string[] = [];
    const t1 = s.schedule("main", async () => { order.push("a1"); await sleep(30); order.push("a2"); }, "sess");
    const t2 = s.schedule("main", async () => { order.push("b1"); await sleep(5); order.push("b2"); }, "sess");
    await Promise.all([t1, t2]);
    expect(order).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("drain chặn việc mới", async () => {
    const s = new Scheduler();
    await s.drain();
    await expect(s.schedule("main", async () => 1)).rejects.toThrow(/drain/);
  });
});

describe("cron nextRun", () => {
  const base = new Date("2026-07-08T10:00:00Z");

  it("every 5m", () => {
    const n = nextRun("every 5m", base);
    expect(n!.getTime()).toBe(base.getTime() + 5 * 60_000);
  });

  it("every 2h", () => {
    const n = nextRun("every 2h", base);
    expect(n!.getTime()).toBe(base.getTime() + 2 * 3_600_000);
  });

  it("at future → thời điểm đó", () => {
    const n = nextRun("at 2026-12-31T23:59:00Z", base);
    expect(n).toEqual(new Date("2026-12-31T23:59:00Z"));
  });

  it("at past → null (one-shot đã qua)", () => {
    expect(nextRun("at 2020-01-01T00:00:00Z", base)).toBeNull();
  });

  it("cron expr hằng ngày 9h", () => {
    const n = nextRun("0 9 * * *", base);
    expect(n).toBeInstanceOf(Date);
    expect(n!.getTime()).toBeGreaterThan(base.getTime());
  });

  it("lịch sai → throw", () => {
    expect(() => validateSchedule("khong hop le @@@")).toThrow();
  });
});
