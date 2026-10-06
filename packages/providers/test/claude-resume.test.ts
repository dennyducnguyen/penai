import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeProvider, buildClaudePrompt } from "../src/claude-code/provider.js";
import type { ChatRequest, ProviderChatMessage, ToolDefinition } from "../src/types.js";

/**
 * CLI `claude` giả: ghi lại tham số + prompt của từng lượt gọi, trả lần lượt
 * các câu trả lời soạn sẵn. Cần chạy được file có shebang → bỏ qua trên Windows
 * (CI chạy Linux).
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const dir = process.env.FAKE_CLAUDE_DIR;
const finish = (prompt) => {
  const calls = fs.existsSync(dir + "/calls.json") ? JSON.parse(fs.readFileSync(dir + "/calls.json", "utf8")) : [];
  const responses = JSON.parse(fs.readFileSync(dir + "/responses.json", "utf8"));
  const r = responses[calls.length] || { result: '{"action":"reply","text":"hết kịch bản"}' };
  const resumeAt = args.indexOf("--resume");
  calls.push({ resume: resumeAt >= 0 ? args[resumeAt + 1] : null, fork: args.includes("--fork-session"), prompt });
  fs.writeFileSync(dir + "/calls.json", JSON.stringify(calls));
  if (r.raw) { process.stdout.write(r.raw + "\\n"); return; }
  process.stdout.write(JSON.stringify({ type: "result", is_error: !!r.is_error, result: r.result, session_id: r.session_id || "s" + calls.length, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
};
const first = args[1];
if (args[0] === "-p" && first !== undefined && !first.startsWith("--")) finish(first);
else { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => finish(s)); }
`;

const tools: ToolDefinition[] = [{ name: "kho", description: "Xem tồn kho", parameters: { type: "object", properties: {} } }];
const toolCall = '{"action":"tool_call","tool":"kho","args":{}}';
const reply = (text: string) => JSON.stringify({ action: "reply", text });

describe.skipIf(process.platform === "win32")("claude-code nối tiếp phiên (--resume)", () => {
  let dir: string;
  let provider: ClaudeCodeProvider;
  const calls = (): Array<{ resume: string | null; fork: boolean; prompt: string }> =>
    JSON.parse(readFileSync(path.join(dir, "calls.json"), "utf8"));
  const script = (responses: unknown[]) => writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "penai-fake-claude-"));
    const bin = path.join(dir, "claude");
    writeFileSync(bin, FAKE_CLI);
    chmodSync(bin, 0o755);
    process.env.FAKE_CLAUDE_DIR = dir;
    provider = new ClaudeCodeProvider("claude-code", {
      command: bin,
      scratchDir: path.join(dir, "scratch"),
      tokenFile: path.join(dir, "token"),
    });
  });
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const first: ChatRequest = {
    model: "sonnet",
    system: "Bạn là thủ kho.",
    tools,
    messages: [{ role: "user", content: "Báo cáo tồn kho hôm nay" }],
  };
  /** Request của vòng tool kế tiếp, dựng như agent loop: thêm lượt assistant + kết quả tool. */
  async function nextRound(prev: ChatRequest, result: string): Promise<ChatRequest> {
    const r = await provider.chat(prev);
    expect(r.stopReason).toBe("tool_use");
    const messages: ProviderChatMessage[] = [
      ...prev.messages,
      { role: "assistant", content: null, toolCalls: r.toolCalls },
      { role: "tool", toolCallId: r.toolCalls[0]!.id, content: result },
    ];
    return { ...prev, messages };
  }

  it("vòng tool sau nối tiếp phiên vòng trước và chỉ gửi phần mới", async () => {
    script([
      { result: toolCall, session_id: "phien-1" },
      { result: toolCall, session_id: "phien-2" },
      { result: reply("Xong") },
    ]);
    const round2 = await nextRound(first, "Kho A: 120 thùng");
    const round3 = await nextRound(round2, "Kho B: 45 thùng");
    const done = await provider.chat(round3);
    expect(done.content).toBe("Xong");

    const c = calls();
    expect(c.map((x) => x.resume)).toEqual([null, "phien-1", "phien-2"]);
    expect(c[1]!.fork).toBe(true);
    // Vòng 1 gửi cả lịch sử; các vòng sau chỉ gửi kết quả tool mới.
    expect(c[0]!.prompt).toContain("Báo cáo tồn kho hôm nay");
    expect(c[1]!.prompt).not.toContain("Báo cáo tồn kho hôm nay");
    expect(c[1]!.prompt).toContain('<tool_result tool="kho">\nKho A: 120 thùng');
    expect(c[2]!.prompt).not.toContain("Kho A");
    expect(c[2]!.prompt).toContain("Kho B: 45 thùng");
    expect(c[2]!.prompt).toContain("[YÊU CẦU]");
  });

  it("phiên không còn → gọi lại một lần với toàn bộ lịch sử", async () => {
    script([
      { result: toolCall, session_id: "phien-1" },
      { raw: "No conversation found with session ID: phien-1" },
      { result: reply("Vẫn trả lời được") },
    ]);
    const round2 = await nextRound(first, "Kho A: 120 thùng");
    const done = await provider.chat(round2);
    expect(done.content).toBe("Vẫn trả lời được");
    const c = calls();
    expect(c.map((x) => x.resume)).toEqual([null, "phien-1", null]);
    expect(c[2]!.prompt).toBe(buildClaudePrompt(round2));
  });

  it("lịch sử phía trước đã bị sửa hoặc đổi model → không nối tiếp", async () => {
    script([
      { result: toolCall, session_id: "phien-1" },
      { result: reply("A") },
      { result: toolCall, session_id: "phien-3" },
      { result: reply("B") },
    ]);
    const round2 = await nextRound(first, "Kho A: 120 thùng");
    const edited: ChatRequest = {
      ...round2,
      messages: [{ role: "user", content: "(lịch sử đã rút gọn)" }, ...round2.messages.slice(1)],
    };
    await provider.chat(edited);
    const other = await nextRound(first, "Kho A: 120 thùng");
    await provider.chat({ ...other, model: "haiku" });
    expect(calls().map((x) => x.resume)).toEqual([null, null, null, null]);
  });

  it("lượt phải sửa định dạng: sửa trên phiên gốc, vòng sau không nối tiếp từ bản nháp hỏng", async () => {
    script([
      { result: toolCall, session_id: "phien-1" },
      { result: "không phải JSON", session_id: "phien-hong" },
      { result: toolCall, session_id: "phien-sua" },
      { result: reply("Xong") },
    ]);
    const round2 = await nextRound(first, "Kho A: 120 thùng");
    const round3 = await nextRound(round2, "Kho B: 45 thùng");
    await provider.chat(round3);
    const c = calls();
    // Lượt sửa vẫn nối tiếp phiên-1 (phiên gốc không chứa bản nháp hỏng nhờ --fork-session);
    // vòng sau đó gọi mới vì phiên-sua có chứa yêu cầu sửa định dạng.
    expect(c.map((x) => x.resume)).toEqual([null, "phien-1", "phien-1", null]);
    expect(c[2]!.prompt).toContain("YÊU CẦU SỬA ĐỊNH DẠNG");
  });
});

describe("claude-code buildClaudePrompt (phần nối tiếp)", () => {
  it("fromIndex > 0: bỏ tiêu đề và message cũ, vẫn ghi đúng tên tool", () => {
    const p = buildClaudePrompt(
      {
        model: "sonnet",
        messages: [
          { role: "user", content: "Giá?" },
          { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "vault_search", args: {} }] },
          { role: "tool", toolCallId: "c1", content: "Khóa AI 6.5tr" },
        ],
      },
      2,
    );
    expect(p).not.toContain("LỊCH SỬ HỘI THOẠI");
    expect(p).not.toContain("Giá?");
    expect(p.startsWith('<tool_result tool="vault_search">')).toBe(true);
  });
});
