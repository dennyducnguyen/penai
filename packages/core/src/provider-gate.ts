/**
 * ProviderGate — trần đồng thời theo PROVIDER, dùng chung cho mọi lối vào
 * (API công khai, Dashboard, kênh chat, cron).
 *
 * Vì sao cần, và vì sao không sửa thẳng Scheduler:
 *   - Scheduler (lane) giới hạn theo LOẠI việc; ProviderGate giới hạn theo TÀI
 *     NGUYÊN thật (tiến trình CLI / tài khoản LLM). Hai trục khác nhau.
 *   - Đo trên VPS 12/09/2026: mỗi lần gọi `claude` ≈ 217 MB RSS, `agy` ≈ 221 MB,
 *     máy chỉ còn ~1,1 GB trống → tối đa 2 tiến trình CLI cùng lúc. Trần này
 *     phải là trần CHUNG (cliTotal), không cộng dồn theo từng lối vào.
 *
 * Khác Scheduler ở 5 điểm (đều là yêu cầu của API cho app ngoài):
 *   1. Huỷ TRƯỚC khi chạy khi client đã ngắt (Scheduler chạy bất kể).
 *   2. Trần độ dài hàng đợi + deadline chờ (Scheduler chờ vô hạn).
 *   3. Báo vị trí trong hàng đợi.
 *   4. Công bằng: round-robin giữa các "bucket" (API key), FIFO trong bucket.
 *   5. Ưu tiên: kênh chat người thật chen trước lưu lượng API.
 */

export class QueueRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: "full" | "timeout" | "aborted",
    readonly retryAfterSec: number,
  ) {
    super(message);
    this.name = "QueueRejectedError";
  }
}

export interface GateOptions {
  /** Trần đồng thời theo tên provider. Không khai báo → không giới hạn. */
  concurrency?: Record<string, number>;
  /** Trần CHUNG cho các provider thuộc nhóm CLI (spawn tiến trình). */
  cliTotal?: number;
  /** Provider nào tính vào cliTotal. */
  cliProviders?: string[];
  /** Trần số việc chờ trong một provider. */
  max?: number;
  /** Chờ quá lâu thì từ chối. */
  waitMs?: number;
}

export interface AcquireOptions {
  /** Nhóm công bằng — thường là api key id; cùng nhóm thì FIFO. */
  bucket?: string;
  /** Số nhỏ được phục vụ trước (0 = kênh chat người thật, 1 = API). */
  priority?: number;
  signal?: AbortSignal;
  /** Bỏ qua trần độ dài hàng đợi (dùng cho lối vào nội bộ, không phải API). */
  unbounded?: boolean;
}

interface Waiter {
  bucket: string;
  priority: number;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
  settled: boolean;
}

interface ProviderState {
  running: number;
  waiters: Waiter[];
  /** Con trỏ round-robin giữa các bucket. */
  rrBucket: string | null;
  /** Thời lượng các lượt chạy gần đây (ms) — ước lượng eta. */
  recentMs: number[];
}

const DEFAULT_MAX = 20;
const DEFAULT_WAIT_MS = 30_000;
const RECENT_KEEP = 20;

export class ProviderGate {
  private states = new Map<string, ProviderState>();
  private cliRunning = 0;
  private seq = 0;
  private opts: Required<Omit<GateOptions, "concurrency">> & {
    concurrency: Record<string, number>;
  };

  constructor(opts: GateOptions = {}) {
    this.opts = {
      concurrency: opts.concurrency ?? {},
      cliTotal: opts.cliTotal ?? Number.POSITIVE_INFINITY,
      cliProviders: opts.cliProviders ?? ["claude-code", "antigravity"],
      max: opts.max ?? DEFAULT_MAX,
      waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
    };
  }

