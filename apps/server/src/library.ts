/**
 * Thư viện file của agent — API cho Dashboard → "Thư viện file" (26/09/2026).
 *
 * Hai loại phạm vi (scope):
 *   - "shared"   : thư mục chung cả bộ phận (<dataDir>/<ws>/shared) — MỌI agent đọc được.
 *                  Riêng shared/skills/ do hệ thống Skill quản lý → chỉ xem.
 *   - <agentId>  : thư viện riêng của 1 agent (<dataDir>/thu-vien/<ws>/<agentId>) —
 *                  agent thấy qua tiền tố "thu-vien/", mặc định chỉ đọc.
 *
 * Quyền: operator trở lên (member bị allowlist web-auth chặn từ trước). Bật/tắt
 * quyền GHI của agent là thiết lập của agent → PATCH /v1/agents/:id (ws_admin).
 *
 * An toàn: mọi đường dẫn đi qua cleanRel (không "..", không NUL) + jail theo gốc
 * scope + realpath (chống symlink). Tên file/thư mục chuẩn hóa không dấu để agent
 * gõ đường dẫn chính xác. Xóa = chuyển vào thùng rác 30 ngày; ghi đè = bản cũ
 * vào thùng rác. Mọi thay đổi ghi audit_log (action "library.*").
 */
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasRole, logger, type WorkspaceContext } from "@penai/shared";
import { getAgentById, listAgents, recordAudit, type Db } from "@penai/db";
import AdmZip from "adm-zip";
import { assertRealPathInside, extractDocumentText } from "@penai/tools";
import { agentLibraryDir, libraryWorkspaceRoot, sharedDirFor } from "./library-paths.js";
import {
  dirSize,
  listTrash,
  moveToTrash,
  purgeExpiredTrash,
  trashScopeDir,
  TRASH_DAYS,
  type TrashMeta,
} from "./library-trash.js";
import { resolveDownload, sendDownload, webDirs } from "./web-chat.js";

const MB = 1024 * 1024;
/** File văn bản xem/sửa trên web tối đa 2 MB. */
const TEXT_MAX_BYTES = 2 * MB;
const ZIP_MAX_ENTRIES = 2000;
const ZIP_MAX_BYTES = 500 * MB;
const TEXT_EXT = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "log", "xml", "html", "htm", "css", "js", "ts", "py", "sql", "sh", "ini", "toml"]);
const PREVIEW_EXT = new Set(["pdf", "docx", "xlsx", "xls", "pptx"]);
const extOfName = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
export const isTextName = (name: string) => TEXT_EXT.has(extOfName(name));
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function libraryLimits(): { maxFileBytes: number; quotaBytes: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxFileBytes: Math.round(num(process.env.PENAI_LIBRARY_MAX_FILE_MB, 25) * MB),
    quotaBytes: Math.round(num(process.env.PENAI_LIBRARY_QUOTA_MB, 2048) * MB),
  };
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ===== Đường dẫn & tên =====

/** Chuẩn hóa đường dẫn tương đối trong scope ("" = gốc). Chặn "..", NUL. */
export function cleanRel(p: unknown): string {
  const s = String(p ?? "").replaceAll("\\", "/").trim();
  if (s.includes("\0")) throw new HttpError(400, "Đường dẫn không hợp lệ");
  const segs = s.split("/").filter((x) => x && x !== ".");
  if (segs.some((x) => x === "..")) throw new HttpError(400, "Đường dẫn không hợp lệ");
  return segs.join("/");
}

/** Tên file/thư mục không dấu, chữ thường, a-z0-9 . _ - (giữ đuôi file). */
export function safeLibName(name: string, isDir = false): string {
  const base = String(name ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const slug = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "");
  const dot = isDir ? -1 : base.lastIndexOf(".");
  const stem = slug(dot > 0 ? base.slice(0, dot) : base).slice(0, 80) || (isDir ? "thu-muc" : "file");
  const ext = dot > 0 ? slug(base.slice(dot + 1)).replace(/[^a-z0-9]/g, "").slice(0, 10) : "";
  return ext ? `${stem}.${ext}` : stem;
}

function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

