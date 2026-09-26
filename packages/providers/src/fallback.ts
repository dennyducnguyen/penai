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
 */
export class FallbackProvider implements Provider {
  readonly name: string;
  constructor(
    private primary: Provider,
    private fallbacks: FallbackStep[],
  ) {
    this.name = primary.name + "+fallback";
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    try {
      return await this.primary.chat(req);
    } catch (err) {
      lastErr = err;
    }
    for (const f of this.fallbacks) {
      try {
        return await f.provider.chat({ ...req, model: f.model });
      } catch (err) {
        lastErr = err;
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
    }
    for (const f of this.fallbacks) {
      try {
        yield* f.provider.chatStream({ ...req, model: f.model });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Tất cả provider đều lỗi");
  }
}
