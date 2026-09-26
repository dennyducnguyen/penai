import { describe, expect, it } from "vitest";
import { ProviderGate, QueueRejectedError } from "../src/provider-gate.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ProviderGate", () => {
  it("giới hạn đồng thời theo provider", async () => {
    const gate = new ProviderGate({ concurrency: { "claude-code": 1 } });
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(20);
      running--;
    };
    await Promise.all(
      Array.from({ length: 5 }, () => gate.run("claude-code", job)),
    );
    expect(peak).toBe(1);
  });

  it("cliTotal là trần CHUNG giữa các provider CLI", async () => {
    const gate = new ProviderGate({
      concurrency: { "claude-code": 2, antigravity: 2 },
      cliTotal: 2,
      cliProviders: ["claude-code", "antigravity"],
    });
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(20);
      running--;
    };
    await Promise.all([
      ...Array.from({ length: 3 }, () => gate.run("claude-code", job)),
      ...Array.from({ length: 3 }, () => gate.run("antigravity", job)),
    ]);
    expect(peak).toBe(2);
  });

  it("provider không khai báo trần thì chạy song song tự do", async () => {
    const gate = new ProviderGate({ concurrency: { "claude-code": 1 } });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.run("codex", async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(10);
          running--;
        }),
      ),
    );
    expect(peak).toBe(4);
  });

  it("hàng đợi đầy → QueueRejectedError(full), không xếp hàng vô hạn", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 }, max: 2 });
    const long = () => gate.run("x", () => sleep(60));
    const inflight = [long(), long(), long()]; // 1 chạy + 2 chờ = đầy
    await sleep(5);
    await expect(long()).rejects.toBeInstanceOf(QueueRejectedError);
    await Promise.all(inflight);
  });

  it("chờ quá waitMs → QueueRejectedError(timeout)", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 }, waitMs: 30 });
    const first = gate.run("x", () => sleep(200));
    await sleep(5);
    const err = await gate.run("x", async () => "xong").catch((e) => e);
    expect(err).toBeInstanceOf(QueueRejectedError);
    expect((err as QueueRejectedError).reason).toBe("timeout");
    await first;
  });

  it("client ngắt lúc đang chờ → KHÔNG chạy fn", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 } });
    const first = gate.run("x", () => sleep(80));
    await sleep(5);
    const ac = new AbortController();
    let ran = false;
    const second = gate
      .run(
        "x",
        async () => {
          ran = true;
        },
        { signal: ac.signal },
      )
      .catch((e) => e);
    ac.abort();
    const err = await second;
    expect(err).toBeInstanceOf(QueueRejectedError);
    expect((err as QueueRejectedError).reason).toBe("aborted");
    await first;
    await sleep(20);
    expect(ran).toBe(false);
  });

  it("ưu tiên: kênh chat (0) chen trước API (1)", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 } });
    const order: string[] = [];
    const first = gate.run("x", () => sleep(40));
    await sleep(5);
    const api = gate.run("x", async () => void order.push("api"), { priority: 1 });
    const chan = gate.run("x", async () => void order.push("channel"), { priority: 0 });
    await Promise.all([first, api, chan]);
    expect(order).toEqual(["channel", "api"]);
  });

  it("công bằng: round-robin giữa các bucket", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 } });
    const order: string[] = [];
    const first = gate.run("x", () => sleep(40), { bucket: "a" });
    await sleep(5);
    const jobs = [
      gate.run("x", async () => void order.push("a1"), { bucket: "a" }),
      gate.run("x", async () => void order.push("a2"), { bucket: "a" }),
      gate.run("x", async () => void order.push("b1"), { bucket: "b" }),
    ];
    await Promise.all([first, ...jobs]);
    // App "a" đã được phục vụ trước → lượt kế phải sang "b", không để "a" chiếm hết
    expect(order[0]).toBe("b1");
  });

  it("báo vị trí hàng đợi qua onQueued", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 } });
    const first = gate.run("x", () => sleep(40));
    await sleep(5);
    const seen: number[] = [];
    const rest = [1, 2].map(() =>
      gate.run("x", async () => undefined, {
        onQueued: (pos) => seen.push(pos),
      }),
    );
    await Promise.all([first, ...rest]);
    expect(seen).toEqual([1, 2]);
  });

  it("stats phản ánh running/queued", async () => {
    const gate = new ProviderGate({ concurrency: { x: 1 } });
    const first = gate.run("x", () => sleep(40));
    await sleep(5);
    const queued = gate.run("x", async () => undefined);
    expect(gate.stats().x?.running).toBe(1);
    expect(gate.stats().x?.queued).toBe(1);
    await Promise.all([first, queued]);
    expect(gate.stats().x?.running).toBe(0);
  });
});
