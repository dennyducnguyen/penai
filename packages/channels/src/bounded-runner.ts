/**
 * Chạy task nền có giới hạn đồng thời (semaphore, mặc định 20 việc):
 * - Vòng nhận update của channel KHÔNG chờ task xong → người dùng A chạy agent
 *   60 giây không chặn tin nhắn của người dùng B.
 * - Quá giới hạn thì task xếp hàng (không rơi), thứ tự vào theo thứ tự đến.
 * - drain() cho graceful shutdown: chờ task đang bay xong (có timeout).
 */
export class BoundedRunner {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];
  private waiters: Array<() => void> = [];

  constructor(
    private limit: number,
    private onError?: (err: Error) => void,
  ) {}

  /** Nhận task chạy nền — trả về ngay lập tức. */
  run(fn: () => Promise<void>): void {
    const task = async () => {
      try {
        await fn();
      } catch (err) {
        this.onError?.(err as Error);
      } finally {
        this.running--;
        const next = this.queue.shift();
        if (next) {
          this.running++;
          void next();
        } else if (this.running === 0) {
          for (const w of this.waiters.splice(0)) w();
        }
      }
    };
    if (this.running < this.limit) {
      this.running++;
      void task();
    } else {
      this.queue.push(task);
    }
  }

  /** Số task đang chạy + đang chờ (giám sát/test). */
  size(): number {
    return this.running + this.queue.length;
  }

  /** Chờ mọi task xong, tối đa timeoutMs (dùng khi tắt dịch vụ êm). */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    if (this.running === 0 && this.queue.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
