import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * SSE cho API OpenAI-compatible.
 *
 * Ba thứ bắt buộc khi app gọi xuyên server (thiếu là hỏng, không phải tối ưu):
 *  1. heartbeat ": ping" — p95 độ trễ thật đo trên production là 36 s, max 121 s;
 *     không ping thì nginx/proxy cắt kết nối giữa chừng.
 *  2. header X-Accel-Buffering: no + nginx proxy_buffering off — nếu không,
 *     nginx gom buffer và client thấy "stream" chỉ khi đã xong.
 *  3. Huỷ khi client ngắt → AbortController → ChatRequest.signal, nếu không
 *     server vẫn đốt quota cho request client đã bỏ.
 */

const HEARTBEAT_MS = 15_000;

export interface SseStream {
  /** Gửi một chunk JSON (đã là object) dưới dạng dòng `data:`. */
  send(payload: unknown): void;
  /** Gửi comment SSE (không phải sự kiện) — dùng cho ping. */
  comment(text: string): void;
  done(): void;
  readonly closed: boolean;
  readonly signal: AbortSignal;
}

export function startSse(
  req: FastifyRequest,
  reply: FastifyReply,
  extraHeaders: Record<string, string> = {},
): SseStream {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx: không gom buffer, nếu không client không thấy delta theo thời gian thực
    "x-accel-buffering": "no",
    ...extraHeaders,
  });

  let closed = false;
  const ac = new AbortController();

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      raw.write(": ping\n\n");
    } catch {
      /* client đã đi */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    // Client ngắt → huỷ upstream ngay, đừng chạy tiếp cho một kết nối đã chết.
    if (!ac.signal.aborted) ac.abort();
  };
  raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  return {
    get closed() {
      return closed;
    },
    signal: ac.signal,
    send(payload: unknown) {
      if (closed) return;
      try {
        raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        onClose();
      }
    },
    comment(text: string) {
      if (closed) return;
      try {
        raw.write(`: ${text}\n\n`);
      } catch {
        onClose();
      }
    },
    done() {
      if (closed) return;
      try {
        raw.write("data: [DONE]\n\n");
      } catch {
        /* ignore */
      }
      closed = true;
      clearInterval(heartbeat);
      raw.end();
    },
  };
}

/**
 * Chunk chuẩn OpenAI. Phần mở rộng của PenAI luôn nằm ở khóa `penai` TRONG một
 * chunk hợp lệ (vẫn có `choices`) — không dùng `event:` riêng, vì bộ giải mã SSE
 * của SDK openai đọc mọi dòng `data:` rồi yield ra như chunk; một object thiếu
 * `choices` sẽ làm code client `chunk.choices[0].delta.content` nổ.
 */
export function chatChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string },
  opts: {
    finishReason?: string | null;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    penai?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: opts.finishReason ?? null,
      },
    ],
    ...(opts.usage ? { usage: opts.usage } : {}),
    ...(opts.penai ? { penai: opts.penai } : {}),
  };
}
