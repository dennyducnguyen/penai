import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@penai/shared";
import { ClaudeCodeProvider } from "../src/claude-code/provider.js";
import { ClaudeOutputError, parseClaudeEnvelope } from "../src/claude-code/output.js";
import type { ChatRequest, StreamEvent } from "../src/types.js";

const toolName = "mcp__google__docs_append_text";
const toolNames = new Set([toolName]);
const validCall = JSON.stringify({ action: "tool_call", tool: toolName, args: { document_id: "real-copy-id", text: "MỤC TIÊU" } });
// Same failure shape as the production incident: model invents a result and another call.
const invalidTranscript = JSON.stringify({ action: "tool_call", tool: toolName, args: { document_id: "invented-id", text: "Thời lượng: 1 ngày" } })
  + '\n\ntool_result{"documentId":"invented-id","inserted":{"startIndex":92,"endIndex":253}}\n\n'
  + validCall;
const req: ChatRequest = {
  model: "opus",
  system: "Bạn là trợ lý đào tạo.",
  tools: [{ name: toolName, description: "Thêm nội dung tài liệu", parameters: { type: "object" } }],
  messages: [
    { role: "user", content: "Copy mẫu rồi sửa tài liệu." },
    { role: "assistant", content: null, toolCalls: [{ id: "copy-1", name: "mcp__google__drive_copy", args: { file_id: "source-id" } }] },
    { role: "tool", toolCallId: "copy-1", content: '{"id":"real-copy-id"}' },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "penai-claude-output-test-"));
  dirs.push(scratchDir);
  const provider = new ClaudeCodeProvider("claude-test", { scratchDir });
  // Stub only the CLI process boundary; exercise the real prompt, parser and retry loop.
  const run = vi.spyOn(provider as unknown as {
    run(args: string[], timeout: number, signal?: AbortSignal, stdin?: string): Promise<{ stdout: string; stderr: string; code: number }>;
  }, "run");
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});
  return { provider, run, warn };
}

function result(text: string, isError = false) {
  return { stdout: JSON.stringify({ type: "result", result: text, is_error: isError, usage: { input_tokens: 10, output_tokens: 5 } }), stderr: "", code: 0 };
}

describe("Claude output validation", () => {
  it("accepts one tool call, including a single enclosing JSON fence", () => {
    expect(parseClaudeEnvelope("```json\n" + validCall + "\n```", toolNames)).toMatchObject({ action: "tool_call", tool: toolName });
  });

  it.each([
    invalidTranscript,
    "Tôi sẽ làm ngay.\n" + validCall,
    validCall + "\n" + validCall,
    "null",
    "[]",
    '{"action":"tool_call","tool":"unknown","args":{}}',
    JSON.stringify({ action: "tool_call", tool: toolName, args: [] }),
    JSON.stringify({ action: "tool_call", tool: toolName, args: null }),
    JSON.stringify({ action: "tool_call", tool: toolName }),
    JSON.stringify({ action: "tool_call", tool: toolName, args: {}, text: "Đã xong" }),
    '{"action":"reply","text":23}',
    '{"action":"reply","text":"ok","tool_result":"fake"}',
    '{"action":"other","text":"ok"}',
    JSON.stringify({ action: "reply", text: invalidTranscript }),
  ])("rejects malformed/ambiguous output instead of forwarding it (%#)", (text) => {
    expect(() => parseClaudeEnvelope(text, toolNames)).toThrow(ClaudeOutputError);
  });

  it("unwraps a valid misplaced envelope without leaking it as reply text", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ action: "reply", text: validCall }), toolNames)).toMatchObject({ action: "tool_call" });
  });

  it("keeps ordinary JSON reply content and empty replies (file-only completion)", () => {
    for (const text of ['{"example":{"value":"x}\\\"y"}}', '{"example":{"action":"reply","text":"Hello"}}', ""]) {
      expect(parseClaudeEnvelope(JSON.stringify({ action: "reply", text }), toolNames)).toEqual({ action: "reply", text });
    }
  });
});

