import { describe, expect, it } from "vitest";
import {
  buildClaudePrompt,
  buildClaudeSystemPrompt,
  parseClaudeResult,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "../src/claude-code/provider.js";
import type { ChatRequest } from "../src/types.js";

const baseReq: ChatRequest = {
  model: "sonnet",
  system: "Bạn là trợ lý bán hàng của Công ty ABC.",
  messages: [{ role: "user", content: "Giá khóa học AI?" }],
};

describe("claude-code buildClaudeSystemPrompt", () => {
  it("không tools → chỉ system của agent", () => {
    const s = buildClaudeSystemPrompt(baseReq);
    expect(s).toContain("Bạn là trợ lý bán hàng của Công ty ABC.");
    expect(s).not.toContain("TOOLS");
  });

  it("có tools → mô tả tool + luật envelope trong system prompt", () => {
    const s = buildClaudeSystemPrompt({
      ...baseReq,
      tools: [
        {
          name: "vault_search",
          description: "Tìm tài liệu",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });
    expect(s).toContain("vault_search");
    expect(s).toContain('"action":"tool_call"');
  });

  it("system rỗng → có default", () => {
    const s = buildClaudeSystemPrompt({ ...baseReq, system: "" });
    expect(s).toContain("trợ lý AI hữu ích");
  });
});

describe("claude-code buildClaudePrompt", () => {
  it("serialize lịch sử + tool result đúng tên tool", () => {
    const p = buildClaudePrompt({
      ...baseReq,
      messages: [
        { role: "user", content: "Giá?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "vault_search", args: { query: "giá" } }],
        },
        { role: "tool", toolCallId: "c1", content: "Khóa AI 6.5tr" },
      ],
    });
    expect(p).toContain("<user>\nGiá?\n</user>");
    expect(p).toContain('<assistant_tool_call tool="vault_search">');
    expect(p).toContain('<tool_result tool="vault_search">\nKhóa AI 6.5tr');
    expect(p).toContain("[YÊU CẦU]");
  });
});

describe("claude-code parseClaudeResult", () => {
  it("lấy JSON type=result, bỏ dòng khác", () => {
    const out =
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"result","subtype":"success","is_error":false,"result":"Chào bạn","usage":{"input_tokens":10,"output_tokens":5},"num_turns":1}\n';
    const r = parseClaudeResult(out);
    expect(r?.result).toBe("Chào bạn");
    expect(r?.is_error).toBe(false);
    expect(r?.usage?.input_tokens).toBe(10);
  });

  it("nhận diện kết quả lỗi (is_error)", () => {
    const r = parseClaudeResult('{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}');
    expect(r?.is_error).toBe(true);
    expect(r?.result).toContain("Not logged in");
  });

  it("không có result → null", () => {
    expect(parseClaudeResult("rác\n{\"type\":\"system\"}")).toBeNull();
  });
});

describe("claude-code defaults", () => {
  it("model mặc định là sonnet", () => {
    expect(DEFAULT_CLAUDE_CODE_MODEL).toBe("sonnet");
  });
});
