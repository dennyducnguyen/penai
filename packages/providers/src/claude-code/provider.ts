import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { logger, type ToolCallData } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
  ToolDefinition,
} from "../types.js";
import { ClaudeOutputError, claudeRepairPrompt, parseClaudeEnvelope } from "./output.js";
import { resolveCliCommand } from "../cli-path.js";

/**
 * Provider dùng gói Claude (Pro/Max) qua Claude Code CLI headless
 * (spec-claude-code-provider.md — Phase 1).
 *
 * Ưu thế so với agy: `--system-prompt` THAY HẲN system prompt của CLI (agent
 * giữ đúng danh tính, không overhead), `--tools ""` tắt sạch tool built-in
 * (LLM thuần), token dài hạn chính thức qua `claude setup-token` →
 * env CLAUDE_CODE_OAUTH_TOKEN (lưu tokenFile, sống qua restart).
 * Tool calling PenAI: JSON envelope (nhét luật vào system prompt).
 */

export type ClaudeCodeAuthState = "unknown" | "ok" | "needs_login" | "awaiting_code";

interface ClaudeResult {
  type?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Nối tiếp phiên CLI giữa các vòng tool (`--resume`).
 *
 * Bridge này không trạng thái: mỗi vòng tool là một tiến trình `claude -p` mới.
 * Nếu vòng nào cũng gửi lại toàn bộ lịch sử trong MỘT khối prompt thì cache
 * prompt của Anthropic không bao giờ trúng (đo 06/10/2026, ngữ cảnh ~31k token:
 * mỗi vòng ghi mới 30,9k token vào cache, đọc lại 0). Nối tiếp đúng phiên của
 * vòng trước và chỉ gửi phần mới (kết quả tool) thì vòng sau ĐỌC 30,8k token
 * từ cache, chỉ ghi mới ~500 — nhanh hơn và tốn hạn mức gói ít hơn nhiều.
 *
 * Khoá tra cứu là id của tool call do chính provider này sinh ra (`cc_<uuid>`),
 * nên chỉ nối tiếp trong vòng lặp tool của một lượt trả lời. Mọi trường hợp
 * không chắc chắn (lịch sử đã bị cắt/sửa, đổi model, phiên không còn) đều quay
 * về cách gọi mới với toàn bộ lịch sử.
 */
interface ResumeEntry {
  sessionId: string;
  model: string;
  /** Số message của request đã sinh ra tool call này (= vị trí message assistant ở vòng sau). */
  prefixCount: number;
  prefixHash: string;
  at: number;
}

interface ResumePlan {
  sessionId: string;
  /** Chỉ gửi các message từ vị trí này trở đi. */
  fromIndex: number;
  callId: string;
}

const RESUME_MAX_ENTRIES = 300;
const RESUME_TTL_MS = 2 * 60 * 60 * 1000;

function hashMessages(messages: ChatRequest["messages"]): string {
  const h = createHash("sha1");
  for (const m of messages) {
    if (m.role === "user") h.update(`u\0${m.content}\0${m.images?.length ?? 0}\0`);
    else if (m.role === "assistant") {
      h.update(`a\0${m.content ?? ""}\0`);
      for (const tc of m.toolCalls ?? []) h.update(`${tc.id}\0${tc.name}\0${JSON.stringify(tc.args)}\0`);
    } else h.update(`t\0${m.toolCallId}\0${m.content}\0`);
  }
  return h.digest("hex");
}

/**
 * Model gói subscription — CLI không có lệnh liệt kê nên catalog tĩnh,
 * đã VERIFY từng ID chạy thật với tài khoản Max (31/08/2026).
 * Alias sonnet/opus/haiku/fable luôn trỏ bản mới nhất.
 */
const CLAUDE_MODELS = [
  { slug: "claude-sonnet-5", displayName: "Sonnet 5 (khuyến nghị — cân bằng)", contextWindow: 0 },
  { slug: "fable", displayName: "Fable 5 (mạnh nhất, tốn quota)", contextWindow: 0 },
  { slug: "claude-opus-5", displayName: "Opus 5", contextWindow: 0 },
  { slug: "claude-haiku-4-5", displayName: "Haiku 4.5 (nhanh/nhẹ)", contextWindow: 0 },
  { slug: "claude-opus-4-8", displayName: "Opus 4.8", contextWindow: 0 },
  { slug: "claude-opus-4-7", displayName: "Opus 4.7", contextWindow: 0 },
  { slug: "claude-opus-4-6", displayName: "Opus 4.6", contextWindow: 0 },
  { slug: "claude-sonnet-4-6", displayName: "Sonnet 4.6", contextWindow: 0 },
  { slug: "sonnet", displayName: "sonnet (alias — Sonnet mới nhất)", contextWindow: 0 },
  { slug: "opus", displayName: "opus (alias — Opus mới nhất)", contextWindow: 0 },
  { slug: "haiku", displayName: "haiku (alias — Haiku mới nhất)", contextWindow: 0 },
];

export const DEFAULT_CLAUDE_CODE_MODEL = "sonnet";

// Loại cả ký tự điều khiển (BEL, ESC...) — output qua PTY hay lẫn vào đuôi URL
const OAUTH_URL_RE = /https:\/\/[^\s\x00-\x1f"']*oauth[^\s\x00-\x1f"']*/i;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;
const NOT_LOGGED_IN_RE = /not logged in|\/login|invalid.*(api key|token)|authentication|OAuth token has expired/i;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeCodeProvider implements Provider {
  private scratchDir: string;
  private tokenFile: string;
  private authState: ClaudeCodeAuthState = "unknown";
  private loginChild: ReturnType<typeof spawn> | null = null;
  private loginBuffer = "";
  /** tool call id → phiên CLI đã sinh ra nó (xem ResumeEntry). */
  private resumeByCall = new Map<string, ResumeEntry>();

  constructor(
    readonly name: string,
    private cfg: { command?: string; scratchDir?: string; tokenFile?: string } = {},
  ) {
    this.scratchDir = cfg.scratchDir ?? path.join(os.tmpdir(), "penai-claude-scratch");
    mkdirSync(this.scratchDir, { recursive: true });
    this.tokenFile = cfg.tokenFile ?? path.join(this.scratchDir, "oauth-token");
    if (this.authState === "unknown") {
      this.authState = this.readToken() ? "ok" : "needs_login";
    }
  }

  private get command(): string {
    return this.cfg.command ?? "claude";
  }

  /** CLI `claude` đã có trên máy chưa (Dashboard báo "chưa cài CLI" thay vì lỗi spawn). */
  cliInstalled(): boolean {
    return resolveCliCommand(this.command) !== null;
  }

  private readToken(): string | null {
    try {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (existsSync(this.tokenFile)) {
        const t = readFileSync(this.tokenFile, "utf8").trim();
        if (t) return t;
      }
    } catch {
      /* thiếu quyền đọc token — coi như chưa đăng nhập */
    }
    return null;
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    const token = this.readToken();
    return {
      ...process.env,
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
      // CLI tự update nền làm binary đổi giữa chừng — tắt cho ổn định server
      DISABLE_AUTOUPDATER: "1",
    };
  }

  // ===== Auth =====

  status(): { state: ClaudeCodeAuthState } {
    // Không đốt quota để kiểm tra: có token coi là ok; chat lỗi auth hạ cờ
    // needs_login và cờ đó GIỮ NGUYÊN (token hết hạn vẫn nằm trên đĩa).
    if (this.authState === "unknown") {
      this.authState = this.readToken() ? "ok" : "needs_login";
    } else if (this.authState === "ok" && !this.readToken()) {
      this.authState = "needs_login";
    }
    return { state: this.authState };
  }

  /** Lưu token dán trực tiếp từ Dashboard (chạy `claude setup-token` ở máy khác rồi dán). */
  async setToken(token: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = token.trim();
    if (!TOKEN_RE.test(trimmed)) {
      return { ok: false, message: "Token không đúng định dạng (bắt đầu bằng sk-ant-…)" };
    }
    writeFileSync(this.tokenFile, trimmed + "\n", { mode: 0o600 });
    try {
      chmodSync(this.tokenFile, 0o600);
    } catch {
      /* Windows không hỗ trợ chmod POSIX */
    }
    // Xác minh bằng 1 call haiku tối thiểu (vài chục token quota)
    try {
      const r = await this.chat({
        model: "haiku",
        system: "Trả lời đúng 1 từ.",
        messages: [{ role: "user", content: "Nói: OK" }],
      });
      this.authState = "ok";
      return { ok: true, message: `Token hợp lệ — Claude trả lời: ${(r.content ?? "").slice(0, 40)}` };
    } catch (err) {
      this.authState = "needs_login";
      return { ok: false, message: `Token không dùng được: ${(err as Error).message}` };
    }
  }

  /**
   * Luồng Dashboard: spawn `claude setup-token` dưới PTY giả (Linux — CLI cần
   * TTY), bắt URL OAuth cho UI; user đăng nhập rồi dán code qua submitCode();
   * CLI in token → tự lưu tokenFile.
   */
  async startLogin(): Promise<{ url: string }> {
    if (this.loginChild) {
      this.loginChild.kill();
      this.loginChild = null;
    }
    this.loginBuffer = "";
    const child =
      process.platform === "win32"
        ? spawn(this.command, ["setup-token"], {
            cwd: this.scratchDir,
            env: this.spawnEnv(),
            windowsHide: true,
          })
        : spawn(
            "script",
            [
              "-qec",
              // stty cols 500: URL/token in trên MỘT dòng — không bị PTY wrap
              // 80 cột cắt giữa chuỗi làm regex trượt.
              `stty cols 500 rows 50 2>/dev/null; ${shellQuote(this.command)} setup-token`,
              "/dev/null",
            ],
            { cwd: this.scratchDir, env: { ...this.spawnEnv(), TERM: "xterm" } },
          );
    this.loginChild = child;
    child.on("exit", () => {
      if (this.loginChild === child) {
        this.loginChild = null;
        // CLI in token ra stdout khi hoàn tất — vớt và lưu
        const m = TOKEN_RE.exec(this.loginBuffer);
        if (m) {
          writeFileSync(this.tokenFile, m[0] + "\n", { mode: 0o600 });
          this.authState = "ok";
        } else if (this.authState === "awaiting_code") {
          this.authState = this.readToken() ? "ok" : "needs_login";
        }
      }
    });
    const onData = (chunk: Buffer) => {
      this.loginBuffer += chunk.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const url = await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const m = OAUTH_URL_RE.exec(this.loginBuffer);
        if (m) {
          clearInterval(timer);
          resolve(m[0]);
          return;
        }
        if (Date.now() - started > 25_000) {
          clearInterval(timer);
          child.kill();
          const tail = this.loginBuffer
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
            .slice(-300)
            .replace(/\s+/g, " ")
            .trim();
          reject(
            new Error(
              `claude setup-token không in URL đăng nhập trong 25s${tail ? ` (output: ${tail})` : ""} — có thể dán token trực tiếp thay thế`,
            ),
          );
        }
      }, 300);
      child.on("error", (err) => {
        clearInterval(timer);
        reject(new Error(`Không chạy được ${this.command}: ${err.message}`));
      });
    });
    this.authState = "awaiting_code";
    return { url };
  }

  /** Dán authorization code từ trình duyệt (luồng setup-token đang chờ). */
  async submitCode(code: string): Promise<{ ok: boolean; message: string }> {
    const child = this.loginChild;
    if (!child) {
      return {
        ok: false,
        message: "Không có phiên đăng nhập đang chờ — bấm Đăng nhập lại, hoặc dán token trực tiếp",
      };
    }
    const markBuffer = this.loginBuffer.length;
    // Gõ code và Enter TÁCH RỜI: Ink paste-detection gom chuỗi dài + \r liền kề
    // thành 1 sự kiện "paste" nên Enter không được tính là phím nhấn (đã tái
    // hiện: code ngắn ăn ngay, code thật 92 ký tự thì CLI đứng im).
    child.stdin?.write(code.trim());
    const enterTimers = [1500, 4000, 8000].map((ms) =>
      setTimeout(() => child.stdin?.write("\r"), ms),
    );
    // CLI không exit khi lỗi ("Press Enter to retry") — poll buffer tìm token
    // hoặc thông báo OAuth error thay vì chỉ chờ exit.
    const outcome = await new Promise<"token" | "oauth_error" | "timeout">((resolve) => {
      const timer = setInterval(() => {
        if (TOKEN_RE.test(this.loginBuffer)) {
          clearInterval(timer);
          resolve("token");
        } else if (/OAuth error/i.test(this.loginBuffer.slice(markBuffer))) {
          clearInterval(timer);
          resolve("oauth_error");
        }
      }, 500);
      setTimeout(() => {
        clearInterval(timer);
        resolve("timeout");
      }, 45_000);
      child.on("exit", () => {
        // exit handler ngoài đã vớt token nếu có; đợi 1 nhịp rồi kết luận
        setTimeout(() => {
          clearInterval(timer);
          resolve(TOKEN_RE.test(this.loginBuffer) ? "token" : "oauth_error");
        }, 300);
      });
    });
    for (const t of enterTimers) clearTimeout(t);
    if (outcome === "token") {
      const m = TOKEN_RE.exec(this.loginBuffer)!;
      writeFileSync(this.tokenFile, m[0] + "\n", { mode: 0o600 });
      this.authState = "ok";
      child.kill();
      this.loginChild = null;
      return { ok: true, message: "Đăng nhập thành công (đã lưu token)" };
    }
    child.kill();
    this.loginChild = null;
    if (outcome === "oauth_error") {
      const m = /OAuth error[^\r\n]*/i.exec(this.loginBuffer.slice(markBuffer));
      return {
        ok: false,
        message:
          `${m?.[0]?.trim() ?? "OAuth error"} — code bị từ chối (hết hạn hoặc đã dùng). ` +
          "Bấm Đăng nhập lại lấy URL MỚI, hoàn tất nhanh và chỉ dùng URL đó; hoặc dán token trực tiếp.",
      };
    }
    return { ok: false, message: "Đăng nhập không phản hồi sau 45s — thử lại hoặc dán token trực tiếp" };
  }

  // ===== Models =====

  async listModels(): Promise<Array<{ slug: string; displayName: string; contextWindow: number }>> {
    return CLAUDE_MODELS;
  }

  // ===== Chat =====

  /**
   * Linux giới hạn MỖI argument ~128KiB (MAX_ARG_STRLEN) — system prompt chứa
   * vault context toàn văn hoặc transcript dài sẽ làm spawn nổ E2BIG. Vượt
   * ngưỡng an toàn thì: system prompt → file tạm (--system-prompt-file),
   * prompt → stdin (claude -p không có prompt arg sẽ đọc stdin).
   */
  private static readonly ARG_SAFE_BYTES = 60_000;

  private buildArgs(
    req: ChatRequest,
    streaming: boolean,
    resume?: ResumePlan | null,
  ): { args: string[]; stdinData?: string; cleanup: () => void } {
    const model = req.model?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
    const prompt = buildClaudePrompt(req, resume?.fromIndex ?? 0);
    const systemPrompt = buildClaudeSystemPrompt(req);
    const tmpFiles: string[] = [];
    const args: string[] = ["-p"];
    let stdinData: string | undefined;
    if (Buffer.byteLength(prompt, "utf8") > ClaudeCodeProvider.ARG_SAFE_BYTES) {
      stdinData = prompt;
    } else {
      args.push(prompt);
    }
    args.push("--model", model, "--tools", "", "--max-turns", "3");
    // --fork-session: mỗi lượt ra một phiên MỚI, phiên gốc giữ nguyên — nên
    // lượt sửa định dạng (repair) vẫn bắt đầu lại từ lịch sử sạch.
    if (resume) args.push("--resume", resume.sessionId, "--fork-session");
    if (Buffer.byteLength(systemPrompt, "utf8") > ClaudeCodeProvider.ARG_SAFE_BYTES) {
      const file = path.join(this.scratchDir, `sysprompt-${randomUUID()}.txt`);
      writeFileSync(file, systemPrompt, "utf8");
      tmpFiles.push(file);
      args.push("--system-prompt-file", file);
    } else {
      args.push("--system-prompt", systemPrompt);
    }
    // Thinking level của agent → --effort (CLI tự bỏ qua với model không hỗ trợ)
    if (req.reasoningEffort) {
      args.push("--effort", req.reasoningEffort === "minimal" ? "low" : req.reasoningEffort);
    }
    if (streaming) {
      args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
    } else {
      args.push("--output-format", "json");
    }
    const cleanup = () => {
      for (const f of tmpFiles) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* best-effort */
        }
      }
    };
    return { args, ...(stdinData !== undefined ? { stdinData } : {}), cleanup };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const maxRepairs = 2;
    const deadline = Date.now() + 300_000;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let nextReq = req;
    let resume = this.planResume(req);
    for (let attempt = 0; ; ) {
      req.signal?.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Claude đã hết thời gian xử lý và sửa định dạng phản hồi. Vui lòng thử lại.");
      const built = this.buildArgs(nextReq, false, resume);
      let stdout: string, stderr: string, code: number | null;
      try {
        ({ stdout, stderr, code } = await this.run(built.args, remainingMs, req.signal, built.stdinData));
      } finally {
        built.cleanup();
      }
      req.signal?.throwIfAborted();
      const result = parseClaudeResult(stdout);
      if (resume && (!result || result.is_error)) {
        // Phiên không còn (CLI dọn, đổi máy...) hoặc lỗi bất kỳ khi nối tiếp →
        // gọi lại MỘT lần theo cách cũ với toàn bộ lịch sử. Lỗi thật (hết hạn
        // mức, chưa đăng nhập) sẽ lặp lại ở lượt đó và được báo như thường.
        logger.warn({ event: "claude.resume_failed", provider: this.name, model: req.model, exit: code }, "Không nối tiếp được phiên Claude — gọi lại với toàn bộ lịch sử");
        this.resumeByCall.delete(resume.callId);
        resume = null;
        continue;
      }
      if (!result) {
        const combined = (stderr + "\n" + stdout).slice(0, 400);
        throw new Error(this.authError(combined) ?? `claude không trả JSON hợp lệ (exit ${code}): ${combined}`);
      }
      if (result.is_error) {
        const msg = result.result || "claude trả lỗi không rõ";
        throw new Error(this.authError(msg) ?? `claude lỗi: ${msg}`);
      }
      this.authState = "ok";
      usage.inputTokens += result.usage?.input_tokens ?? 0;
      usage.outputTokens += result.usage?.output_tokens ?? 0;
      try {
        const response = this.toResponse(req, result);
        if (attempt > 0) logger.info({ event: "claude.output_repaired", provider: this.name, model: req.model, repairs: attempt }, "Claude đã sửa định dạng đầu ra");
        // Lượt đã phải sửa định dạng thì phiên CLI có chứa bản nháp bị từ chối —
        // không nối tiếp từ đó (bản nháp không bao giờ được thành lịch sử).
        if (attempt === 0) this.rememberSession(req, response, result);
        logger.debug(
          {
            event: "claude.usage",
            provider: this.name,
            model: req.model,
            resumed: !!resume,
            cacheRead: result.usage?.cache_read_input_tokens ?? 0,
            cacheCreate: result.usage?.cache_creation_input_tokens ?? 0,
          },
          "Claude: số liệu cache của lượt gọi",
        );
        return { ...response, usage };
      } catch (err) {
        if (!(err instanceof ClaudeOutputError)) throw err;
        // Log metadata only: rejected output can contain private document content.
        logger.warn({ event: "claude.output_invalid", provider: this.name, model: req.model, attempt: attempt + 1, willRetry: attempt < maxRepairs, reason: err.reason }, "Claude trả đầu ra sai định dạng");
        if (attempt >= maxRepairs) {
          throw new Error("Claude vẫn trả phản hồi sai định dạng sau 2 lần yêu cầu sửa. Bước tiếp theo chưa được thực thi; vui lòng thử lại.");
        }
        attempt++;
        // Start from the original history each time. Invalid output is a rejected
        // draft, never an assistant/tool event and never persisted to the session.
        nextReq = {
          ...req,
          messages: [...req.messages, { role: "user", content: claudeRepairPrompt(err.reason, result.result ?? "") }],
        };
      }
    }
  }

  /**
   * Request này có nối tiếp được phiên CLI của vòng trước không. Điều kiện:
   * message assistant CUỐI CÙNG là tool call do provider này sinh ra, phần lịch
   * sử trước nó còn y nguyên, cùng model, và phía sau chỉ có kết quả tool/tin
   * người dùng (không có lượt assistant nào mà phiên CLI chưa biết).
   */
  private planResume(req: ChatRequest): ResumePlan | null {
    const messages = req.messages;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        idx = i;
        break;
      }
    }
    if (idx < 0 || idx === messages.length - 1) return null;
    const last = messages[idx]!;
    if (last.role !== "assistant" || last.toolCalls?.length !== 1) return null;
    const callId = last.toolCalls[0]!.id;
    const entry = this.resumeByCall.get(callId);
    if (!entry) return null;
    const model = req.model?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
    if (
      Date.now() - entry.at > RESUME_TTL_MS ||
      entry.model !== model ||
      entry.prefixCount !== idx ||
      entry.prefixHash !== hashMessages(messages.slice(0, idx))
    ) {
      this.resumeByCall.delete(callId);
      return null;
    }
    return { sessionId: entry.sessionId, fromIndex: idx + 1, callId };
  }

  /** Ghi nhớ phiên CLI vừa sinh ra một tool call, để vòng sau nối tiếp. */
  private rememberSession(req: ChatRequest, response: ChatResponse, result: ClaudeResult): void {
    if (response.stopReason !== "tool_use" || response.toolCalls.length !== 1 || !result.session_id) return;
    this.resumeByCall.set(response.toolCalls[0]!.id, {
      sessionId: result.session_id,
      model: req.model?.trim() || DEFAULT_CLAUDE_CODE_MODEL,
      prefixCount: req.messages.length,
      prefixHash: hashMessages(req.messages),
      at: Date.now(),
    });
    // Map giữ thứ tự chèn → bỏ mục cũ nhất khi vượt trần.
    while (this.resumeByCall.size > RESUME_MAX_ENTRIES) {
      const oldest = this.resumeByCall.keys().next().value;
      if (oldest === undefined) break;
      this.resumeByCall.delete(oldest);
    }
  }

  private authError(text: string): string | null {
    if (NOT_LOGGED_IN_RE.test(text)) {
      this.authState = "needs_login";
      return "Claude Code chưa đăng nhập hoặc token hết hạn — vào trang Providers để đăng nhập/dán token mới";
    }
    return null;
  }

  private toResponse(req: ChatRequest, result: ClaudeResult): ChatResponse {
    const usage = {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    };
    const text = (result.result ?? "").trim();
    if (req.tools?.length) {
      const env = parseClaudeEnvelope(text, new Set(req.tools.map((tool) => tool.name)));
      if (env.action === "tool_call") {
        const call: ToolCallData = { id: `cc_${randomUUID()}`, name: env.tool, args: env.args };
        return { content: null, toolCalls: [call], stopReason: "tool_use", usage };
      }
      if (env.action === "reply") {
        return { content: env.text, toolCalls: [], stopReason: "end", usage };
      }
    }
    return { content: text || null, toolCalls: [], stopReason: "end", usage };
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    // Có tools → cần envelope JSON nguyên khối
    if (req.tools?.length) {
      const response = await this.chat(req);
      yield { type: "done", response };
      return;
    }
    const built = this.buildArgs(req, true);
    const child = spawn(this.command, built.args, {
      cwd: this.scratchDir,
      env: this.spawnEnv(),
      windowsHide: true,
      stdio: [built.stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (built.stdinData !== undefined && child.stdin) {
      child.stdin.write(built.stdinData);
      child.stdin.end();
    }
    const onAbort = () => child.kill();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const killTimer = setTimeout(() => child.kill(), 300_000);
    let buffer = "";
    let stderrBuf = "";
    let final: ChatResponse | null = null;
    let streamedText = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
    });
    try {
      const queue: string[] = [];
      let resolveWait: (() => void) | null = null;
      let ended = false;
      child.stdout?.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          queue.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
        resolveWait?.();
      });
      child.on("close", () => {
        ended = true;
        resolveWait?.();
      });
      while (true) {
        while (queue.length) {
          const line = queue.shift()!.trim();
          if (!line.startsWith("{")) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === "stream_event") {
            const inner = ev.event as
              | { type?: string; delta?: { type?: string; text?: string } }
              | undefined;
            if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
              streamedText += inner.delta.text;
              yield { type: "text_delta", text: inner.delta.text };
            }
          } else if (ev.type === "result") {
            const r = ev as ClaudeResult;
            if (r.is_error) {
              const msg = r.result || "claude trả lỗi không rõ";
              throw new Error(this.authError(msg) ?? `claude lỗi: ${msg}`);
            }
            final = this.toResponse(req, r);
          }
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        resolveWait = null;
      }
    } finally {
      clearTimeout(killTimer);
      req.signal?.removeEventListener("abort", onAbort);
      child.kill();
      built.cleanup();
    }
    if (!final) {
      const combined = (stderrBuf + "\n" + buffer).slice(0, 400);
      const authMsg = this.authError(combined);
      if (authMsg) throw new Error(authMsg);
      if (!streamedText) throw new Error(`claude stream không trả kết quả: ${combined}`);
      final = {
        content: streamedText,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    this.authState = "ok";
    yield { type: "done", response: final };
  }

  // ===== helpers =====

  private run(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: this.scratchDir,
        env: this.spawnEnv(),
        windowsHide: true,
        stdio: [stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (stdinData !== undefined && child.stdin) {
        child.stdin.write(stdinData);
        child.stdin.end();
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Không chạy được ${this.command}: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, code });
      });
    });
  }
}

