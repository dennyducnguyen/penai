import type { ChatUsage } from "@penai/providers";
import { runAgent, type AgentLoopDeps, type AgentRunInput } from "./agent-loop.js";

export interface RunTextResult {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  iterations: number;
  /** Token thực tế của lượt chạy — caller dùng để ghi trace/usage. */
  usage: ChatUsage;
  durationMs: number;
}

/**
 * Chạy agent tới khi xong, gom lại text cuối — dùng cho channel (Telegram...)
 * không stream ra trình duyệt. Tự nối các text_delta nếu provider stream.
 */
export async function runAgentText(
  deps: AgentLoopDeps,
  input: AgentRunInput,
): Promise<RunTextResult> {
  let streamed = "";
  let finalText = "";
  let iterations = 0;
  let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
  const started = Date.now();
  const toolCalls: RunTextResult["toolCalls"] = [];

  for await (const ev of runAgent(deps, input)) {
    if (ev.type === "text_delta") streamed += ev.text;
    else if (ev.type === "tool_call") toolCalls.push({ name: ev.name, args: ev.args });
    else if (ev.type === "done") {
      finalText = ev.finalText || streamed;
      iterations = ev.iterations;
      usage = ev.usage;
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  return { text: finalText, toolCalls, iterations, usage, durationMs: Date.now() - started };
}
