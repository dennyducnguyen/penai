/**
 * Hiệu ứng "đang soạn tin…" cho một lượt trả lời.
 *
 * - Gửi lại định kỳ (keepaliveMs): Telegram tự tắt chỉ báo sau ~5 giây.
 * - Luôn tự tắt sau maxDurationMs (mặc định 60 giây) để không bao giờ treo mãi.
 * - Chỉ tắt hẳn khi CẢ agent đã chạy xong LẪN tin trả lời đã gửi đi — tắt sớm
 *   hơn thì người dùng thấy một khoảng lặng trước khi tin tới.
 */
export interface TypingOptions {
  /** Thời gian tối đa giữ chỉ báo. Mặc định 60 giây; 0 = không giới hạn. */
  maxDurationMs?: number;
  /** Chu kỳ gửi lại chỉ báo. 0 hoặc bỏ trống = chỉ gửi một lần. */
  keepaliveMs?: number;
  /** Gửi chỉ báo "đang soạn" (tùy kênh). */
  start: () => Promise<unknown> | void;
  /** Tắt chỉ báo (tùy chọn — Telegram tự tắt khi tin trả lời tới). */
  stop?: () => Promise<unknown> | void;
}

type Phase = "idle" | "active" | "closed";

export class TypingController {
  private phase: Phase = "idle";
  /** Hai tín hiệu phải có đủ trước khi tắt: agent xong + đã gửi tin. */
  private readonly awaiting = new Set<"run" | "dispatch">(["run", "dispatch"]);
  private repeat: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: TypingOptions) {}

  /** Bật chỉ báo. Gọi nhiều lần không sao. */
  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "active";
    this.send(this.opts.start);
    const every = this.opts.keepaliveMs ?? 0;
    if (every > 0) this.repeat = setInterval(() => this.send(this.opts.start), every);
    const limit = this.opts.maxDurationMs ?? 60_000;
    if (limit > 0) this.deadline = setTimeout(() => this.close(), limit);
  }

  /** Agent đã chạy xong. */
  markRunComplete(): void {
    this.settle("run");
  }

  /** Tin trả lời đã gửi xong. */
  markDispatchIdle(): void {
    this.settle("dispatch");
  }

  /** Tắt ngay, bất kể tín hiệu nào đã có. */
  stopNow(): void {
    this.close();
  }

  private settle(signal: "run" | "dispatch"): void {
    this.awaiting.delete(signal);
    if (this.awaiting.size === 0) this.close();
  }

  private close(): void {
    if (this.phase === "closed") return;
    const wasActive = this.phase === "active";
    this.phase = "closed";
    clearInterval(this.repeat);
    clearTimeout(this.deadline);
    if (wasActive && this.opts.stop) this.send(this.opts.stop);
  }

  private send(fn: () => Promise<unknown> | void): void {
    if (fn !== this.opts.stop && this.phase !== "active") return;
    try {
      void Promise.resolve(fn()).catch(() => {});
    } catch {
      // lỗi đồng bộ khi gọi API kênh — chỉ báo gõ phím không được làm hỏng lượt trả lời
    }
  }
}
