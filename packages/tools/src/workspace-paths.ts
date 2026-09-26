import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolContext } from "./registry.js";

/**
 * Mô hình thư mục (mỗi người dùng một không gian riêng):
 *
 *   .data/<workspace>/
 *     shared/            ← file dùng chung của agent (AGENT.md, tài liệu, template)
 *     users/<userKey>/   ← thư mục làm việc RIÊNG mỗi người dùng kênh (USER.md, file họ tạo)
 *
 * Quy ước path cho LLM:
 *   "bao-cao.docx"          → trong thư mục riêng của người dùng (mặc định, đọc + ghi)
 *   "shared/mau-thu.docx"   → file dùng chung của cả bộ phận (mọi agent đọc được)
 *   "thu-vien/mau-bg.docx"  → thư viện file RIÊNG của agent đang chạy (quản trị
 *                             viên tải lên; mặc định chỉ đọc, bật ghi trong cấu hình agent)
 *
 * Thư viện agent nằm NGOÀI thư mục workspace (`<dataDir>/thu-vien/<ws>/<agentId>`)
 * nên kể cả lượt chạy không có userKey (workDir = gốc workspace) cũng không đi
 * vòng sang thư viện của agent khác được.
 *
 * Không có workDir (chat qua HTTP/cron) thì workDir = gốc workspace như trước.
 */
export const SHARED_PREFIX = "shared/";
export const LIBRARY_PREFIX = "thu-vien/";

export interface ResolvedPath {
  /** Đường dẫn tuyệt đối đã kiểm tra an toàn. */
  abs: string;
  /** Có nằm trong vùng dùng chung không (ghi cần quyền rõ ràng). */
  shared: boolean;
  /** Có nằm trong thư viện file của agent không (ghi cần canWriteLibrary). */
  library: boolean;
  /** Dạng hiển thị lại cho LLM (giữ nguyên quy ước). */
  display: string;
}

/** So khớp đường dẫn — Windows không phân biệt hoa/thường. */
function samePathPrefix(base: string, target: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const b = norm(base);
  const t = norm(target);
  return t === b || t.startsWith(b + sep);
}

function jail(root: string, p: string, label: string): string {
  const base = resolve(root);
  const target = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (!samePathPrefix(base, target)) {
    throw new Error(`Từ chối: đường dẫn nằm ngoài ${label}`);
  }
  return target;
}

/**
 * Kiểm tra lần 2 sau khi đã resolve chuỗi: đi theo symlink thật (realpath)
 * rồi khẳng định vẫn nằm trong vùng cho phép. Chặn kiểu tấn công tạo symlink
 * trong thư mục làm việc trỏ ra ngoài (agent có thể tạo bằng exec `ln -s`).
 *
 * File chưa tồn tại thì kiểm tra thư mục cha gần nhất đang tồn tại.
 */
export async function assertRealPathInside(
  abs: string,
  roots: string[],
  label: string,
): Promise<void> {
  const realRoots: string[] = [];
  for (const r of roots) {
    realRoots.push(await realpath(resolve(r)).catch(() => resolve(r)));
  }
  let probe = abs;
  for (let i = 0; i < 40; i++) {
    try {
      const real = await realpath(probe);
      // phần đuôi chưa tồn tại được nối lại sau khi đã giải symlink phần tồn tại
      const rest = relative(probe, abs);
      const finalPath = rest ? resolve(real, rest) : real;
      if (!realRoots.some((root) => samePathPrefix(root, finalPath))) {
        throw new Error(`Từ chối: đường dẫn (qua symlink) nằm ngoài ${label}`);
      }
      return;
    } catch (err) {
      if ((err as Error).message?.startsWith("Từ chối")) throw err;
      const parent = dirname(probe);
      if (parent === probe) return; // tới gốc, không còn gì để kiểm tra
      probe = parent;
    }
  }
}

/** Thư mục làm việc hiện tại (riêng người dùng nếu có). */
export function workDirOf(toolCtx: ToolContext): string {
  return resolve(toolCtx.workDir ?? toolCtx.workspaceDataDir);
}

/** Thư mục dùng chung của agent (nếu chưa cấu hình thì nằm trong workspace). */
export function sharedDirOf(toolCtx: ToolContext): string {
  return resolve(toolCtx.sharedDir ?? resolve(toolCtx.workspaceDataDir, "shared"));
}

/** Thư viện file riêng của agent đang chạy (null = lượt chạy không gắn agent). */
export function libraryDirOf(toolCtx: ToolContext): string | null {
  return toolCtx.libraryDir ? resolve(toolCtx.libraryDir) : null;
}

/**
 * Giải một path do LLM đưa vào thành đường dẫn tuyệt đối an toàn.
 * Chặn traversal ra ngoài cả 3 vùng (riêng, chung, thư viện agent).
 */
