import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPENAI_DEFAULT_BASE_URL,
  OpenAICompatProvider,
} from "../src/openai-compat.js";
import { withRetry } from "../src/retry.js";
import { startMockLlm, type MockLlm } from "../src/mock-llm.js";
import type { StreamEvent } from "../src/types.js";

let mock: MockLlm;
let provider: OpenAICompatProvider;

const TIME_TOOL = {
  name: "current_time",
  description: "Lấy giờ hiện tại",
  parameters: { type: "object", properties: {} },
};

beforeAll(async () => {
  mock = await startMockLlm();
  provider = new OpenAICompatProvider("test", { baseURL: mock.url });
});

afterAll(async () => {
  await mock.close();
});

describe("openai-compat adapter (spec-providers)", () => {
  it("dùng endpoint OpenAI chính thức khi không truyền baseURL", () => {
    expect(OPENAI_DEFAULT_BASE_URL).toBe("https://api.openai.com/v1");
    expect(() => new OpenAICompatProvider("openai", { apiKey: "test" })).not.toThrow();
  });

  it("liệt kê model chat và bỏ model không dùng cho chat", async () => {
    await expect(provider.listModels()).resolves.toEqual([
      { slug: "mock-model", displayName: "mock-model", contextWindow: 0 },
    ]);
  });

  it("AC-1: round-trip tool call", async () => {
    const first = await provider.chat({
      model: "mock-model",
      messages: [{ role: "user", content: "mấy giờ rồi?" }],
      tools: [TIME_TOOL],
    });
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]!.name).toBe("current_time");

    const second = await provider.chat({
      model: "mock-model",
      messages: [
        { role: "user", content: "mấy giờ rồi?" },
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        {
          role: "tool",
          toolCallId: first.toolCalls[0]!.id,
          content: "2026-07-07T10:00:00Z",
        },
      ],
      tools: [TIME_TOOL],
    });
    expect(second.stopReason).toBe("end");
    expect(second.content).toContain("2026-07-07T10:00:00Z");
    expect(second.toolCalls).toHaveLength(0);
    expect(second.usage.inputTokens).toBeGreaterThan(0);
  });

  it("AC-4: streaming ghép đủ nội dung", async () => {
    const events: StreamEvent[] = [];
    for await (const ev of provider.chatStream({
      model: "mock-model",
      messages: [{ role: "user", content: "xin chào PenAI" }],
    })) {
      events.push(ev);
    }
    const deltas = events.filter((e) => e.type === "text_delta");
    const done = events.find((e) => e.type === "done");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(done).toBeDefined();
    expect(done!.type === "done" && done!.response.content).toBe(
      "Bạn nói: xin chào PenAI",
    );
    const joined = deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join("");
    expect(joined).toBe("Bạn nói: xin chào PenAI");
  });

  it("streaming tool call", async () => {
    const events: StreamEvent[] = [];
    for await (const ev of provider.chatStream({
      model: "mock-model",
      messages: [{ role: "user", content: "what time is it?" }],
      tools: [TIME_TOOL],
    })) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done");
    expect(done!.type === "done" && done!.response.stopReason).toBe("tool_use");
    expect(done!.type === "done" && done!.response.toolCalls[0]!.name).toBe(
      "current_time",
    );
  });
});

describe("retry (spec-providers)", () => {
  function flakyServer(
    statuses: number[],
  ): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
    let i = 0;
    const server: Server = createServer((_req, res) => {
      const status = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      if (status === 200) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            model: "m",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      } else {
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: `http ${status}` } }));
      }
    });
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          count: () => i,
          close: () =>
            new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
        });
      }),
    );
  }

  it("AC-2: 429 lần đầu → retry → thành công (đúng 2 request)", async () => {
    const srv = await flakyServer([429, 200]);
    try {
      const p = new OpenAICompatProvider("flaky", { baseURL: srv.url });
      const res = await p.chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.content).toBe("ok");
      expect(srv.count()).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("AC-3: 401 → throw ngay, KHÔNG retry (đúng 1 request)", async () => {
    const srv = await flakyServer([401, 200]);
    try {
      const p = new OpenAICompatProvider("bad-auth", { baseURL: srv.url });
      await expect(
        p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow();
      expect(srv.count()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("withRetry ném lỗi cuối cùng sau khi hết lượt", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          const err = new Error("boom") as Error & { status: number };
          err.status = 500;
          throw err;
        },
        { retries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3);
  });
});