  /** Đổi cấu hình lúc chạy (config hot-reload). Không đụng việc đang chạy. */
  reconfigure(opts: GateOptions): void {
    this.opts = {
      concurrency: opts.concurrency ?? this.opts.concurrency,
      cliTotal: opts.cliTotal ?? this.opts.cliTotal,
      cliProviders: opts.cliProviders ?? this.opts.cliProviders,
      max: opts.max ?? this.opts.max,
      waitMs: opts.waitMs ?? this.opts.waitMs,
    };
    // Trần rộng ra thì đánh thức ngay các waiter đang chờ.
    for (const provider of this.states.keys()) this.pump(provider);
  }

  private state(provider: string): ProviderState {
    let st = this.states.get(provider);
    if (!st) {
      st = { running: 0, waiters: [], rrBucket: null, recentMs: [] };
      this.states.set(provider, st);
    }
    return st;
  }

  private isCli(provider: string): boolean {
    return this.opts.cliProviders.includes(provider);
  }

  private limitOf(provider: string): number {
    return this.opts.concurrency[provider] ?? Number.POSITIVE_INFINITY;
  }

  private hasSlot(provider: string): boolean {
    const st = this.state(provider);
    if (st.running >= this.limitOf(provider)) return false;
    if (this.isCli(provider) && this.cliRunning >= this.opts.cliTotal) return false;
    return true;
  }

  /** Chạy được ngay (còn slot, không ai đang chờ) — để ImageRouter chọn backend rảnh trước. */
  isFree(provider: string): boolean {
    return this.hasSlot(provider) && this.state(provider).waiters.length === 0;
  }

  /** Vị trí (1-based) một việc mới sẽ nhận nếu phải xếp hàng. */
  queuePosition(provider: string): number {
    return this.state(provider).waiters.length + 1;
  }

