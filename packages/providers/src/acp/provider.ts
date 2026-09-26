import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
} from "../types.js";

/**
 * Provider ACP — chạy một CLI agent (vd Claude Code, Codex CLI, Gemini CLI)
 * như subprocess và giao tiếp bằng JSON-RPC 2.0 qua stdio (ndjson).
 *
 * config: { command, args } — lệnh khởi động CLI ở chế độ ACP.
 * Đây là bản tối giản: gửi 1 prompt, nhận text trả về. Streaming + tool bridge
 * đầy đủ để mở rộng sau (xem DEVIATIONS).
 */
export class AcpProvider implements Provider {
  constructor(
    readonly name: string,
    private cfg: { command: string; args?: string[] },
  ) {}

  private async rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(
        this.cfg.command,
        this.cfg.args ?? [],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error("ACP timeout"));
        }
      }, 120_000);

      child.stdout.on("data", (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
            if (msg.id === 1) {
              settled = true;
              clearTimeout(timer);
              child.kill();
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          } catch {
            // dòng không phải JSON-RPC (log) → bỏ qua
          }
        }
      });
      child.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });

      const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n";
      child.stdin.write(req);
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const prompt =
      (req.system ? req.system + "\n\n" : "") +
      (lastUser && lastUser.role === "user" ? lastUser.content : "");
    const result = (await this.rpc("prompt", { prompt })) as { text?: string } | string;
    const text = typeof result === "string" ? result : (result?.text ?? "");
    return {
      content: text || null,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(req);
    if (response.content) yield { type: "text_delta", text: response.content };
    yield { type: "done", response };
  }
}
