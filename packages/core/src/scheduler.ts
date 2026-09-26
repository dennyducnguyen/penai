import { KeyedQueue } from "./keyed-queue.js";

export type Lane = "main" | "subagent" | "cron" | "team";

interface LaneState {
  limit: number;
  running: number;
  queue: Array<() => void>;
}

/**
 * Scheduler chia làn (lane): mỗi lane có giới hạn concurrency
 * riêng; công việc cùng sessionKey được serialize (KeyedQueue) để không có
 * 2 lượt agent chạy song song trên cùng session. Graceful drain khi shutdown.
 */
export class Scheduler {
  private lanes: Record<Lane, LaneState>;
  private sessionQueue = new KeyedQueue();
  private draining = false;
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    limits: Partial<Record<Lane, number>> = {},
  ) {
    const mk = (n: number): LaneState => ({ limit: n, running: 0, queue: [] });
    this.lanes = {
      main: mk(limits.main ?? 4),
      subagent: mk(limits.subagent ?? 3),
      cron: mk(limits.cron ?? 2),
      team: mk(limits.team ?? 3),
    };
  }

  private acquire(lane: Lane): Promise<void> {
    const st = this.lanes[lane];
    if (st.running < st.limit) {
      st.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => st.queue.push(resolve));
  }

  private release(lane: Lane): void {
    const st = this.lanes[lane];
    const next = st.queue.shift();
    if (next) next();
    else st.running--;
  }

  /**
   * Chạy 1 công việc trong lane. Nếu có sessionKey → serialize theo session.
   * Trả về kết quả của fn. Ném lỗi nếu đang drain.
   */
  async schedule<T>(
    lane: Lane,
    fn: () => Promise<T>,
    sessionKey?: string,
  ): Promise<T> {
    if (this.draining) throw new Error("Scheduler đang tắt (drain)");
    await this.acquire(lane);
    const task = (async () => {
      try {
        return sessionKey
          ? await this.sessionQueue.run(sessionKey, fn)
          : await fn();
      } finally {
        this.release(lane);
      }
    })();
    this.inFlight.add(task);
    // .finally() tạo promise NHÁNH MỚI — nếu task reject mà nhánh này không có
    // .catch thì thành unhandled rejection và LÀM SẬP process (đã xảy ra
    // production: 1 lỗi 400 từ provider giết cả server). Caller vẫn nhận lỗi
    // qua `task` trả về bên dưới.
    task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }

  stats(): Record<Lane, { running: number; queued: number; limit: number }> {
    const out = {} as Record<Lane, { running: number; queued: number; limit: number }>;
    for (const lane of Object.keys(this.lanes) as Lane[]) {
      const st = this.lanes[lane];
      out[lane] = { running: st.running, queued: st.queue.length, limit: st.limit };
    }
    return out;
  }

  /** Ngừng nhận việc mới, chờ mọi việc đang chạy xong (có timeout). */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    const all = Promise.allSettled([...this.inFlight]);
    await Promise.race([
      all,
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
