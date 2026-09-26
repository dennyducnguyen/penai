import { describe, expect, it } from "vitest";
import { FallbackProvider } from "../src/fallback.js";
import type { ChatRequest, ChatResponse, Provider, StreamEvent } from "../src/types.js";

function mkProvider(name: string, behavior: "ok" | "fail"): Provider {
  return {
    name,
    async chat(): Promise<ChatResponse> {
      if (behavior === "fail") throw new Error(name + " lỗi");
      return { content: "từ " + name, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *chatStream(): AsyncIterable<StreamEvent> {
      if (behavior === "fail") throw new Error(name + " lỗi");
      yield { type: "done", response: { content: "từ " + name, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } } };
    },
  };
}
const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

describe("FallbackProvider", () => {
  it("primary OK → dùng primary", async () => {
    const p = new FallbackProvider(mkProvider("primary", "ok"), [{ provider: mkProvider("fb", "ok"), model: "m2" }]);
    expect((await p.chat(req)).content).toBe("từ primary");
  });
  it("primary lỗi → fallback", async () => {
    const p = new FallbackProvider(mkProvider("primary", "fail"), [{ provider: mkProvider("fb", "ok"), model: "m2" }]);
    expect((await p.chat(req)).content).toBe("từ fb");
  });
  it("tất cả lỗi → throw", async () => {
    const p = new FallbackProvider(mkProvider("primary", "fail"), [{ provider: mkProvider("fb", "fail"), model: "m2" }]);
    await expect(p.chat(req)).rejects.toThrow();
  });
  it("stream fallback", async () => {
    const p = new FallbackProvider(mkProvider("primary", "fail"), [{ provider: mkProvider("fb", "ok"), model: "m2" }]);
    let done;
    for await (const ev of p.chatStream(req)) if (ev.type === "done") done = ev.response;
    expect(done!.content).toBe("từ fb");
  });
});
