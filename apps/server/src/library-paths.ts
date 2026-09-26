/**
 * Vị trí thư viện file của agent + HOME cô lập cho exec (26/09/2026).
 *
 *   <dataDir>/<ws>/shared/                    thư mục chung cả bộ phận (đã có từ trước)
 *   <dataDir>/thu-vien/<ws>/<agentId>/        thư viện RIÊNG từng agent (tiền tố "thu-vien/")
 *   <dataDir>/thu-vien/<ws>/.thung-rac/       thùng rác 30 ngày (ngoài mọi thư viện)
 *   <dataDir>/exec-home/<ws>/<agentId>/       HOME + /tmp của lệnh exec trong sandbox
 *
 * Thư viện nằm NGOÀI <dataDir>/<ws> nên lượt chạy không có userKey (workDir =
 * gốc workspace) cũng không đọc được thư viện của agent khác. Nằm trong dataDir
 * nên được script backup gom theo /var/lib/penai/data.
 */
import { resolve, join } from "node:path";
import type { ExecSandboxMode, ExecSandboxOptions } from "@penai/tools";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`id không hợp lệ: ${id}`);
  return id.toLowerCase();
}

export function libraryWorkspaceRoot(dataDir: string, workspaceId: string): string {
  return resolve(join(dataDir, "thu-vien", safeId(workspaceId)));
}

export function agentLibraryDir(dataDir: string, workspaceId: string, agentId: string): string {
  return resolve(join(libraryWorkspaceRoot(dataDir, workspaceId), safeId(agentId)));
}

export function libraryTrashRoot(dataDir: string, workspaceId: string): string {
  return resolve(join(libraryWorkspaceRoot(dataDir, workspaceId), ".thung-rac"));
}

export function sharedDirFor(dataDir: string, workspaceId: string): string {
  return resolve(join(dataDir, safeId(workspaceId), "shared"));
}

export function execHomeDir(dataDir: string, workspaceId: string, agentId?: string): string {
  return resolve(
    join(dataDir, "exec-home", safeId(workspaceId), agentId ? safeId(agentId) : "_chung"),
  );
}

/**
 * Cấu hình sandbox exec từ biến môi trường:
 *   PENAI_EXEC_SANDBOX   = off | auto | required  (mặc định: auto trên Linux, off nơi khác)
 *   PENAI_EXEC_EXTRA_RW  = thư mục thêm cho mọi lệnh, ghi được (phân tách bằng ":")
 *   PENAI_EXEC_EXTRA_RO  = như trên, chỉ đọc
 *   PENAI_BWRAP_PATH     = đường dẫn bwrap (mặc định /usr/bin/bwrap)
 */
export function execSandboxFor(
  dataDir: string,
  workspaceId: string,
  agentId?: string,
): ExecSandboxOptions {
  const raw = (process.env.PENAI_EXEC_SANDBOX ?? "").trim().toLowerCase();
  const mode: ExecSandboxMode =
    raw === "off" || raw === "auto" || raw === "required"
      ? raw
      : process.platform === "linux"
        ? "auto"
        : "off";
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(":")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("/"));
  const extraRw = list(process.env.PENAI_EXEC_EXTRA_RW);
  const extraRo = list(process.env.PENAI_EXEC_EXTRA_RO);
  return {
    mode,
    homeDir: execHomeDir(dataDir, workspaceId, agentId),
    ...(extraRw.length ? { extraRw } : {}),
    ...(extraRo.length ? { extraRo } : {}),
    ...(process.env.PENAI_BWRAP_PATH ? { bwrapPath: process.env.PENAI_BWRAP_PATH } : {}),
  };
}