describe("Claude output repair", () => {
  it("returns a valid first tool response without retrying", async () => {
    const { provider, run } = harness();
    run.mockResolvedValueOnce(result(validCall));
    const response = await provider.chat(req);
    expect(response).toMatchObject({ content: null, stopReason: "tool_use", toolCalls: [{ name: toolName }] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("repairs the incident before emitting anything, retains real results and sums usage", async () => {
    const { provider, run, warn } = harness();
    run.mockResolvedValueOnce(result(invalidTranscript)).mockResolvedValueOnce(result(validCall));
    const before = structuredClone(req);
    const events: StreamEvent[] = [];
    for await (const event of provider.chatStream(req)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", response: {
      content: null, stopReason: "tool_use", usage: { inputTokens: 20, outputTokens: 10 },
      toolCalls: [{ name: toolName, args: { document_id: "real-copy-id" } }],
    } });
    expect(run).toHaveBeenCalledTimes(2);
    const retryPrompt = run.mock.calls[1]![0][1]!;
    expect(retryPrompt).toContain('<tool_result tool="mcp__google__drive_copy">\n{"id":"real-copy-id"}');
    expect(retryPrompt).toContain("KHÔNG được thực thi");
    expect(retryPrompt).toContain("Không làm lại công cụ đã thực thi thành công");
    expect(retryPrompt).toContain("không lấy ID tự sinh");
    expect(req).toEqual(before);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("invented-id");
  });

  it("allows a second repair and does not accumulate rejected drafts", async () => {
    const { provider, run } = harness();
    run.mockResolvedValueOnce(result(invalidTranscript))
      .mockResolvedValueOnce(result("bad-second-draft"))
      .mockResolvedValueOnce(result('{"action":"reply","text":"Đã đọc mẫu."}'));
    const response = await provider.chat(req);
    expect(response.content).toBe("Đã đọc mẫu.");
    expect(response.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
    const lastPrompt = run.mock.calls[2]![0][1]!;
    expect(lastPrompt).toContain("bad-second-draft");
    expect(lastPrompt).not.toContain("invented-id");
  });

  it("stops after two repairs with a safe error and no streamed output", async () => {
    const { provider, run } = harness();
    run.mockResolvedValue(result(invalidTranscript));
    const events: StreamEvent[] = [];
    await expect((async () => { for await (const event of provider.chatStream(req)) events.push(event); })())
      .rejects.toThrow("sau 2 lần yêu cầu sửa");
    expect(events).toEqual([]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("shares the original timeout budget across repairs", async () => {
    const { provider, run } = harness();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    run.mockImplementationOnce(async () => { now.mockReturnValue(41_000); return result(invalidTranscript); })
      .mockResolvedValueOnce(result(validCall));
    await provider.chat(req);
    expect(run.mock.calls.map((call) => call[1])).toEqual([300_000, 260_000]);
  });

  it("does not start another process when the original deadline is exhausted", async () => {
    const { provider, run } = harness();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    run.mockImplementationOnce(async () => { now.mockReturnValue(301_000); return result(invalidTranscript); });
    await expect(provider.chat(req)).rejects.toThrow("hết thời gian");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("respects cancellation before calling Claude and between repair attempts", async () => {
    const { provider, run } = harness();
    const before = new AbortController();
    before.abort();
    await expect(provider.chat({ ...req, signal: before.signal })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    const during = new AbortController();
    run.mockImplementationOnce(async () => { during.abort(); return result(invalidTranscript); });
    await expect(provider.chat({ ...req, signal: during.signal })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["Not logged in", "Rate limit exceeded"])("does not retry CLI/provider failures as format errors: %s", async (error) => {
    const { provider, run } = harness();
    run.mockResolvedValue(result(error, true));
    await expect(provider.chat(req)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps plain replies when no tools are enabled", async () => {
    const { provider, run } = harness();
    run.mockResolvedValue(result("Xin chào!"));
    const response = await provider.chat({ model: "opus", messages: req.messages });
    expect(response.content).toBe("Xin chào!");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
