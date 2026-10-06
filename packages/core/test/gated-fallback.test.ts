import { describe, expect, it } from "vitest";
import { FallbackProvider } from "@penai/providers";
import type { ChatRequest, ChatResponse, Provider, StreamEvent } from "@penai/providers";
import { ProviderGate } from "../src/provider-gate.js";
import { gatedProvider } from "../src/gated-provider.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

function mk(name: string, ms: number, calls: string[]): Provider {
  const response = (): ChatResponse => ({
    content: "từ " + name,
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  return {
    name,
    async chat(r: ChatRequest): Promise<ChatResponse> {
      calls.push(`${name}:${r.model}`);
      await sleep(ms);
      return response();
    },
    async *chatStream(): AsyncIterable<StreamEvent> {
      await sleep(ms);
      yield { type: "done", response: response() };
    },
  };
}

/** Ghép chuỗi đúng như buildLoopDeps: bọc trần TỪNG chặng rồi mới ghép dự phòng. */
function chain(gate: ProviderGate, calls: string[], claudeMs: number): Provider {
  return new FallbackProvider(gatedProvider(gate, mk("claude-code", claudeMs, calls), { providerKey: "claude-code" }), [
    { provider: gatedProvider(gate, mk("codex", 5, calls), { providerKey: "codex" }), model: "gpt" },
  ]);
}

describe("Dự phòng + trần đồng thời theo từng chặng", () => {
  it("chặng chính chờ quá hạn → chuyển chặng dự phòng thay vì báo lỗi", async () => {
    const gate = new ProviderGate({ concurrency: { "claude-code": 1, codex: 4 }, waitMs: 1000 });
    const calls: string[] = [];
    const busy = chain(gate, calls, 1500).chat(req); // chiếm chỗ duy nhất của Claude
    await sleep(20);
    const second = await chain(gate, calls, 1500).chat(req);
    expect(second.content).toBe("từ codex");
    expect(calls).toEqual(["claude-code:m", "codex:gpt"]);
    expect((await busy).content).toBe("từ claude-code");
  });

  it("lượt chạy ở chặng dự phòng không chiếm chỗ của chặng chính", async () => {
    const gate = new ProviderGate({ concurrency: { "claude-code": 1, codex: 4 } });
    const calls: string[] = [];
    const failing: Provider = {
      name: "claude-code",
      async chat(): Promise<ChatResponse> {
        throw new Error("out of extra usage");
      },
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncIterable<StreamEvent> {
        throw new Error("out of extra usage");
      },
    };
    const p = new FallbackProvider(gatedProvider(gate, failing, { providerKey: "claude-code" }), [
      { provider: gatedProvider(gate, mk("codex", 60, calls), { providerKey: "codex" }), model: "gpt" },
    ]);
    const running = p.chat(req);
    await sleep(20);
    const stats = gate.stats();
    expect(stats["claude-code"]?.running).toBe(0);
    expect(stats.codex?.running).toBe(1);
    expect((await running).content).toBe("từ codex");
  });

  it("người dùng huỷ lúc đang chờ → không chạy chặng dự phòng", async () => {
    const gate = new ProviderGate({ concurrency: { "claude-code": 1, codex: 4 }, waitMs: 5000 });
    const calls: string[] = [];
    const busy = chain(gate, calls, 200).chat(req);
    await sleep(20);
    const ac = new AbortController();
    const waiting = chain(gate, calls, 200).chat({ ...req, signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toThrow();
    await busy;
    expect(calls).toEqual(["claude-code:m"]);
  });
});
