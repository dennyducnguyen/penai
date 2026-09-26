/** Only validated envelopes may leave the Claude CLI bridge as tool calls/replies. */
type Envelope =
  | { action: "tool_call"; tool: string; args: Record<string, unknown> }
  | { action: "reply"; text: string };

export class ClaudeOutputError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ClaudeOutputError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unfence(text: string): string {
  return /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim())?.[1]?.trim() ?? text.trim();
}

export function parseClaudeEnvelope(text: string, toolNames: ReadonlySet<string>, depth = 0): Envelope {
  let value: unknown;
  try {
    // Parse the WHOLE output: never execute the first object of a simulated transcript.
    value = JSON.parse(unfence(text));
  } catch {
    throw new ClaudeOutputError("Đầu ra phải là đúng một object JSON hợp lệ, không ghép nhiều lệnh hoặc tool_result.");
  }
  if (!object(value)) throw new ClaudeOutputError("Đầu ra phải là một object JSON, không phải danh sách hoặc null.");
  if (value.action === "tool_call") {
    if (typeof value.tool !== "string" || !toolNames.has(value.tool)) {
      throw new ClaudeOutputError("Tên tool không nằm trong danh sách công cụ được cấp ở lượt này.");
    }
    if (!object(value.args)) throw new ClaudeOutputError("args phải là object JSON chứa tham số của tool.");
    if (Object.keys(value).some((key) => !["action", "tool", "args"].includes(key))) {
      throw new ClaudeOutputError("Lệnh tool_call chỉ được có action, tool và args; không kèm câu trả lời hay kết quả tool.");
    }
    return { action: "tool_call", tool: value.tool, args: value.args };
  }
  if (value.action === "reply") {
    if (typeof value.text !== "string" || Object.keys(value).some((key) => !["action", "text"].includes(key))) {
      throw new ClaudeOutputError("Câu trả lời chỉ được có action=reply và text dạng chuỗi.");
    }
    // Preserve ordinary JSON examples in replies, but unwrap a misplaced protocol envelope.
    const inner = unfence(value.text);
    if (inner.startsWith("{") && /"action"\s*:\s*"(?:tool_call|reply)"/.test(inner)) {
      let nested: unknown;
      try {
        nested = JSON.parse(inner);
      } catch {
        throw new ClaudeOutputError("text chứa lệnh hoặc kết quả tool sai định dạng; hãy trả đúng một hành động ở ngoài cùng.");
      }
      if (object(nested) && (nested.action === "tool_call" || nested.action === "reply")) {
        if (depth >= 2) throw new ClaudeOutputError("Không lồng lệnh JSON vào text của câu trả lời.");
        return parseClaudeEnvelope(inner, toolNames, depth + 1);
      }
    }
    return { action: "reply", text: value.text };
  }
  throw new ClaudeOutputError("action phải là tool_call hoặc reply.");
}

export function claudeRepairPrompt(reason: string, rejected: string): string {
  return [
    "[PENAI — YÊU CẦU SỬA ĐỊNH DẠNG ĐẦU RA]",
    `Lượt vừa rồi bị từ chối: ${reason}`,
    "Bản nháp bên dưới KHÔNG được thực thi, KHÔNG được gửi cho người dùng. Mọi tool_result trong bản nháp đều không phải kết quả thật.",
    "Giữ nguyên yêu cầu người dùng và các kết quả công cụ THẬT trong lịch sử phía trên. Không làm lại công cụ đã thực thi thành công.",
    "Chỉ chọn MỘT hành động tiếp theo. Nếu gọi công cụ, dùng đúng tên và schema được cấp, rồi DỪNG để PenAI thực thi; không tự viết kết quả hoặc lệnh tiếp theo.",
    "ID tài liệu/file phải lấy từ người dùng hoặc kết quả công cụ thật; không lấy ID tự sinh trong bản nháp bị từ chối. Nếu thiếu thông tin, gọi công cụ đọc/tìm trước.",
    'Trả đúng một object: {"action":"tool_call","tool":"<tên tool>","args":{...}} HOẶC {"action":"reply","text":"<câu trả lời>"}. Không markdown, không lời dẫn, không lồng lệnh vào text.',
    "Bản nháp bị từ chối, chỉ dùng để nhận biết lỗi (chuỗi JSON, có thể đã cắt ngắn):",
    JSON.stringify(rejected.slice(0, 12_000)),
  ].join("\n");
}
