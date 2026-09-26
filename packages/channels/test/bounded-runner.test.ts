import { describe, expect, it } from "vitest";
import { BoundedRunner } from "../src/bounded-runner.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("BoundedRunner (semaphore xử lý update nền)", () => {
  it("giới hạn đồng thời, quá trần thì xếp hàng, tất cả đều chạy", async () => {
    const r = new BoundedRunner(2);
    let running = 0;
    let peak = 0;
    let done = 0;
    for (let i = 0; i < 6; i++) {
      r.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(20);
        running--;
        done++;
      });
    }
    expect(await r.drain(2000)).toBe(true);
    expect(peak).toBe(2);
    expect(done).toBe(6);
  });

  it("run() trả về ngay — không chặn vòng nhận update", async () => {
    const r = new BoundedRunner(1);
    const t0 = Date.now();
    r.run(() => sleep(100));
    r.run(() => sleep(100));
    // 2 task 100ms xếp hàng nhưng run() không chờ
    expect(Date.now() - t0).toBeLessThan(50);
    await r.drain(2000);
  });

  it("task lỗi → gọi onError, không văng unhandled rejection", async () => {
    const errs: string[] = [];
    const r = new BoundedRunner(2, (e) => errs.push(e.message));
    r.run(async () => {
      throw new Error("hong roi");
    });
    r.run(async () => {});
    expect(await r.drain(1000)).toBe(true);
    expect(errs).toEqual(["hong roi"]);
  });

  it("drain quá timeout → trả false (không treo shutdown)", async () => {
    const r = new BoundedRunner(1);
    r.run(() => sleep(500));
    expect(await r.drain(50)).toBe(false);
  });
});
