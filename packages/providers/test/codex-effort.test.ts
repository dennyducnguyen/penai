import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../src/index.js";
import { parseSupportedEfforts, pickSupportedEffort } from "../src/codex/reasoning.js";

// Nguyên văn lỗi thật từ ChatGPT ngày 26/09/2026 (agent gpt-6-luna để Thinking=minimal)
const GPT6_MINIMAL_ERROR = JSON.stringify(
  {
    error: {
      message:
        "Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.",
      type: "invalid_request_error",
      param: "reasoning.effort",
      code: "unsupported_value",
    },
  },
  null,
  2,
);

describe("parseSupportedEfforts", () => {
  it("đọc danh sách mức từ lỗi 400 thật của gpt-6", () => {
    expect(parseSupportedEfforts(GPT6_MINIMAL_ERROR)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("lỗi 400 khác (không phải reasoning.effort) → null", () => {
    expect(parseSupportedEfforts('{"error":{"message":"Invalid input","param":"input"}}')).toBeNull();
    expect(parseSupportedEfforts("")).toBeNull();
  });
});

describe("pickSupportedEffort", () => {
  const gpt6 = ["none", "low", "medium", "high", "xhigh", "max"];

  it("minimal → low (không tụt xuống none)", () => {
    expect(pickSupportedEffort("minimal", gpt6)).toBe("low");
  });

  it("mức model có sẵn thì giữ nguyên", () => {
    expect(pickSupportedEffort("high", gpt6)).toBe("high");
    expect(pickSupportedEffort("minimal", ["minimal", "low", "medium", "high"])).toBe("minimal");
  });

  it("không có mức nào cao hơn → lấy mức cao nhất model có", () => {
    expect(pickSupportedEffort("max", ["low", "medium", "high"])).toBe("high");
  });

  it("chưa biết danh sách → giữ nguyên", () => {
    expect(pickSupportedEffort("minimal", [])).toBe("minimal");
  });
});

describe("CodexProvider — tự đổi mức suy luận model không nhận", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseOk(text: string) {
    const enc = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: (async function* () {
        yield enc.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
        yield enc.encode(
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`,
        );
        yield enc.encode("data: [DONE]\n\n");
      })(),
    };
  }

  function bad400(text: string) {
    return { ok: false, status: 400, body: null, headers: new Headers(), text: async () => text };
  }

  async function providerWithOneAccount(): Promise<CodexProvider> {
    const dir = await mkdtemp(join(tmpdir(), "penai-codex-effort-"));
    const accountsDir = join(dir, "accounts");
    await mkdir(accountsDir, { recursive: true });
    await writeFile(
      join(accountsDir, "a1.json"),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        idToken: "id",
        accountId: "a1",
        email: "a1@x.com",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    return new CodexProvider("codex", { authFile: join(dir, "legacy.json"), accountsDir });
  }

  it("400 vì 'minimal' → gửi lại 1 lần với 'low'; các lần sau gửi thẳng 'low'", async () => {
    const p = await providerWithOneAccount();
    const sentEfforts: Array<string | undefined> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      const effort = (JSON.parse(init.body) as { reasoning?: { effort?: string } }).reasoning?.effort;
      sentEfforts.push(effort);
      return effort === "minimal" ? bad400(GPT6_MINIMAL_ERROR) : sseOk("chào anh");
    });

    const req = {
      model: "gpt-6-luna",
      messages: [{ role: "user" as const, content: "xin chào" }],
      reasoningEffort: "minimal" as const,
    };
    const first = await p.chat(req);
    expect(first.content).toBe("chào anh");
    expect(sentEfforts).toEqual(["minimal", "low"]);

    const second = await p.chat(req);
    expect(second.content).toBe("chào anh");
    expect(sentEfforts).toEqual(["minimal", "low", "low"]);
  });

  it("400 không phải do mức suy luận → báo lỗi ngay, không gửi lại", async () => {
    const p = await providerWithOneAccount();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return bad400('{"error":{"message":"Invalid input","param":"input"}}');
    });
    await expect(
      p.chat({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "hi" }],
        reasoningEffort: "low",
      }),
    ).rejects.toThrow(/Codex API lỗi 400/);
    expect(calls).toBe(1);
  });
});