  /** Ước lượng thời gian chờ theo trung vị các lượt gần đây. */
  etaMs(provider: string, position: number): number {
    const st = this.state(provider);
    if (!st.recentMs.length) return 0;
    const sorted = [...st.recentMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const limit = Math.min(this.limitOf(provider), this.opts.cliTotal);
    const parallel = Number.isFinite(limit) ? Math.max(1, limit) : 1;
    return Math.round((position / parallel) * median);
  }

  stats(): Record<
    string,
    { running: number; queued: number; limit: number | null; recentMedianMs: number }
  > {
    const out: Record<
      string,
      { running: number; queued: number; limit: number | null; recentMedianMs: number }
    > = {};
    for (const [provider, st] of this.states) {
      const limit = this.limitOf(provider);
      const sorted = [...st.recentMs].sort((a, b) => a - b);
      out[provider] = {
        running: st.running,
        queued: st.waiters.length,
        limit: Number.isFinite(limit) ? limit : null,
        recentMedianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      };
    }
    return out;
  }

  /**
   * Chạy fn dưới trần của provider. Ném QueueRejectedError khi hàng đợi đầy,
   * chờ quá hạn, hoặc client đã ngắt trước khi tới lượt.
   *
   * onQueued được gọi MỘT lần nếu việc phải xếp hàng (để báo vị trí cho client).
   */
  async run<T>(
    provider: string,
    fn: () => Promise<T>,
    opts: AcquireOptions & { onQueued?: (position: number, etaMs: number) => void } = {},
  ): Promise<T> {
    const st = this.state(provider);

    if (this.hasSlot(provider)) {
      this.take(provider, opts.bucket ?? "");
    } else {
      if (!opts.unbounded && st.waiters.length >= this.opts.max) {
        throw new QueueRejectedError(
          `Hàng đợi "${provider}" đã đầy (${st.waiters.length}/${this.opts.max})`,
          "full",
          Math.max(1, Math.ceil(this.etaMs(provider, st.waiters.length) / 1000)),
        );
      }
      const position = st.waiters.length + 1;
      opts.onQueued?.(position, this.etaMs(provider, position));
      // waitForSlot chỉ resolve SAU KHI pump() đã giữ slot hộ (take()), nên
      // không có cửa sổ để hai waiter cùng nhận một slot.
      await this.waitForSlot(provider, opts);
    }

    const started = Date.now();
    try {
      return await fn();
    } finally {
      const elapsed = Date.now() - started;
      st.recentMs.push(elapsed);
      if (st.recentMs.length > RECENT_KEEP) st.recentMs.shift();
      this.give(provider);
    }
  }

  /**
   * Giữ một slot (đồng bộ) và ghi nhận bucket vừa được phục vụ — phải ghi ở
   * CẢ đường đi thẳng (còn slot) lẫn đường qua hàng đợi, nếu không round-robin
   * sẽ không biết app nào vừa chạy và một app có thể chiếm hết lượt.
   */
  private take(provider: string, bucket: string): void {
    const st = this.state(provider);
    st.running++;
    st.rrBucket = bucket;
    if (this.isCli(provider)) this.cliRunning++;
  }

  /** Trả slot rồi đánh thức hàng đợi — kể cả provider CLI khác đang chờ cliTotal. */
  private give(provider: string): void {
    this.state(provider).running--;
    if (this.isCli(provider)) this.cliRunning--;
    this.pump(provider);
    if (this.isCli(provider)) {
      for (const other of this.opts.cliProviders) {
        if (other !== provider) this.pump(other);
      }
    }
  }

  private waitForSlot(provider: string, opts: AcquireOptions): Promise<void> {
    const st = this.state(provider);
    return new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new QueueRejectedError("Client đã ngắt", "aborted", 0));
        return;
      }
      const waiter: Waiter = {
        bucket: opts.bucket ?? "",
        priority: opts.priority ?? 1,
        seq: this.seq++,
        resolve,
        reject,
        settled: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      const settle = (fn: () => void) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort && waiter.signal) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        const i = st.waiters.indexOf(waiter);
        if (i >= 0) st.waiters.splice(i, 1);
        fn();
      };
      waiter.resolve = () => settle(resolve);
      waiter.reject = (err) => settle(() => reject(err));

      waiter.timer = setTimeout(() => {
        waiter.reject(
          new QueueRejectedError(
            `Chờ quá ${Math.round(this.opts.waitMs / 1000)}s trong hàng đợi "${provider}"`,
            "timeout",
            Math.max(1, Math.ceil(this.opts.waitMs / 1000)),
          ),
        );
      }, this.opts.waitMs);
      // Không giữ tiến trình sống chỉ vì timer hàng đợi.
      waiter.timer.unref?.();

      if (opts.signal) {
        // Điểm khác Scheduler: client ngắt lúc đang chờ → BỎ khỏi hàng, không
        // bao giờ chạy. Nếu không, hàng đợi đầy request đã chết mà vẫn đốt quota.
        waiter.onAbort = () =>
          waiter.reject(new QueueRejectedError("Client đã ngắt", "aborted", 0));
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      st.waiters.push(waiter);
    });
  }

  /**
   * Gọi các waiter đủ điều kiện: ưu tiên thấp trước, round-robin giữa bucket.
   * Slot được GIỮ ngay tại đây (take) trước khi resolve, nên dù resolve là
   * microtask cũng không có hai waiter cùng nhận một slot.
   */
  private pump(provider: string): void {
    const st = this.states.get(provider);
    if (!st) return;
    while (st.waiters.length && this.hasSlot(provider)) {
      const next = this.pickNext(st);
      if (!next) break;
      this.take(provider, next.bucket);
      next.resolve();
    }
  }

  /**
   * Chọn waiter kế: ưu tiên nhỏ nhất; trong cùng mức ưu tiên thì round-robin
   * sang bucket khác bucket vừa phục vụ (một app không bắt các app khác chờ),
   * trong cùng bucket thì FIFO.
   */
  private pickNext(st: ProviderState): Waiter | null {
    if (!st.waiters.length) return null;
    const minPriority = Math.min(...st.waiters.map((w) => w.priority));
    const pool = st.waiters.filter((w) => w.priority === minPriority);
    const others = pool.filter((w) => w.bucket !== st.rrBucket);
    const from = others.length ? others : pool;
    return from.reduce((a, b) => (a.seq <= b.seq ? a : b));
  }
}
