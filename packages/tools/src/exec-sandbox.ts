import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { logger } from "@penai/shared";

/**
 * Cô lập tool exec (26/09/2026).
 *
 * Trước đây exec chạy thẳng bằng user `penai` với TOÀN BỘ biến môi trường của
 * server (có PENAI_MASTER_KEY, DATABASE_URL) và thấy mọi thứ user đó đọc được:
 * token ChatGPT/Claude/Antigravity trong /var/lib/penai, /etc/penai/penai.env,
 * thư mục riêng của người dùng khác, và cả file .env của website khác trên VPS.
 * Lọc env thôi chưa đủ: cùng uid thì `cat /proc/$PPID/environ` vẫn đọc được
 * env của tiến trình server.
 *
 * Giải pháp: bubblewrap (bwrap) dựng một cây thư mục TỐI THIỂU cho mỗi lệnh:
 *   - /usr, /etc (trừ /etc/penai), thư mục công cụ trong PATH (vd /opt/node24): chỉ đọc
 *   - thư mục làm việc của lượt chạy: ghi được
 *   - shared/ của bộ phận: chỉ đọc
 *   - thư viện file của agent: chỉ đọc (hoặc ghi nếu agent được bật quyền ghi)
 *   - HOME riêng từng agent (pip --user, cache, hồ sơ LibreOffice) + /tmp riêng
 *   - pid namespace riêng → không thấy tiến trình server, không đọc được /proc của nó
 * Mạng giữ nguyên (agent cần pip/curl/tải dữ liệu).
 */

export type ExecSandboxMode = "off" | "auto" | "required";

export interface ExecSandboxOptions {
  /** off = chạy trực tiếp; auto = dùng bwrap nếu chạy được; required = không có bwrap thì từ chối. */
  mode: ExecSandboxMode;
  /** HOME riêng của agent (ghi được, bền giữa các lần exec). */
  homeDir: string;
  /** Thư mục thêm cho mọi lệnh (vd /srv/tai-nguyen) — ghi được. */
  extraRw?: string[];
  /** Thư mục thêm cho mọi lệnh — chỉ đọc. */
  extraRo?: string[];
  /** Đường dẫn bwrap (mặc định /usr/bin/bwrap). */
  bwrapPath?: string;
}

export interface SandboxMounts {
  workDir: string;
  sharedDir?: string;
  libraryDir?: string;
  libraryWritable?: boolean;
  homeDir: string;
  tmpDir: string;
  extraRw?: string[];
  extraRo?: string[];
  /** PATH sẽ dùng trong sandbox — thư mục công cụ ngoài /usr được bind chỉ đọc. */
  pathEnv: string;
}

/** Thao tác đọc hệ thống file (tách ra để test thuần không cần máy Linux). */
export interface FsProbe {
  exists(p: string): boolean;
  /** Đích symlink (dạng readlink) hoặc null nếu không phải symlink. */
  symlinkTarget(p: string): string | null;
  realpath(p: string): string | null;
}

export const nodeFsProbe: FsProbe = {
  exists: (p) => existsSync(p),
  symlinkTarget: (p) => {
    try {
      return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
    } catch {
      return null;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  },
};

/** Thư mục trong /etc chứa bí mật của dịch vụ — luôn che. */
const HIDDEN_ETC = ["/etc/penai"];

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

/** Dựng tham số bwrap (thuần — không đụng tiến trình). Lệnh shell nối sau "--". */
export function buildBwrapArgs(m: SandboxMounts, probe: FsProbe = nodeFsProbe): string[] {
  const args: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
  ];
  // Hệ thống: chỉ đọc
  args.push("--ro-bind", "/usr", "/usr");
  for (const p of ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]) {
    const target = probe.symlinkTarget(p);
    if (target) args.push("--symlink", target, p);
    else if (probe.exists(p)) args.push("--ro-bind", p, p);
  }
  args.push("--ro-bind", "/etc", "/etc");
  for (const h of HIDDEN_ETC) if (probe.exists(h)) args.push("--tmpfs", h);
  // /etc/resolv.conf thường là symlink sang /run/... — bind thư mục đích để DNS chạy
  const rc = probe.realpath("/etc/resolv.conf");
  if (rc && !under(rc, "/etc") && !under(rc, "/usr")) {
    args.push("--ro-bind", dirname(rc), dirname(rc));
  }
  // Thư mục công cụ trong PATH nằm ngoài /usr (vd /opt/node24/bin → bind /opt/node24)
  const seen = new Set<string>();
  for (const entry of m.pathEnv.split(":")) {
    if (!entry || !isAbsolute(entry)) continue;
    if (under(entry, "/usr") || entry === "/bin" || entry === "/sbin") continue;
    if (under(entry, m.homeDir)) continue; // HOME riêng bind ở dưới
    const dir = /\/s?bin$/.test(entry) ? dirname(entry) : entry;
    if (seen.has(dir) || !probe.exists(dir)) continue;
    seen.add(dir);
    args.push("--ro-bind", dir, dir);
  }
  args.push("--ro-bind-try", "/sys", "/sys");
  args.push("--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig");
  args.push("--dev", "/dev", "--proc", "/proc");
  args.push("--tmpfs", "/var/tmp", "--tmpfs", "/run/user");
  // Vùng ghi được
  args.push("--bind", m.tmpDir, "/tmp");
  args.push("--bind", m.homeDir, m.homeDir);
  for (const p of m.extraRo ?? []) args.push("--ro-bind-try", p, p);
  for (const p of m.extraRw ?? []) args.push("--bind-try", p, p);
  args.push("--bind", m.workDir, m.workDir);
  // shared/ bind SAU workDir: lượt chạy không có userKey có workDir = gốc
  // workspace chứa shared/ bên trong → lớp chỉ đọc phải đè lên.
  if (m.sharedDir && probe.exists(m.sharedDir)) args.push("--ro-bind", m.sharedDir, m.sharedDir);
  if (m.libraryDir && probe.exists(m.libraryDir)) {
    args.push(m.libraryWritable ? "--bind" : "--ro-bind", m.libraryDir, m.libraryDir);
  }
  args.push("--remount-ro", "/");
  args.push("--chdir", m.workDir);
  return args;
}

