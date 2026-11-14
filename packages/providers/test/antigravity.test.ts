import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AntigravityProvider,
  explainLoginError,
  extractEnvelope,
  normalizeAuthCode,
  parseJsonResult,
  plainTerminalText,
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

describe("antigravity checkAuth", () => {
  const unauth = {
    stdout: "Fetching available models...\n",
    stderr: "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
    code: 1,
  };
  const mk = () => {
    const p = new AntigravityProvider("antigravity");
    const run = vi.spyOn(p as unknown as { run: () => Promise<typeof unauth> }, "run").mockResolvedValue(unauth);
    return { p, run };
  };

  it("CLI báo chưa đăng nhập → needs_login và được cache (không chạy lại agy mỗi lần Dashboard hỏi)", async () => {
    const { p, run } = mk();
    expect(await p.checkAuth()).toBe("needs_login");
    expect(await p.checkAuth()).toBe("needs_login");
    expect(await p.checkAuth()).toBe("needs_login");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("nhiều lần kiểm tra cùng lúc chỉ chạy một tiến trình agy", async () => {
    const { p, run } = mk();
    const states = await Promise.all([p.checkAuth(true), p.checkAuth(true), p.checkAuth(true)]);
    expect(states).toEqual(["needs_login", "needs_login", "needs_login"]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("antigravity đăng nhập — hàm thuần", () => {
  it("normalizeAuthCode: nhận mã trần, mã lẫn khoảng trắng, hoặc nguyên link có ?code=", () => {
    expect(normalizeAuthCode("  4/0AUn6-abc_DEF \n")).toBe("4/0AUn6-abc_DEF");
    expect(normalizeAuthCode("4/0AUn6 -abc")).toBe("4/0AUn6-abc");
    expect(normalizeAuthCode("https://antigravity.google/oauth-callback?state=s&code=4%2F0AUn6-abc&scope=x")).toBe(
      "4/0AUn6-abc",
    );
  });

  it("plainTerminalText bỏ mã điều khiển terminal", () => {
    expect(plainTerminalText("\x1b[2J\x1b[1mSelect\x1b[0m login\r\n  method:\x1b]0;t\x07")).toBe("Select login method:");
  });

  it("explainLoginError: mã từ link cũ được giải thích rõ, không đưa lỗi thô", () => {
    const old = explainLoginError('token exchange failed: oauth2: "invalid_grant" "Invalid code verifier."');
    expect(old).toContain("link cũ");
    expect(old).toContain("Lấy link mới");
    expect(explainLoginError('token exchange failed: oauth2: "invalid_grant" "Bad Request"')).toContain("hết hạn");
  });
});

// Luồng đăng nhập thật qua PTY giả với một `agy` giả lập màn hình tương tác.
// Cần lệnh `script` (util-linux) — chỉ chạy trên Linux (CI).
describe.skipIf(process.platform !== "linux")("antigravity đăng nhập — luồng tương tác", () => {
  let home: string;
  let fake: string;
  const oldHome = process.env.HOME;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "penai-agy-login-"));
    process.env.HOME = home;
    fake = path.join(home, "fake-agy");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'TOK="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"',
        'if [ "$1" = "models" ]; then',
        "  if [ -f \"$TOK\" ]; then printf 'gemini-x\\tGemini X\n'; exit 0; fi",
        '  echo "Error: Please sign in to view available models." >&2; exit 1',
        "fi",
        "printf 'Welcome \\033[1mSelect login method:\\033[0m\\r\\n> 1. Google OAuth\\r\\n'",
        "read _choice",
        "printf 'If not:\\r\\nhttps://accounts.google.com/o/oauth2/auth?client_id=x&code_challenge=abc&state=s1\\r\\npaste the authorization code below:\\r\\n'",
        "read code",
        'if [ "$code" = "good-code" ]; then',
        '  mkdir -p "$(dirname "$TOK")"; echo t > "$TOK"; printf \'Signed in\\r\\n\'',
        "else",
        "  printf 'Got an error: token exchange failed: oauth2: \"invalid_grant\" \"Invalid code verifier.\" Press any key to go back.\\r\\n'",
        "fi",
        "sleep 60",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
  });

  afterAll(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("mã sai → báo rõ + phiên đóng; lấy link mới rồi dán mã đúng → đăng nhập thành công", async () => {
    const p = new AntigravityProvider("antigravity", { command: fake, scratchDir: path.join(home, "scratch") });
    const first = await p.startLogin();
    expect(first.url).toBe("https://accounts.google.com/o/oauth2/auth?client_id=x&code_challenge=abc&state=s1");
    expect(first.expiresInSec).toBeGreaterThan(200);
    expect(p.status().state).toBe("awaiting_code");

    const bad = await p.submitCode("ma-tu-link-cu");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("link cũ");
    expect(p.status().state).toBe("needs_login");
    // Phiên đã đóng: dán lại không ghi vào tiến trình cũ nữa
    expect((await p.submitCode("good-code")).message).toContain("hết hạn");

    await p.startLogin();
    const good = await p.submitCode(" good-code\n");
    expect(good).toEqual({ ok: true, message: "Đăng nhập thành công" });
    expect(p.status().state).toBe("ok");
    await expect(p.startLogin()).rejects.toThrow(/đã đăng nhập sẵn/);
  }, 40_000);
});