/** Lấy JSON kết quả cuối (type:"result") từ stdout print mode. */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as ClaudeResult;
      if (parsed && typeof parsed === "object" && parsed.type === "result") return parsed;
    } catch {
      /* bỏ qua dòng không phải JSON */
    }
  }
  return null;
}

function describeTools(tools: ToolDefinition[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join("\n");
}

/**
 * System prompt: --system-prompt THAY HẲN prompt mặc định của CLI nên agent
 * giữ nguyên danh tính; luật envelope tool nhét vào đây (ổn định, cache tốt).
 */
export function buildClaudeSystemPrompt(req: ChatRequest): string {
  const parts: string[] = [req.system?.trim() || "Bạn là trợ lý AI hữu ích. Trả lời bằng ngôn ngữ người dùng dùng."];
  if (req.tools?.length) {
    parts.push(
      "",
      "[TOOLS — do hệ thống PenAI thực thi]",
      describeTools(req.tools),
      "",
      "Định dạng output BẮT BUỘC — trả về đúng MỘT object JSON, không markdown fence, không văn bản nào khác:",
      '- Cần gọi tool: {"action":"tool_call","tool":"<tên tool>","args":{...đúng schema...}}',
      '- Trả lời người dùng: {"action":"reply","text":"<câu trả lời hoàn chỉnh>"}',
      "Sau một tool_call phải DỪNG để PenAI thực thi. Không tự viết tool_result, không mô phỏng nhiều bước công cụ trong một đầu ra, không lồng lệnh vào text.",
      "Dùng ID tài liệu/file từ người dùng hoặc kết quả công cụ thật trong lịch sử; không tự tạo ID. Chỉ xác nhận hoàn thành khi có kết quả thực thi thật.",
    );
  }
  return parts.join("\n");
}

/**
 * Prompt -p: lịch sử hội thoại serialize (bridge stateless như antigravity).
 * fromIndex > 0 = nối tiếp phiên CLI (`--resume`): phiên đã có các message
 * trước đó nên chỉ serialize phần mới, không lặp lại tiêu đề lịch sử.
 */
export function buildClaudePrompt(req: ChatRequest, fromIndex = 0): string {
  const parts: string[] = fromIndex > 0 ? [] : ["[LỊCH SỬ HỘI THOẠI]"];
  const callNames = new Map<string, string>();
  for (const [i, m] of req.messages.entries()) {
    if (i < fromIndex) {
      // Vẫn cần tên tool của các lượt gọi trước để ghi nhãn tool_result.
      if (m.role === "assistant") for (const tc of m.toolCalls ?? []) callNames.set(tc.id, tc.name);
      continue;
    }
    if (m.role === "user") {
      const imgNote = m.images?.length ? ` (kèm ${m.images.length} ảnh — bản bridge chưa xem được ảnh)` : "";
      parts.push(`<user>${imgNote}\n${m.content}\n</user>`);
    } else if (m.role === "assistant") {
      if (m.content) parts.push(`<assistant>\n${m.content}\n</assistant>`);
      for (const tc of m.toolCalls ?? []) {
        callNames.set(tc.id, tc.name);
        parts.push(`<assistant_tool_call tool="${tc.name}">\n${JSON.stringify(tc.args)}\n</assistant_tool_call>`);
      }
    } else {
      const toolName = callNames.get(m.toolCallId) ?? "tool";
      parts.push(`<tool_result tool="${toolName}">\n${m.content}\n</tool_result>`);
    }
  }
  parts.push("", "[YÊU CẦU] Sinh lượt trả lời tiếp theo của assistant.");
  return parts.join("\n");
}
