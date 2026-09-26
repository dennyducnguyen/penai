import { describe, expect, it } from "vitest";
import {
  extractEnvelope,
  parseJsonResult,
  serializePrompt,
} from "../src/antigravity/provider.js";
import type { ChatRequest } from "../src/types.js";

const baseReq: ChatRequest = {
  model: "gemini-3.7-flash-high",
  system: "Bạn là trợ lý bán hàng.",
  messages: [{ role: "user", content: "Giá bia Tiger?" }],
};

describe("antigravity serializePrompt", () => {
  it("gồm chỉ dẫn backend + system + lịch sử", () => {
    const p = serializePrompt(baseReq);
    expect(p).toContain("LLM backend");
    expect(p).toContain("Bạn là trợ lý bán hàng.");
    expect(p).toContain("<user>\nGiá bia Tiger?\n</user>");
    expect(p).not.toContain("[TOOLS NGOÀI");
  });

  it("có tools → mô tả tool + định dạng envelope", () => {
    const p = serializePrompt({
      ...baseReq,
      tools: [
        {
          name: "vault_search",
          description: "Tìm tài liệu",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });
    expect(p).toContain("[TOOLS NGOÀI");
    expect(p).toContain("vault_search");
    expect(p).toContain('"action":"tool_call"');
  });

  it("serialize tool call + tool result với tên tool đúng", () => {
    const p = serializePrompt({
      ...baseReq,
      messages: [
        { role: "user", content: "Giá?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "vault_search", args: { query: "giá" } }],
        },
        { role: "tool", toolCallId: "c1", content: "Tiger 405.000đ" },
      ],
    });
    expect(p).toContain('<assistant_tool_call tool="vault_search">');
    expect(p).toContain('<tool_result tool="vault_search">\nTiger 405.000đ');
  });
});

describe("antigravity parseJsonResult", () => {
  it("lấy JSON kết quả cuối, bỏ qua dòng rác", () => {
    const out = 'Fetching...\n{"foo":1}\n{"status":"SUCCESS","response":"ok","usage":{"input_tokens":5,"output_tokens":2}}\n';
    const r = parseJsonResult(out);
    expect(r?.status).toBe("SUCCESS");
    expect(r?.response).toBe("ok");
  });

  it("không có JSON hợp lệ → null", () => {
    expect(parseJsonResult("lỗi gì đó\nkhông json")).toBeNull();
  });
});

describe("antigravity extractEnvelope", () => {
  it("ưu tiên structured_output", () => {
    const env = extractEnvelope({
      status: "SUCCESS",
      response: "xxx",
      structured_output: { action: "tool_call", tool: "vault_search", args: { query: "giá" } },
    });
    expect(env?.action).toBe("tool_call");
    expect(env?.tool).toBe("vault_search");
  });

  it("fallback parse JSON trong response text", () => {
    const env = extractEnvelope({
      status: "SUCCESS",
      response: 'blah {"action":"reply","text":"chào bạn"} blah',
    });
    expect(env?.action).toBe("reply");
    expect(env?.text).toBe("chào bạn");
  });

  it("unwrap envelope thật bị model nhét vào text dạng chuỗi JSON", () => {
    const env = extractEnvelope({
      status: "SUCCESS",
      structured_output: {
        action: "reply",
        text: '{"action":"tool_call","tool":"vault_search","args":{"query":"giá Tiger"}}',
      },
    });
    expect(env?.action).toBe("tool_call");
    expect(env?.tool).toBe("vault_search");
  });

  it("text mở đầu bằng { nhưng không phải envelope → giữ nguyên reply", () => {
    const env = extractEnvelope({
      status: "SUCCESS",
      structured_output: { action: "reply", text: '{"gia": "405k"} là bảng giá' },
    });
    expect(env?.action).toBe("reply");
    expect(env?.text).toBe('{"gia": "405k"} là bảng giá');
  });
});
