import { createServer, type Server } from "node:http";

/**
 * Mock LLM server tương thích OpenAI Chat Completions — deterministic,
 * dùng cho test và chạy thử không cần API key thật.
 *
 * Kịch bản:
 * - Message cuối là tool result → trả text "Kết quả tool: <content>"
 * - User hỏi có chữ "giờ"/"time" và có tool current_time → yêu cầu gọi tool
 * - Còn lại → echo "Bạn nói: <nội dung>"
 * Hỗ trợ cả stream (SSE) lẫn non-stream.
 */
export interface MockLlm {
  url: string; // baseURL kiểu OpenAI: http://127.0.0.1:<port>/v1
  port: number;
  requestCount(): number;
  close(): Promise<void>;
}

interface IncomingMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ function: { name: string } }>;
}

let callSeq = 0;

function decide(body: {
  messages: IncomingMessage[];
  tools?: Array<{ function: { name: string } }>;
}):
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: string } {
  const last = body.messages[body.messages.length - 1];
  if (!last) return { kind: "text", text: "Xin chào!" };

  if (last.role === "tool") {
    return { kind: "text", text: `Kết quả tool: ${last.content ?? ""}` };
  }
  const text = (last.content ?? "").toLowerCase();
  const hasTimeTool = body.tools?.some(
    (t) => t.function.name === "current_time",
  );
  if (hasTimeTool && (text.includes("giờ") && !text.includes("kết quả") || text.includes("time"))) {
    callSeq += 1;
    return {
      kind: "tool",
      id: `call_${callSeq}`,
      name: "current_time",
      args: "{}",
    };
  }
  return { kind: "text", text: `Bạn nói: ${last.content ?? ""}` };
}

export async function startMockLlm(port = 0): Promise<MockLlm> {
  let count = 0;

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "mock-model", object: "model", created: 0, owned_by: "penai" },
            {
              id: "text-embedding-mock",
              object: "model",
              created: 0,
              owned_by: "penai",
            },
          ],
        }),
      );
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }
    count += 1;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        model: string;
        stream?: boolean;
        messages: IncomingMessage[];
        tools?: Array<{ function: { name: string } }>;
      };
      const decision = decide(body);
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

      if (!body.stream) {
        const message =
          decision.kind === "text"
            ? { role: "assistant", content: decision.text }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: decision.id,
                    type: "function",
                    function: { name: decision.name, arguments: decision.args },
                  },
                ],
              };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: body.model,
            choices: [
              {
                index: 0,
                message,
                finish_reason: decision.kind === "tool" ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }

      // SSE stream
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model };

      if (decision.kind === "text") {
        // chia 3 chunk để test streaming ghép nội dung
        const parts = splitInto(decision.text, 3);
        for (const p of parts) {
          send({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: decision.id,
                    type: "function",
                    function: { name: decision.name, arguments: decision.args },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      send({ ...base, choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/v1`,
    port: actualPort,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

function splitInto(text: string, n: number): string[] {
  if (text.length <= n) return [text];
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
