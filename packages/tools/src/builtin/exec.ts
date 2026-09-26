import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolContext, ToolHandler } from "../registry.js";
import { libraryDirOf, sharedDirOf, workDirOf } from "../workspace-paths.js";
import { buildBwrapArgs, bwrapUsable, ensureSandboxDirs, execEnv } from "../exec-sandbox.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SHELL = process.platform === "win32" ? "bash" : "/bin/sh";

/**
 * Nhóm lệnh nguy hiểm — chặn cứng, không cho chạy dù có approval.
 * (Chặn theo nhóm lệnh nguy hiểm.)
 */
const DENY_GROUPS: Record<string, RegExp[]> = {
  destructive: [
    /\brm\s+-rf?\s+(?:--no-preserve-root\s+)?\/(?!\S)/,
    /\brm\s+-rf?\s+(?:~|\$HOME|\/\*)/,
    /\bmkfs\b/, /\bdd\s+if=.*of=\/dev\//, /\b(shred|wipe)\b/,
    /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/,
    /\bformat\s+[a-z]:/i, /\bdel\s+\/[sfq]\b/i, /\brmdir\s+\/s\b/i,
    />\s*\/dev\/sd[a-z]/,
  ],
  fork_bomb: [/:\(\)\s*\{.*\|\s*:.*\}\s*;/, /:\(\)\{:\|:&\};:/],
  reverse_shell: [
    /\bnc\b.{0,40}\b-e\b/, /\bncat\b.{0,40}--exec/, /bash\s+-i\s+>&\s*\/dev\/tcp\//,
    /\/dev\/(?:tcp|udp)\//, /\bsocat\b.{0,40}exec/,
  ],
  priv_esc: [/\bchmod\s+(?:-R\s+)?[0-7]*777\s+\//, /\bchown\s+-R\s+root/, /\busermod\b.{0,30}\bsudo\b/, /\bsudo\b/, /\bsu\s+-\b/],
  exfil: [/\bcurl\b.{0,80}\b(?:\/etc\/passwd|\/etc\/shadow|~\/\.ssh|\.aws\/credentials)/, /\bcat\b\s+(?:\/etc\/shadow|~\/\.ssh\/id_)/],
};
const HARD_DENY = Object.values(DENY_GROUPS).flat();

/**
 * Lệnh chạy tự do trong thư mục làm việc (không cần phê duyệt) — đủ để agent
 * làm việc thật: chạy python/node, cài thư viện, xử lý file, nén/giải nén.
 * Lệnh ngoài danh sách vẫn chạy được nhưng phải qua requestApproval.
 */
const AUTO_ALLOW = new Set([
  "python", "python3", "py", "pip", "pip3", "uv", "uvx",
  "node", "npm", "npx", "pnpm", "yarn", "tsx", "deno", "bun",
  "ls", "dir", "cat", "head", "tail", "wc", "grep", "rg", "find", "which",
  "echo", "printf", "pwd", "cd", "mkdir", "touch", "cp", "mv", "rm",
  "sed", "awk", "sort", "uniq", "cut", "tr", "diff", "tee", "xargs",
  "zip", "unzip", "tar", "gzip", "gunzip", "7z",
  "git", "curl", "wget", "jq", "ffmpeg", "convert", "magick",
  "libreoffice", "soffice", "pandoc", "chmod", "stat", "du", "df", "env", "date",
  "true", "false", "test", "sleep", "basename", "dirname", "realpath",
]);

/**
 * Tách các lệnh gốc trong chuỗi shell để kiểm tra allowlist.
 * Chỉ cắt tại toán tử NGOÀI dấu nháy và ngoài heredoc — nếu không, code
 * python/node truyền qua `-c "..."` hay `<<'PY' ... PY` sẽ bị hiểu nhầm
 * thành nhiều lệnh lạ.
 */
/**
 * Rút phần thân của command substitution: $(...), `...`, <(...), >(...).
 * Nội dung này ĐƯỢC shell thực thi nên phải kiểm tra allowlist như lệnh thường
 * (nếu bỏ qua thì `echo $(binary_la)` sẽ lách được allowlist).
 * Bỏ qua phần nằm trong nháy đơn — shell không diễn giải ở đó.
 */
function substitutionBodies(cmd: string): string[] {
  const bodies: string[] = [];
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (ch === "'" && inSingle) {
      inSingle = false;
      continue;
    }
    if (inSingle) continue;

    // $( ... ) hoặc <( ... ) hoặc >( ... ) — đếm ngoặc lồng nhau
    const opensParen =
      (ch === "$" || ch === "<" || ch === ">") && cmd[i + 1] === "(";
    if (opensParen) {
      let depth = 1;
      const start = i + 2;
      let j = start;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
      }
      const body = cmd.slice(start, Math.max(start, j - 1));
      if (body.trim()) bodies.push(body);
      i = j - 1;
      continue;
    }
    // `...`
    if (ch === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end > i) {
        const body = cmd.slice(i + 1, end);
        if (body.trim()) bodies.push(body);
        i = end;
      }
    }
  }
  return bodies;
}