async function absIn(root: string, rel: string): Promise<string> {
  const abs = resolve(root, rel);
  if (!inside(resolve(root), abs)) throw new HttpError(400, "Đường dẫn nằm ngoài thư viện");
  try {
    await assertRealPathInside(abs, [root], "thư viện");
  } catch {
    throw new HttpError(400, "Đường dẫn nằm ngoài thư viện");
  }
  return abs;
}

// ===== Scope =====

interface Scope {
  id: string;
  kind: "shared" | "agent";
  root: string;
  name: string;
  agentKey?: string;
  libraryWritable?: boolean;
}

async function resolveScope(
  db: Db,
  ctx: WorkspaceContext,
  dataDir: string,
  scopeId: string,
): Promise<Scope> {
  if (scopeId === "shared") {
    return {
      id: "shared",
      kind: "shared",
      root: sharedDirFor(dataDir, ctx.workspaceId),
      name: "Chung cả bộ phận",
    };
  }
  if (!UUID_RE.test(scopeId)) throw new HttpError(404, "Không có thư viện này");
  const agent = await getAgentById(db, ctx, scopeId);
  if (!agent) throw new HttpError(404, "Agent không tồn tại");
  return {
    id: agent.id,
    kind: "agent",
    root: agentLibraryDir(dataDir, ctx.workspaceId, agent.id),
    name: agent.name,
    agentKey: agent.key,
    libraryWritable: agent.libraryWritable === true,
  };
}

/** shared/skills/ và AGENT.md hệ thống tự quản — skills chỉ xem. */
function isProtected(scope: Scope, rel: string): boolean {
  return scope.kind === "shared" && (rel === "skills" || rel.startsWith("skills/"));
}

function assertMutable(scope: Scope, rel: string): void {
  if (isProtected(scope, rel)) {
    throw new HttpError(403, "Thư mục skills/ do hệ thống Skill quản lý — sửa ở trang Skills");
  }
}

// ===== Dung lượng =====

/** Tổng dung lượng tính hạn mức: mọi thư viện agent + shared (trừ skills). Thùng rác không tính. */
async function workspaceUsage(dataDir: string, workspaceId: string): Promise<number> {
  const libs = await dirSize(libraryWorkspaceRoot(dataDir, workspaceId), [".thung-rac"]);
  const shared = await dirSize(sharedDirFor(dataDir, workspaceId), ["skills"]);
  return libs.bytes + shared.bytes;
}

async function assertQuota(dataDir: string, ctx: WorkspaceContext, addBytes: number): Promise<void> {
  const { quotaBytes } = libraryLimits();
  const used = await workspaceUsage(dataDir, ctx.workspaceId);
  if (used + addBytes > quotaBytes) {
    throw new HttpError(
      413,
      `Vượt hạn mức thư viện của bộ phận (đã dùng ${(used / MB).toFixed(1)} MB / ${(quotaBytes / MB).toFixed(0)} MB)`,
    );
  }
}

// ===== Tiện ích ghi =====

/** Tên chưa tồn tại trong thư mục: name, name-2, name-3... */
async function uniqueTarget(dir: string, name: string, isDir: boolean): Promise<string> {
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 200; i++) {
    const target = join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
    if (!(await stat(target).catch(() => null))) return target;
  }
  throw new HttpError(409, "Trùng tên quá nhiều");
}

/**
 * Chuẩn hóa thư mục đích: đoạn nào ĐÃ tồn tại thì giữ nguyên tên (kể cả thư
 * mục cũ có dấu), đoạn nào sẽ tạo mới thì chuyển sang tên không dấu.
 */
async function targetDir(root: string, dirRel: string): Promise<string> {
  const out: string[] = [];
  for (const seg of cleanRel(dirRel).split("/").filter(Boolean)) {
    const existing = await stat(join(root, ...out, seg)).catch(() => null);
    out.push(existing?.isDirectory() ? seg : safeLibName(seg, true));
  }
  return out.join("/");
}

function relOf(root: string, abs: string): string {
  return abs === root ? "" : abs.slice(root.length + 1).split(sep).join("/");
}

// ===== Routes =====

const MkdirBody = z.object({ path: z.string().default(""), name: z.string().trim().min(1).max(120) });
const MoveBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
const CopyBody = z.object({
  fromScope: z.string().min(1),
  path: z.string().min(1),
  toScope: z.string().min(1),
  toDir: z.string().default(""),
});
const ImportChatBody = z.object({
  p: z.string().min(1).max(1000),
  toScope: z.string().min(1),
  toDir: z.string().default(""),
});