export function resolveWorkPath(toolCtx: ToolContext, p: string): ResolvedPath {
  // chuẩn hóa "\" → "/" để "shared\x" không lách được tiền tố
  const raw = p.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const sharedRoot = sharedDirOf(toolCtx);
  const libRoot = libraryDirOf(toolCtx);

  if (raw.startsWith(SHARED_PREFIX) || raw === "shared") {
    const rest = raw === "shared" ? "." : raw.slice(SHARED_PREFIX.length);
    const abs = jail(sharedRoot, rest, "thư mục dùng chung");
    return { abs, shared: true, library: false, display: displayPath(toolCtx, abs) };
  }

  if (raw.startsWith(LIBRARY_PREFIX) || raw === "thu-vien") {
    if (!libRoot) {
      throw new Error("Từ chối: lượt chạy này không gắn với agent nào nên không có thư viện thu-vien/");
    }
    const rest = raw === "thu-vien" ? "." : raw.slice(LIBRARY_PREFIX.length);
    const abs = jail(libRoot, rest, "thư viện file của agent");
    return { abs, shared: false, library: true, display: displayPath(toolCtx, abs) };
  }

  // Đường dẫn tuyệt đối trỏ thẳng vào thư viện (vd agent chép từ lời nhắc dùng cho exec)
  if (libRoot && isAbsolute(raw) && samePathPrefix(libRoot, resolve(raw))) {
    const abs = resolve(raw);
    return { abs, shared: false, library: true, display: displayPath(toolCtx, abs) };
  }

  const abs = jail(workDirOf(toolCtx), raw, "thư mục làm việc");
  // Cờ shared phải suy ra từ đường dẫn ĐÃ resolve, không phải từ chuỗi gốc:
  // "x/../shared/AGENT.md" cũng phải bị coi là vùng dùng chung (khi workDir là
  // gốc workspace thì shared/ nằm bên trong nó).
  const shared = samePathPrefix(resolve(sharedRoot), abs);
  return { abs, shared, library: false, display: displayPath(toolCtx, abs) };
}

/**
 * Như resolveWorkPath nhưng có thêm bước kiểm tra symlink (bất đồng bộ).
 * Dùng cho MỌI tool đụng tới file thật.
 */
export async function resolveWorkPathChecked(
  toolCtx: ToolContext,
  p: string,
): Promise<ResolvedPath> {
  const res = resolveWorkPath(toolCtx, p);
  const libRoot = libraryDirOf(toolCtx);
  if (res.library && libRoot) {
    await assertRealPathInside(res.abs, [libRoot], "thư viện file của agent");
    return res;
  }
  await assertRealPathInside(
    res.abs,
    res.shared ? [sharedDirOf(toolCtx)] : [workDirOf(toolCtx)],
    res.shared ? "thư mục dùng chung" : "thư mục làm việc",
  );
  return res;
}

/**
 * Chặn ghi vào vùng chỉ đọc. shared/ chỉ ghi được khi canWriteShared; thư viện
 * agent chỉ ghi được khi quản trị viên bật "cho phép ghi" trong cấu hình agent.
 */
export function assertWritable(
  res: { shared: boolean; library?: boolean },
  toolCtx: ToolContext,
): void {
  if (res.shared && !toolCtx.canWriteShared) {
    throw new Error(
      "Từ chối: thư mục shared/ chỉ đọc. Ghi file vào thư mục làm việc riêng (bỏ tiền tố shared/).",
    );
  }
  if (res.library && !toolCtx.canWriteLibrary) {
    throw new Error(
      "Từ chối: thư viện thu-vien/ chỉ đọc. Muốn dựa trên file trong thư viện thì sao chép sang thư mục làm việc (bỏ tiền tố thu-vien/) rồi sửa bản sao.",
    );
  }
}

/**
 * Kiểm tra một đường dẫn tuyệt đối (do tool trả về qua marker [[media:...]])
 * có nằm trong vùng dữ liệu được phép gửi ra ngoài hay không.
 * Trả null nếu không hợp lệ — caller bỏ qua file đó.
 */
export async function confineMediaPath(
  abs: string,
  roots: string[],
): Promise<string | null> {
  try {
    const target = resolve(abs);
    if (!roots.some((r) => samePathPrefix(resolve(r), target))) return null;
    await assertRealPathInside(target, roots, "vùng dữ liệu");
    return target;
  } catch {
    return null;
  }
}

/** Đổi đường dẫn tuyệt đối về dạng hiển thị theo quy ước trên. */
export function displayPath(toolCtx: ToolContext, abs: string): string {
  const shared = sharedDirOf(toolCtx);
  const work = workDirOf(toolCtx);
  const lib = libraryDirOf(toolCtx);
  if (abs === shared || abs.startsWith(shared + sep)) {
    return SHARED_PREFIX + relative(shared, abs).replaceAll(sep, "/");
  }
  if (lib && (abs === lib || abs.startsWith(lib + sep))) {
    return (LIBRARY_PREFIX + relative(lib, abs).replaceAll(sep, "/")).replace(/\/$/, "");
  }
  if (abs === work || abs.startsWith(work + sep)) {
    return relative(work, abs).replaceAll(sep, "/") || ".";
  }
  return abs;
}

/** Tạo sẵn 2 thư mục (gọi khi dựng ngữ cảnh chạy). */
export async function ensureWorkDirs(workDir: string, sharedDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });
}
