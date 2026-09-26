import type { ChatRequest, ChatResponse, Provider, StreamEvent } from "@penai/providers";
import type { ProviderGate } from "./provider-gate.js";

/**
 * Bọc một Provider để mỗi lời gọi LLM đi qua ProviderGate.
 *
 * Vì sao chặn ở TẦNG PROVIDER chứ không ở tầng route HTTP:
 *   - Mọi lối vào (API, Dashboard, kênh chat, cron, subagent) đều dùng chung
 *     buildLoopDeps → tự động cùng đếm một trần, không cộng dồn.
 *   - Đo trên production: một tin nhắn người dùng = 2,49 lượt gọi LLM. Chặn
 *     theo "lượt agent" sẽ đánh giá thấp tải thật lên tài khoản/tiến trình.
 *
 * KHÔNG bao giờ giữ slot khi đang chờ slot khác: slot chỉ được giữ trong đúng
 * một lời gọi chat/chatStream, nhả ra trước khi tool chạy — nên agent gọi
 * subagent cũng không tự khoá chính mình.
 */
export function gatedProvider(
  gate: ProviderGate,
  inner: Provider,
  opts: {
    /** Tên provider dùng làm khoá trần (mặc định inner.name). */
    providerKey?: string;
    /** Nhóm công bằng — api key id, hoặc kênh chat. */
    bucket?: string;
    /** 0 = người dùng thật (kênh chat/dashboard), 1 = lưu lượng API. */
    priority?: number;
    onQueued?: (position: number, etaMs: number) => void;
  } = {},
): Provider {
  const key = opts.providerKey ?? inner.name;
  const runOpts = (signal?: AbortSignal) => ({
    ...(opts.bucket ? { bucket: opts.bucket } : {}),
    priority: opts.priority ?? 0,
    ...(signal ? { signal } : {}),
    ...(opts.onQueued ? { onQueued: opts.onQueued } : {}),
  });

  return {
    get name() {
      return inner.name;
    },
    chat(req: ChatRequest): Promise<ChatResponse> {
      return gate.run(key, () => inner.chat(req), runOpts(req.signal));
    },
    chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
      // Generator: slot được giữ từ lúc bắt đầu tới khi stream kết thúc/huỷ.
      return {
        async *[Symbol.asyncIterator]() {
          const queue: StreamEvent[] = [];
          let done = false;
          let failure: unknown = null;
          let wake: (() => void) | null = null;
          const push = (ev: StreamEvent) => {
            queue.push(ev);
            wake?.();
            wake = null;
          };

          const task = gate
            .run(
              key,
              async () => {
                for await (const ev of inner.chatStream(req)) push(ev);
              },
              runOpts(req.signal),
            )
            .catch((err) => {
              failure = err;
            })
            .finally(() => {
              done = true;
              wake?.();
              wake = null;
            });

          while (true) {
            while (queue.length) yield queue.shift()!;
            if (done) break;
            await new Promise<void>((r) => {
              wake = r;
            });
          }
          await task;
          while (queue.length) yield queue.shift()!;
          if (failure) throw failure;
        },
      };
    },
  };
}
