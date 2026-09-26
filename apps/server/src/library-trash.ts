/**
 * Thùng rác của thư viện file (26/09/2026) — dùng chung cho API Dashboard và cho
 * agent được bật quyền ghi (delete_file trong thu-vien/ cũng vào thùng rác).
 * Không import web-chat/agent-runtime để tránh vòng import.
 *
 *   <dataDir>/thu-vien/<ws>/.thung-rac/<scope>/<id>/{item, meta.json}
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { WorkspaceContext } from "@penai/shared";
import { libraryTrashRoot } from "./library-paths.js";

export const TRASH_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function dirSize(root: string, skipTop: string[] = []): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let budget = 50_000;
  const walk = async (dir: string, top: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      if (top && skipTop.includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, false);
      else if (e.isFile()) {
        const st = await stat(p).catch(() => null);
        if (st) {
          bytes += st.size;
          files++;
        }
      }
    }
  };
  await walk(root, true);
  return { bytes, files };
}

export interface TrashMeta {
  id: string;
  scope: string;
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  deletedAt: string;
  deletedBy: string;
  reason: string;
}

export function trashScopeDir(dataDir: string, workspaceId: string, scopeId: string): string {
  return join(libraryTrashRoot(dataDir, workspaceId), scopeId === "shared" ? "shared" : scopeId.toLowerCase());
}

export async function moveToTrash(
  dataDir: string,
  ctx: WorkspaceContext,
  scope: { id: string },
  rel: string,
  abs: string,
  reason: string,
): Promise<TrashMeta> {
  const st = await stat(abs);
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const dir = join(trashScopeDir(dataDir, ctx.workspaceId, scope.id), id);
  await mkdir(dir, { recursive: true });
  const size = st.isDirectory() ? (await dirSize(abs)).bytes : st.size;
  await rename(abs, join(dir, "item"));
  const meta: TrashMeta = {
    id,
    scope: scope.id,
    path: rel,
    name: basename(rel),
    type: st.isDirectory() ? "dir" : "file",
    size,
    deletedAt: new Date().toISOString(),
    deletedBy: ctx.userId,
    reason,
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  return meta;
}

export async function listTrash(dataDir: string, workspaceId: string, scopeId: string): Promise<TrashMeta[]> {
  const root = trashScopeDir(dataDir, workspaceId, scopeId);
  const out: TrashMeta[] = [];
  let ids: string[] = [];
  try {
    ids = await readdir(root);
  } catch {
    return out;
  }
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")) as TrashMeta;
      if (Date.parse(meta.deletedAt) < cutoff) {
        await rm(join(root, id), { recursive: true, force: true });
        continue;
      }
      out.push(meta);
    } catch {
      // mục hỏng — bỏ qua
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Dọn thùng rác quá hạn của mọi workspace (chạy định kỳ). */
export async function purgeExpiredTrash(dataDir: string): Promise<void> {
  const base = resolve(dataDir, "thu-vien");
  let wss: string[] = [];
  try {
    wss = await readdir(base);
  } catch {
    return;
  }
  for (const ws of wss) {
    if (!UUID_RE.test(ws)) continue;
    const trash = join(base, ws, ".thung-rac");
    let scopes: string[] = [];
    try {
      scopes = await readdir(trash);
    } catch {
      continue;
    }
    for (const sc of scopes) await listTrash(dataDir, ws, sc).catch(() => []);
  }
}