export function commandHeads(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let heredocTag: string | null = null;

  const lines = cmd.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    // đang trong heredoc: bỏ qua tới dòng kết thúc
    if (heredocTag !== null) {
      if (line.trim() === heredocTag) heredocTag = null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === quote && line[i - 1] !== "\\") quote = null;
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      // mở heredoc: <<TAG hoặc <<'TAG' / <<"TAG" (kể cả <<-)
      if (ch === "<" && line[i + 1] === "<") {
        const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
        if (m) {
          heredocTag = m[2]!;
          i += m[0].length - 1;
          continue;
        }
      }
      // Chuyển hướng 2>&1, >&2, <&0, &> file KHÔNG phải ranh giới lệnh
      // (trước đây "cmd 2>&1" bị tách ra lệnh lạ "1" → phải xin duyệt vô lý).
      if (ch === "&" && (line[i - 1] === ">" || line[i - 1] === "<" || line[i + 1] === ">")) {
        cur += ch;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&") {
        segments.push(cur);
        cur = "";
        // nuốt toán tử đôi (&& || |&)
        if (line[i + 1] === ch || line[i + 1] === "&" || line[i + 1] === "|") i++;
        continue;
      }
      cur += ch;
    }
    // hết dòng = ranh giới lệnh (trừ khi nối dòng bằng \)
    if (!quote && !line.trimEnd().endsWith("\\")) {
      segments.push(cur);
      cur = "";
    } else {
      cur += "\n";
    }
  }
  segments.push(cur);

  const heads = segments
    .map((seg) => seg.trim())
    // bỏ chú thích: `echo hi # ghi chú` — phần sau # không chạy
    .map((seg) => (seg.startsWith("#") ? "" : seg.replace(/\s+#\s.*$/, "")))
    .filter(Boolean)
    .map((seg) => {
      // bỏ tiền tố gán biến môi trường: FOO=bar python x.py
      const parts = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      const head = (parts[0] ?? "").replace(/^[("'{]+/, "");
      return head.split(/[\\/]/).pop() ?? head;
    })
    .filter(Boolean);

  // lệnh bên trong $( ), ` `, <( ) cũng chạy thật → kiểm tra như lệnh thường
  for (const body of substitutionBodies(cmd)) {
    heads.push(...commandHeads(body));
  }
  return heads;
}

const schema = z.object({
  command: z.string().min(1).describe("Lệnh shell cần chạy."),
  reason: z.string().optional().describe("Lý do chạy lệnh (khi cần phê duyệt)."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Timeout riêng (mặc định 120s, tối đa 10 phút)."),
});

/**
 * Chọn cách chạy lệnh: trong sandbox bubblewrap (nếu runtime bật) hay trực
 * tiếp. Cả hai đường đều dùng env allowlist — không bao giờ kế thừa env server.
 */
export function planExec(toolCtx: ToolContext): {
  env: NodeJS.ProcessEnv;
  bwrap?: { path: string; args: string[] };
} {
  const sb = toolCtx.execSandbox;
  if (!sb || sb.mode === "off") return { env: execEnv() };
  const dirs = ensureSandboxDirs(sb.homeDir);
  const bwrapPath = sb.bwrapPath ?? "/usr/bin/bwrap";
  const usable = bwrapUsable(bwrapPath);
  if (!usable.ok) {
    if (sb.mode === "required") {
      throw new Error(
        `Chưa bật được vùng cô lập cho lệnh (bubblewrap: ${usable.reason}) — lệnh không được chạy. Báo quản trị viên.`,
      );
    }
    return { env: execEnv({ homeDir: dirs.homeDir }) };
  }
  const env = execEnv({ homeDir: dirs.homeDir, tmpDir: "/tmp" });
  const lib = libraryDirOf(toolCtx);
  const args = buildBwrapArgs({
    workDir: workDirOf(toolCtx),
    sharedDir: sharedDirOf(toolCtx),
    ...(lib ? { libraryDir: lib, libraryWritable: toolCtx.canWriteLibrary === true } : {}),
    homeDir: dirs.homeDir,
    tmpDir: dirs.tmpDir,
    ...(sb.extraRw ? { extraRw: sb.extraRw } : {}),
    ...(sb.extraRo ? { extraRo: sb.extraRo } : {}),
    pathEnv: env.PATH ?? "",
  });
  return { env, bwrap: { path: bwrapPath, args } };
}

/**
 * Chạy lệnh shell trong THƯ MỤC LÀM VIỆC RIÊNG của người dùng.
 * - HARD_DENY: chặn tuyệt đối (rm -rf /, reverse shell, sudo...).
 * - AUTO_ALLOW (python/node/git/zip...): chạy thẳng, không cần phê duyệt.
 * - Còn lại: cần requestApproval() trả true.
 */
export const execTool: ToolHandler<typeof schema> = {
  name: "exec",
  description:
    "Chạy lệnh shell trong thư mục làm việc riêng (python, node, pip/npm, git, zip, ffmpeg, pandoc... chạy trực tiếp). Dùng để tạo/chuyển đổi file, xử lý dữ liệu. Lệnh chạy trong vùng cô lập: chỉ thấy thư mục làm việc, file dùng chung/thư viện (chỉ đọc, theo đường dẫn tuyệt đối) và công cụ hệ thống.",
  schema,
  async execute(args, toolCtx) {
    const cmd = args.command.trim();
    for (const pat of HARD_DENY) {
      if (pat.test(cmd)) {
        throw new Error("Lệnh bị chặn (nằm trong danh sách nguy hiểm)");
      }
    }

    const heads = commandHeads(cmd);
    const needApproval = heads.some((h) => !AUTO_ALLOW.has(h));
    if (needApproval) {
      const approve = toolCtx.requestApproval;
      const allowed = approve
        ? await approve({
            tool: "exec",
            summary: cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd,
            ...(args.reason ? { detail: args.reason } : {}),
          })
        : false;
      if (!allowed) {
        const unknown = heads.filter((h) => !AUTO_ALLOW.has(h)).join(", ");
        throw new Error(
          `Lệnh "${unknown}" chưa được phê duyệt. Hãy dùng công cụ có sẵn (python, node, git, zip, pandoc...) hoặc xin người dùng duyệt.`,
        );
      }
    }

    const cwd = workDirOf(toolCtx);
    if (toolCtx.signal?.aborted) return "Đã hủy trước khi chạy lệnh";
    const plan = planExec(toolCtx);
    try {
      const common = {
        timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT * 4,
        windowsHide: true,
        env: plan.env,
        // /stop phải giết được lệnh đang chạy, không chờ hết timeout
        ...(toolCtx.signal ? { signal: toolCtx.signal } : {}),
      };
      const { stdout, stderr } = plan.bwrap
        ? await execFileAsync(plan.bwrap.path, [...plan.bwrap.args, "--", "/bin/sh", "-c", cmd], common)
        : await execAsync(cmd, { ...common, cwd, shell: SHELL });
      const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, MAX_OUTPUT);
      return out.trim() || "(lệnh chạy xong, không có output)";
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message: string;
        killed?: boolean;
        name?: string;
        code?: number | string;
      };
      if (toolCtx.signal?.aborted || e.name === "AbortError") return "Lệnh đã bị hủy";
      if (e.killed) return "Lệnh bị dừng vì quá thời gian chờ";
      // Trong sandbox, message của execFile chứa nguyên dòng lệnh bwrap rất dài —
      // chỉ báo mã thoát cho gọn (stdout/stderr đã đủ để agent hiểu lỗi).
      const tail = plan.bwrap ? `(mã thoát ${e.code ?? "?"})` : e.message;
      const combined = [e.stdout, e.stderr, tail]
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_OUTPUT);
      return `Lệnh lỗi:\n${combined}`;
    }
  },
};