export function registerLibraryRoutes(app: FastifyInstance, deps: { db: Db; dataDir: string }): void {
  const { db, dataDir } = deps;

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!hasRole(req.authCtx.role, "operator")) {
      void reply.code(403).send({ error: "Cần quyền operator trở lên" });
      return false;
    }
    return true;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, ...err.extra });
    throw err;
  };

  // Dọn thùng rác quá 30 ngày mỗi 6 giờ (không giữ tiến trình sống)
  const timer = setInterval(() => {
    purgeExpiredTrash(dataDir).catch((e) => logger.warn(`Dọn thùng rác thư viện lỗi: ${(e as Error).message}`));
  }, 6 * 3600_000);
  timer.unref?.();

  // Tổng quan: các scope + dung lượng + giới hạn
  app.get("/v1/library", async (req, reply) => {
    if (!guard(req, reply)) return;
    const ctx = req.authCtx;
    const agents = await listAgents(db, ctx);
    const shared = await dirSize(sharedDirFor(dataDir, ctx.workspaceId), ["skills"]);
    const scopes: Array<Record<string, unknown>> = [
      {
        id: "shared",
        kind: "shared",
        name: "Chung cả bộ phận",
        note: `Mọi agent trong bộ phận (${agents.length} agent) đọc được qua tiền tố shared/`,
        usedBytes: shared.bytes,
        files: shared.files,
      },
    ];
    let used = shared.bytes;
    for (const a of agents) {
      const s = await dirSize(agentLibraryDir(dataDir, ctx.workspaceId, a.id));
      used += s.bytes;
      scopes.push({
        id: a.id,
        kind: "agent",
        key: a.key,
        name: a.name,
        libraryWritable: a.libraryWritable === true,
        usedBytes: s.bytes,
        files: s.files,
      });
    }
    return { scopes, usedBytes: used, ...libraryLimits(), canToggleWrite: hasRole(ctx.role, "ws_admin") };
  });

  // Liệt kê 1 thư mục
  app.get("/v1/library/:scope/list", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      await mkdir(scope.root, { recursive: true });
      const rel = cleanRel((req.query as { path?: string }).path);
      const abs = await absIn(scope.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isDirectory()) throw new HttpError(404, "Thư mục không tồn tại");
      const entries = [];
      for (const e of await readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue; // file tạm khi tải lên
        const p = join(abs, e.name);
        const est = await stat(p).catch(() => null);
        if (!est) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        entries.push({
          name: e.name,
          type: est.isDirectory() ? "dir" : "file",
          size: est.isDirectory() ? 0 : est.size,
          items: est.isDirectory() ? (await readdir(p).catch(() => [])).filter((n) => !n.startsWith(".")).length : undefined,
          mtime: est.mtime.toISOString(),
          readonly: isProtected(scope, childRel),
        });
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      const agentPath =
        scope.kind === "shared" ? `shared/${rel}` : `thu-vien/${rel}`;
      return {
        scope: {
          id: scope.id,
          kind: scope.kind,
          name: scope.name,
          key: scope.agentKey,
          libraryWritable: scope.libraryWritable,
          absRoot: scope.root.replaceAll("\\", "/"),
        },
        path: rel,
        agentPath: agentPath.replace(/\/$/, ""),
        readonly: isProtected(scope, rel),
        entries,
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Tải về / xem trước
  app.get("/v1/library/:scope/file", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
      const rel = cleanRel((req.query as { path?: string }).path);
      if (!rel) throw new HttpError(400, "Thiếu đường dẫn file");
      const abs = await absIn(scope.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, "File không tồn tại");
      return sendDownload(req, reply, abs);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Tải lên: body là NỘI DUNG FILE thô (application/octet-stream), không base64.
  void app.register(async (scoped) => {
    const { maxFileBytes } = libraryLimits();
    scoped.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: maxFileBytes + MB },
      (_req, body, done) => done(null, body),
    );
    scoped.put("/v1/library/:scope/file", { bodyLimit: maxFileBytes + MB }, async (req, reply) => {
      if (!guard(req, reply)) return;
      try {
        const ctx = req.authCtx;
        const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
        const q = req.query as { path?: string; overwrite?: string };
        const raw = cleanRel(q.path);
        if (!raw) throw new HttpError(400, "Thiếu tên file");
        await mkdir(scope.root, { recursive: true });
        const dirRel = await targetDir(scope.root, raw.includes("/") ? raw.slice(0, raw.lastIndexOf("/")) : "");
        const name = safeLibName(raw.split("/").pop() ?? "");
        const rel = dirRel ? `${dirRel}/${name}` : name;
        assertMutable(scope, rel);
        const body = req.body;
        if (!Buffer.isBuffer(body)) throw new HttpError(400, "Body phải là nội dung file (application/octet-stream)");
        if (body.length > maxFileBytes) {
          throw new HttpError(413, `File vượt ${(maxFileBytes / MB).toFixed(0)} MB`);
        }
        await mkdir(scope.root, { recursive: true });
        const dirAbs = await absIn(scope.root, dirRel);
        await mkdir(dirAbs, { recursive: true });
        const abs = await absIn(scope.root, rel);
        const existing = await stat(abs).catch(() => null);
        if (existing?.isDirectory()) throw new HttpError(409, `Đã có thư mục tên "${name}"`);
        if (existing && q.overwrite !== "1") {
          throw new HttpError(409, `File "${name}" đã có`, { exists: true, name, path: rel });
        }
        await assertQuota(dataDir, ctx, body.length - (existing?.size ?? 0));
        if (existing) await moveToTrash(dataDir, ctx, scope, rel, abs, "Bị ghi đè khi tải bản mới");
        const tmp = join(dirAbs, `.upload-${randomBytes(6).toString("hex")}`);
        await writeFile(tmp, body);
        await rename(tmp, abs);
        await recordAudit(db, ctx, "library.upload", {
          scope: scope.id,
          agentKey: scope.agentKey,
          path: rel,
          size: body.length,
          overwrite: !!existing,
        });
        return { ok: true, name, path: rel, size: body.length, overwritten: !!existing };
      } catch (err) {
        return fail(reply, err);
      }
    });
  });

  // Tạo thư mục con
  app.post("/v1/library/:scope/mkdir", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      const b = MkdirBody.safeParse(req.body);
      if (!b.success) throw new HttpError(400, "Thiếu tên thư mục");
      await mkdir(scope.root, { recursive: true });
      const parent = await targetDir(scope.root, b.data.path);
      const name = safeLibName(b.data.name, true);
      const rel = parent ? `${parent}/${name}` : name;
      assertMutable(scope, rel);
      await mkdir(scope.root, { recursive: true });
      const abs = await absIn(scope.root, rel);
      if (await stat(abs).catch(() => null)) throw new HttpError(409, `"${name}" đã có`);
      await mkdir(abs, { recursive: true });
      await recordAudit(db, ctx, "library.mkdir", { scope: scope.id, agentKey: scope.agentKey, path: rel });
      return { ok: true, name, path: rel };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Đổi tên / di chuyển trong cùng scope
  app.post("/v1/library/:scope/move", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      const b = MoveBody.safeParse(req.body);
      if (!b.success) throw new HttpError(400, "Thiếu from/to");
      const from = cleanRel(b.data.from);
      const toRaw = cleanRel(b.data.to);
      if (!from || !toRaw) throw new HttpError(400, "Đường dẫn không hợp lệ");
      assertMutable(scope, from);
      const fromAbs = await absIn(scope.root, from);
      const st = await stat(fromAbs).catch(() => null);
      if (!st) throw new HttpError(404, "Không tìm thấy mục cần chuyển");
      const toDir = await targetDir(scope.root, toRaw.includes("/") ? toRaw.slice(0, toRaw.lastIndexOf("/")) : "");
      const toName = safeLibName(toRaw.split("/").pop() ?? "", st.isDirectory());
      const to = toDir ? `${toDir}/${toName}` : toName;
      assertMutable(scope, to);
      if (to === from) return { ok: true, path: to };
      if (st.isDirectory() && (to + "/").startsWith(from + "/")) {
        throw new HttpError(400, "Không thể chuyển thư mục vào bên trong chính nó");
      }
      const toAbs = await absIn(scope.root, to);
      if (await stat(toAbs).catch(() => null)) throw new HttpError(409, `"${toName}" đã có ở nơi đến`);
      await mkdir(dirname(toAbs), { recursive: true });
      await rename(fromAbs, toAbs);
      await recordAudit(db, ctx, "library.move", { scope: scope.id, agentKey: scope.agentKey, from, to });
      return { ok: true, path: to };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Xóa → thùng rác
  app.delete("/v1/library/:scope/entry", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      const rel = cleanRel((req.query as { path?: string }).path);
      if (!rel) throw new HttpError(400, "Không xóa được thư mục gốc");
      assertMutable(scope, rel);
      const abs = await absIn(scope.root, rel);
      if (!(await stat(abs).catch(() => null))) throw new HttpError(404, "Không tìm thấy");
      const meta = await moveToTrash(dataDir, ctx, scope, rel, abs, "Xóa từ Dashboard");
      await recordAudit(db, ctx, "library.delete", {
        scope: scope.id,
        agentKey: scope.agentKey,
        path: rel,
        trashId: meta.id,
        size: meta.size,
      });
      return { ok: true, trashId: meta.id };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Thùng rác
  app.get("/v1/library/:scope/trash", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
      return { items: await listTrash(dataDir, req.authCtx.workspaceId, scope.id), keepDays: TRASH_DAYS };
    } catch (err) {
      return fail(reply, err);
    }
  });

  const trashItemDir = (ctx: WorkspaceContext, scope: Scope, id: string): string => {
    if (!/^[a-z0-9]+-[0-9a-f]{8}$/.test(id)) throw new HttpError(404, "Không có mục này trong thùng rác");
    return join(trashScopeDir(dataDir, ctx.workspaceId, scope.id), id);
  };

  app.post("/v1/library/:scope/trash/:id/restore", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const p = req.params as { scope: string; id: string };
      const scope = await resolveScope(db, ctx, dataDir, p.scope);
      const dir = trashItemDir(ctx, scope, p.id);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8").catch(() => {
        throw new HttpError(404, "Không có mục này trong thùng rác");
      })) as TrashMeta;
      const rel = cleanRel(meta.path);
      if (!rel) throw new HttpError(400, "Mục hỏng");
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      await mkdir(scope.root, { recursive: true });
      const parentAbs = await absIn(scope.root, parentRel);
      await mkdir(parentAbs, { recursive: true });
      const target = await uniqueTarget(parentAbs, basename(rel), meta.type === "dir");
      await absIn(scope.root, relOf(scope.root, target));
      await rename(join(dir, "item"), target);
      await rm(dir, { recursive: true, force: true });
      const restored = relOf(scope.root, target);
      await recordAudit(db, ctx, "library.restore", { scope: scope.id, agentKey: scope.agentKey, path: restored });
      return { ok: true, path: restored };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/v1/library/:scope/trash/:id", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const p = req.params as { scope: string; id: string };
      const scope = await resolveScope(db, ctx, dataDir, p.scope);
      const dir = trashItemDir(ctx, scope, p.id);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8").catch(() => {
        throw new HttpError(404, "Không có mục này trong thùng rác");
      })) as TrashMeta;
      await rm(dir, { recursive: true, force: true });
      await recordAudit(db, ctx, "library.purge", { scope: scope.id, agentKey: scope.agentKey, path: meta.path });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Sao chép file/thư mục sang scope khác (vd bộ nhận diện cho nhiều agent)
  app.post("/v1/library/copy", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const b = CopyBody.safeParse(req.body);
      if (!b.success) throw new HttpError(400, "Thiếu tham số sao chép");
      const from = await resolveScope(db, ctx, dataDir, b.data.fromScope);
      const to = await resolveScope(db, ctx, dataDir, b.data.toScope);
      const srcRel = cleanRel(b.data.path);
      if (!srcRel) throw new HttpError(400, "Thiếu đường dẫn nguồn");
      const srcAbs = await absIn(from.root, srcRel);
      const st = await stat(srcAbs).catch(() => null);
      if (!st) throw new HttpError(404, "Không tìm thấy nguồn");
      const size = st.isDirectory() ? (await dirSize(srcAbs)).bytes : st.size;
      await mkdir(to.root, { recursive: true });
      const toDir = await targetDir(to.root, b.data.toDir);
      assertMutable(to, toDir ? `${toDir}/x` : "x");
      const dirAbs = await absIn(to.root, toDir);
      await mkdir(dirAbs, { recursive: true });
      await assertQuota(dataDir, ctx, size);
      const target = await uniqueTarget(dirAbs, basename(srcAbs), st.isDirectory());
      await absIn(to.root, relOf(to.root, target));
      await cp(srcAbs, target, { recursive: true, errorOnExist: true, force: false });
      const path = relOf(to.root, target);
      await recordAudit(db, ctx, "library.copy", {
        from: from.id,
        fromPath: srcRel,
        to: to.id,
        toAgentKey: to.agentKey,
        path,
        size,
      });
      return { ok: true, path, toScope: to.id };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Lưu file từ khung chat (file agent trả / người dùng gửi) vào thư viện
  app.post("/v1/library/import-chat", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const b = ImportChatBody.safeParse(req.body);
      if (!b.success) throw new HttpError(400, "Thiếu tham số");
      const src = await resolveDownload(b.data.p, ctx, webDirs(dataDir, ctx));
      if (!src) throw new HttpError(404, "Không tìm thấy file trong khung chat");
      const st = await stat(src);
      const { maxFileBytes } = libraryLimits();
      if (st.size > maxFileBytes) throw new HttpError(413, `File vượt ${(maxFileBytes / MB).toFixed(0)} MB`);
      const to = await resolveScope(db, ctx, dataDir, b.data.toScope);
      await mkdir(to.root, { recursive: true });
      const toDir = await targetDir(to.root, b.data.toDir);
      assertMutable(to, toDir ? `${toDir}/x` : "x");
      const dirAbs = await absIn(to.root, toDir);
      await mkdir(dirAbs, { recursive: true });
      await assertQuota(dataDir, ctx, st.size);
      const target = await uniqueTarget(dirAbs, safeLibName(basename(src)), false);
      await absIn(to.root, relOf(to.root, target));
      await cp(src, target, { errorOnExist: true, force: false });
      const path = relOf(to.root, target);
      await recordAudit(db, ctx, "library.import_chat", {
        to: to.id,
        toAgentKey: to.agentKey,
        path,
        size: st.size,
      });
      return { ok: true, path, toScope: to.id, name: basename(target) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ===== Xem / sửa văn bản (Markdown, txt, csv, json…) — trình soạn tách đôi trên Dashboard =====
  const textPath = async (req: FastifyRequest, rel: string) => {
    const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
    if (!rel) throw new HttpError(400, "Thiếu đường dẫn file");
    if (!isTextName(rel)) throw new HttpError(415, "Chỉ sửa được file văn bản (md, txt, csv, json, yaml…)");
    await mkdir(scope.root, { recursive: true });
    return { scope, abs: await absIn(scope.root, rel) };
  };

  app.get("/v1/library/:scope/text", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const rel = cleanRel((req.query as { path?: string }).path);
      const { scope, abs } = await textPath(req, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, "File không tồn tại");
      if (st.size > TEXT_MAX_BYTES) throw new HttpError(413, `File quá ${TEXT_MAX_BYTES / MB} MB — tải về để xem`);
      const buf = await readFile(abs);
      return {
        path: rel,
        content: buf.toString("utf8"),
        sha256: sha256Hex(buf),
        size: st.size,
        mtime: st.mtime.toISOString(),
        readonly: isProtected(scope, rel),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  const TextBody = z.object({
    path: z.string().min(1).max(1000),
    content: z.string().max(TEXT_MAX_BYTES),
    /** sha256 của bản đã mở — khác bản trên đĩa = người khác vừa sửa → 409 kèm bản mới để gộp. */
    baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
    /** Tạo file mới (lỗi nếu đã có). */
    create: z.boolean().optional(),
  });

  app.put("/v1/library/:scope/text", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const b = TextBody.safeParse(req.body);
      if (!b.success) throw new HttpError(400, b.error.issues.map((i) => i.message).join("; "));
      const scope0 = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      await mkdir(scope0.root, { recursive: true });
      const raw = cleanRel(b.data.path);
      let rel = raw;
      if (b.data.create) {
        const dirRel = raw.includes("/") ? await targetDir(scope0.root, raw.slice(0, raw.lastIndexOf("/"))) : "";
        rel = (dirRel ? `${dirRel}/` : "") + safeLibName(raw.split("/").pop() ?? "");
      }
      const { scope, abs } = await textPath(req, rel);
      assertMutable(scope, rel);
      const data = Buffer.from(b.data.content, "utf8");
      const existing = await stat(abs).catch(() => null);
      if (existing?.isDirectory()) throw new HttpError(409, "Đường dẫn là thư mục");
      if (b.data.create && existing) throw new HttpError(409, `File "${basename(rel)}" đã có`, { exists: true });
      if (existing) {
        const cur = await readFile(abs);
        const curSha = sha256Hex(cur);
        if (curSha === sha256Hex(data)) return { ok: true, path: rel, sha256: curSha, size: cur.length, unchanged: true };
        if (b.data.baseSha256 && b.data.baseSha256 !== curSha) {
          throw new HttpError(409, "File vừa được sửa ở nơi khác (agent hoặc người khác) — xem phần khác nhau rồi lưu lại", {
            conflict: true,
            content: cur.length <= TEXT_MAX_BYTES ? cur.toString("utf8") : null,
            sha256: curSha,
          });
        }
      }
      await assertQuota(dataDir, ctx, data.length - (existing?.size ?? 0));
      const dirAbs = await absIn(scope.root, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
      await mkdir(dirAbs, { recursive: true });
      // Bản cũ vào thùng rác (= lịch sử sửa, khôi phục được trong 30 ngày)
      if (existing) {
        const keep = join(dirAbs, `.ban-cu-${randomBytes(6).toString("hex")}`);
        await cp(abs, keep);
        await moveToTrash(dataDir, ctx, scope, rel, keep, "Bản trước khi sửa trên web");
      }
      const tmp = join(dirAbs, `.upload-${randomBytes(6).toString("hex")}`);
      await writeFile(tmp, data);
      await rename(tmp, abs);
      await recordAudit(db, ctx, existing ? "library.edit" : "library.create", { scope: scope.id, agentKey: scope.agentKey, path: rel, size: data.length });
      return { ok: true, path: rel, sha256: sha256Hex(data), size: data.length, created: !existing };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Lịch sử một file = các bản cũ của đúng đường dẫn đó trong thùng rác (bị sửa / ghi đè / xóa)
  app.get("/v1/library/:scope/history", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
      const rel = cleanRel((req.query as { path?: string }).path);
      const items = (await listTrash(dataDir, req.authCtx.workspaceId, scope.id)).filter((t) => t.path === rel && t.type === "file");
      return { items, keepDays: TRASH_DAYS };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Nội dung một bản cũ trong thùng rác (xem trước khi khôi phục)
  app.get("/v1/library/:scope/trash/:id/text", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const p = req.params as { scope: string; id: string };
      const scope = await resolveScope(db, ctx, dataDir, p.scope);
      const dir = trashItemDir(ctx, scope, p.id);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8").catch(() => {
        throw new HttpError(404, "Không có mục này trong thùng rác");
      })) as TrashMeta;
      if (meta.type !== "file" || !isTextName(meta.path)) throw new HttpError(415, "Bản này không phải file văn bản");
      if (meta.size > TEXT_MAX_BYTES) throw new HttpError(413, "Bản này quá lớn để xem");
      return { path: meta.path, content: await readFile(join(dir, "item"), "utf8"), deletedAt: meta.deletedAt, reason: meta.reason };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Xem trước nội dung PDF / Word / Excel / PowerPoint (trích chữ, không tải về)
  app.get("/v1/library/:scope/preview", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
      const rel = cleanRel((req.query as { path?: string }).path);
      if (!rel) throw new HttpError(400, "Thiếu đường dẫn file");
      const abs = await absIn(scope.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, "File không tồn tại");
      if (!PREVIEW_EXT.has(extOfName(rel))) throw new HttpError(415, "Chỉ xem trước PDF, Word, Excel, PowerPoint");
      if (st.size > 25 * MB) throw new HttpError(413, "File quá 25 MB — tải về để xem");
      let text: string;
      try {
        text = await extractDocumentText(basename(rel), await readFile(abs));
      } catch (e) {
        throw new HttpError(422, `Không đọc được nội dung: ${(e as Error).message}`);
      }
      const max = 200_000;
      return { path: rel, text: text.slice(0, max), truncated: text.length > max, totalChars: text.length };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Tải cả thư mục (gồm thư mục con) thành .zip
  app.get("/v1/library/:scope/zip", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const scope = await resolveScope(db, req.authCtx, dataDir, (req.params as { scope: string }).scope);
      await mkdir(scope.root, { recursive: true });
      const rel = cleanRel((req.query as { path?: string }).path);
      const abs = await absIn(scope.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isDirectory()) throw new HttpError(404, "Thư mục không tồn tại");
      const zip = new AdmZip();
      let files = 0;
      let total = 0;
      const walk = async (dirAbs: string, prefix: string): Promise<void> => {
        for (const e of await readdir(dirAbs, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const childAbs = join(dirAbs, e.name);
          const childRel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            zip.addFile(`${childRel}/`, Buffer.alloc(0));
            await walk(childAbs, childRel);
          } else if (e.isFile()) {
            const s = await stat(childAbs);
            files++;
            total += s.size;
            if (files > ZIP_MAX_ENTRIES) throw new HttpError(413, `Thư mục quá ${ZIP_MAX_ENTRIES} file — tải từng phần`);
            if (total > ZIP_MAX_BYTES) throw new HttpError(413, `Thư mục quá ${ZIP_MAX_BYTES / MB} MB — tải từng phần`);
            zip.addFile(childRel, await readFile(childAbs));
          }
        }
      };
      await walk(abs, "");
      const base = rel ? basename(rel) : scope.kind === "shared" ? "shared" : scope.agentKey || "thu-vien";
      const name = `${safeLibName(base, true)}.zip`;
      await recordAudit(db, req.authCtx, "library.zip", { scope: scope.id, agentKey: scope.agentKey, path: rel, files });
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${name}"`)
        .header("cache-control", "no-store")
        .send(zip.toBuffer());
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Giải nén file .zip vào thư mục cùng tên bên cạnh (tên chuẩn hóa không dấu, bỏ mục ẩn / đường dẫn lạ)
  app.post("/v1/library/:scope/extract", async (req, reply) => {
    if (!guard(req, reply)) return;
    try {
      const ctx = req.authCtx;
      const scope = await resolveScope(db, ctx, dataDir, (req.params as { scope: string }).scope);
      const rel = cleanRel((req.body as { path?: string } | null)?.path);
      if (!/\.zip$/i.test(rel)) throw new HttpError(400, "Chỉ giải nén file .zip");
      const abs = await absIn(scope.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, "File không tồn tại");
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      assertMutable(scope, parentRel ? `${parentRel}/x` : "x");
      let zip: AdmZip;
      try {
        zip = new AdmZip(abs);
      } catch {
        throw new HttpError(422, "File .zip hỏng hoặc không đọc được");
      }
      const entries = zip.getEntries();
      if (entries.length > ZIP_MAX_ENTRIES) throw new HttpError(413, `File nén có quá ${ZIP_MAX_ENTRIES} mục`);
      const total = entries.reduce((n, e) => n + (e.header.size || 0), 0);
      if (total > ZIP_MAX_BYTES) throw new HttpError(413, `Nội dung giải nén quá ${ZIP_MAX_BYTES / MB} MB`);
      await assertQuota(dataDir, ctx, total);
      const parentAbs = await absIn(scope.root, parentRel);
      const intoAbs = await uniqueTarget(parentAbs, safeLibName(basename(rel).replace(/\.zip$/i, ""), true), true);
      await absIn(scope.root, relOf(scope.root, intoAbs));
      await mkdir(intoAbs, { recursive: true });
      let files = 0;
      let dirs = 0;
      const skipped: string[] = [];
      for (const e of entries) {
        const segs = e.entryName.replaceAll("\\", "/").split("/").filter(Boolean);
        if (!segs.length || segs.some((x) => x === ".." || x.startsWith(".") || x === "__MACOSX")) {
          skipped.push(e.entryName);
          continue;
        }
        const safe = segs.map((x, i) => safeLibName(x, e.isDirectory || i < segs.length - 1));
        const target = resolve(intoAbs, ...safe);
        if (!inside(intoAbs, target)) {
          skipped.push(e.entryName);
          continue;
        }
        if (e.isDirectory) {
          await mkdir(target, { recursive: true });
          dirs++;
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, e.getData());
        files++;
      }
      const into = relOf(scope.root, intoAbs);
      await recordAudit(db, ctx, "library.extract", { scope: scope.id, agentKey: scope.agentKey, path: rel, into, files });
      return { ok: true, into, files, dirs, skipped };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