/** Biến môi trường có dấu hiệu là bí mật — không bao giờ đưa cho tiến trình con. */
const SECRET_ENV_RE =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|DATABASE_URL|^PG[A-Z]*$|^PENAI_|^npm_config_|^pnpm_config_)/i;

/** Bỏ biến bí mật khỏi env (dùng cho custom tool — giữ nguyên phần còn lại). */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Biến hệ thống Windows cần để bash/python chạy được khi dev trên máy Windows. */
const WIN_KEEP = [
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "COMSPEC", "ComSpec", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "HOMEDRIVE", "HOMEPATH",
];

/**
 * Env cho lệnh exec: ALLOWLIST (không kế thừa env server). HOME trỏ vào HOME
 * riêng của agent nếu có.
 */
export function execEnv(opts: { homeDir?: string; tmpDir?: string } = {}): NodeJS.ProcessEnv {
  const src = process.env;
  const env: NodeJS.ProcessEnv = {};
  const keep = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME"];
  if (process.platform === "win32") keep.push(...WIN_KEEP, "Path", "HOME");
  for (const k of keep) {
    const v = src[k];
    if (v !== undefined && !SECRET_ENV_RE.test(k)) env[k] = v;
  }
  env.PATH ??= src["Path"] ?? "/usr/local/bin:/usr/bin:/bin";
  env.LANG ??= "C.UTF-8";
  env.PYTHONIOENCODING = "utf-8";
  if (opts.homeDir) {
    env.HOME = opts.homeDir;
    // pip install --user / npm -g prefix trong HOME riêng → gọi được script cài thêm
    if (process.platform !== "win32") env.PATH = `${env.PATH}${delimiter}${opts.homeDir}/.local/bin`;
  }
  if (opts.tmpDir) env.TMPDIR = opts.tmpDir;
  return env;
}

let bwrapCheck: { path: string; ok: boolean; reason?: string } | null = null;

/** Kiểm tra (1 lần/tiến trình) bwrap có chạy được trong môi trường hiện tại không. */
export function bwrapUsable(bwrapPath = "/usr/bin/bwrap"): { ok: boolean; reason?: string } {
  if (bwrapCheck && bwrapCheck.path === bwrapPath) return bwrapCheck;
  let res: { ok: boolean; reason?: string };
  if (process.platform !== "linux") res = { ok: false, reason: "không phải Linux" };
  else if (!existsSync(bwrapPath)) res = { ok: false, reason: `không thấy ${bwrapPath} (cài gói bubblewrap)` };
  else {
    const probeArgs = [
      "--die-with-parent", "--unshare-pid",
      "--ro-bind", "/usr", "/usr",
      ...["/bin", "/lib", "/lib64"].flatMap((p) => {
        const t = nodeFsProbe.symlinkTarget(p);
        return t ? ["--symlink", t, p] : existsSync(p) ? ["--ro-bind", p, p] : [];
      }),
      "--proc", "/proc", "--dev", "/dev",
      "/bin/sh", "-c", "exit 0",
    ];
    const r = spawnSync(bwrapPath, probeArgs, { timeout: 10_000, encoding: "utf8" });
    res = r.status === 0
      ? { ok: true }
      : { ok: false, reason: (r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 300) };
  }
  bwrapCheck = { path: bwrapPath, ...res };
  if (!res.ok) logger.warn(`exec sandbox: bubblewrap không dùng được — ${res.reason}`);
  return res;
}

/** Chỉ dùng trong test: xóa kết quả kiểm tra đã cache. */
export function resetBwrapCheckForTests(): void {
  bwrapCheck = null;
}

/** Tạo HOME + /tmp riêng cho sandbox (idempotent). */
export function ensureSandboxDirs(homeDir: string): { homeDir: string; tmpDir: string } {
  const home = resolve(homeDir);
  const tmp = resolve(home, ".sandbox-tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { homeDir: home, tmpDir: tmp };
}
