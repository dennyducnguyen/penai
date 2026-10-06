import { logger } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
} from "./types.js";

export interface FallbackStep {
  provider: Provider;
  model: string;
}

/**
 * Provider bọc: thử provider chính (dùng model trong request), nếu lỗi thì
 * lần lượt fallback (mỗi fallback override model riêng).
 *
 * Trần đồng thời (ProviderGate) phải bọc TỪNG chặng trước khi đưa vào đây,
 * không bọc bên ngoài: như vậy chặng chính hết chỗ/chờ quá hạn cũng là một lỗi
 * để chuyển chặng, và lượt chạy ở chặng dự phòng không chiếm chỗ của chặng chính.
 */
export class FallbackProvider implements Provider {
  readonly name: string;
  constructor(
    private primary: Provider,
    private fallbacks: FallbackStep[],
  ) {
    this.name = primary.name + "+fallback";
  }

  /** Người dùng đã huỷ thì dừng hẳn, không chạy tiếp chặng dự phòng. */
  private failed(req: ChatRequest, from: string, err: unknown, hasNext: boolean): void {
    if (req.signal?.aborted) throw err instanceof Error ? err : new Error("Đã huỷ");
    if (!hasNext) return;
    // Chỉ ghi thông báo lỗi (không ghi nội dung hội thoại).
    logger.warn(
      { event: "provider.fallback", from, error: (err as Error)?.message?.slice(0, 300) },
      "Provider lỗi — chuyển sang chặng dự phòng",
    );
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    try {
      return await this.primary.chat(req);
    } catch (err) {
      lastErr = err;
      this.failed(req, this.primary.name, err, this.fallbacks.length > 0);
    }
    for (const [i, f] of this.fallbacks.entries()) {
      try {
        return await f.provider.chat({ ...req, model: f.model });
      } catch (err) {
        lastErr = err;
        this.failed(req, f.provider.name, err, i < this.fallbacks.length - 1);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Tất cả provider đều lỗi");
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    let lastErr: unknown;
    try {
      yield* this.primary.chatStream(req);
      return;
    } catch (err) {
      lastErr = err;
      this.failed(req, this.primary.name, err, this.fallbacks.length > 0);
    }
    for (const [i, f] of this.fallbacks.entries()) {
      try {
        yield* f.provider.chatStream({ ...req, model: f.model });
        return;
      } catch (err) {
        lastErr = err;
        this.failed(req, f.provider.name, err, i < this.fallbacks.length - 1);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Tất cả provider đều lỗi");
  }
}
