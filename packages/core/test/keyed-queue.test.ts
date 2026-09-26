import { describe, expect, it } from "vitest";
import { KeyedQueue } from "../src/keyed-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedQueue (spec-agent-loop AC-4)", () => {
  it("cùng key chạy tuần tự", async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const t1 = q.run("s1", async () => {
      order.push("1-start");
      await sleep(50);
      order.push("1-end");
    });
    const t2 = q.run("s1", async () => {
      order.push("2-start");
      await sleep(10);
      order.push("2-end");
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
  });

  it("khác key chạy song song", async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const t1 = q.run("a", async () => {
      order.push("a-start");
      await sleep(50);
      order.push("a-end");
    });
    const t2 = q.run("b", async () => {
      order.push("b-start");
      await sleep(10);
      order.push("b-end");
    });
    await Promise.all([t1, t2]);
    // b bắt đầu trước khi a kết thúc → song song
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  it("lỗi ở lượt trước không chặn lượt sau; queue tự dọn", async () => {
    const q = new KeyedQueue();
    const first = q.run("k", async () => {
      throw new Error("hỏng");
    });
    await expect(first).rejects.toThrow("hỏng");
    const second = await q.run("k", async () => "ok");
    expect(second).toBe("ok");
    expect(q.size()).toBe(0);
  });
});
