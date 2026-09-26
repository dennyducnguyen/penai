import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { logger } from "@penai/shared";
import {
  listAllSkillFiles,
  listEnabledSkillsForSync,
  type DbHandle,
} from "@penai/db";

/**
 * Skill được materialize ra đĩa để agent đọc/chạy script:
 *   .data/<workspace>/shared/skills/<slug>/SKILL.md
 *   .data/<workspace>/shared/skills/<slug>/scripts/...
 * Vùng shared/ vốn chỉ đọc với agent → không cần thêm luật jail mới.
 * DB là nguồn chuẩn (backup/restore đủ); thư mục trên đĩa dựng lại được bất kỳ lúc nào.
 */

// Giới hạn ZIP import (chống bom + rác)
const ZIP_MAX_ENTRIES = 60;
const ZIP_MAX_FILE_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv", "__MACOSX"]);

/** Chặn zip-slip / path lạ: chỉ nhận path tương đối sạch bên trong thư mục skill. */
export function sanitizeSkillPath(p: string): string | null {
  const raw = p.replaceAll("\\", "/").replace(/^\.\//, "").trim();
  if (!raw || raw.length > 200) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segs = raw.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return null;
    if (seg.startsWith(".") && seg !== ".gitkeep") return null; // file/thư mục ẩn
    if (SKIP_DIRS.has(seg)) return null;
  }
  return segs.join("/");
}

function skillDir(dataDir: string, workspaceId: string, slug: string): string {
  return resolve(join(dataDir, workspaceId, "shared", "skills", slug));
}

/** Ghi (đè) toàn bộ thư mục skill trên đĩa từ nội dung DB. */
export async function materializeSkill(
  dataDir: string,
  workspaceId: string,
  slug: string,
  skillMd: string,
  files: Array<{ path: string; contentB64: string }>,
): Promise<void> {
  const dir = skillDir(dataDir, workspaceId, slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");
  for (const f of files) {
    const safe = sanitizeSkillPath(f.path);
    if (!safe) continue;
    const abs = join(dir, safe);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(f.contentB64, "base64"));
  }
}

export async function removeSkillDir(
  dataDir: string,
  workspaceId: string,
  slug: string,
): Promise<void> {
  await rm(skillDir(dataDir, workspaceId, slug), { recursive: true, force: true });
}

/** Boot: dựng lại thư mục skill của mọi workspace từ DB. */
export async function syncAllSkillsToDisk(db: DbHandle, dataDir: string): Promise<void> {
  const [metas, files] = await Promise.all([
    listEnabledSkillsForSync(db.db),
    listAllSkillFiles(db.db),
  ]);
  const byKey = new Map<string, Array<{ path: string; contentB64: string }>>();
  for (const f of files) {
    const k = `${f.workspaceId}/${f.slug}`;
    const list = byKey.get(k) ?? [];
    list.push({ path: f.path, contentB64: f.contentB64 });
    byKey.set(k, list);
  }
  let n = 0;
  for (const m of metas) {
    try {
      await materializeSkill(
        dataDir,
        m.workspaceId,
        m.slug,
        m.content,
        byKey.get(`${m.workspaceId}/${m.slug}`) ?? [],
      );
      n++;
    } catch (err) {
      logger.warn(`Skill "${m.slug}": materialize lỗi — ${(err as Error).message}`);
    }
  }
  if (n) logger.info(`Skills: đã dựng ${n} thư mục skill ra đĩa`);
}

export interface ZipSkillPayload {
  skillMd: string;
  files: Array<{ path: string; contentB64: string }>;
}

/**
 * Đọc ZIP skill: tìm SKILL.md ở gốc hoặc trong đúng 1 thư mục cấp 1
 * (kiểu zip cả folder "ky-nang/"), bỏ tiền tố đó cho mọi entry.
 */
export function readSkillZip(zipBuf: Buffer): ZipSkillPayload {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) throw new Error("ZIP rỗng");
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`ZIP quá ${ZIP_MAX_ENTRIES} file`);

  const names = entries.map((e) => e.entryName.replaceAll("\\", "/"));
  let prefix = "";
  if (!names.includes("SKILL.md")) {
    const cand = names.find((n) => /^[^/]+\/SKILL\.md$/.test(n));
    if (!cand) throw new Error("Không thấy SKILL.md ở gốc ZIP (hoặc trong 1 thư mục cấp 1)");
    prefix = cand.slice(0, cand.indexOf("/") + 1);
  }

  let skillMd = "";
  const files: Array<{ path: string; contentB64: string }> = [];
  let total = 0;
  for (const e of entries) {
    const name = e.entryName.replaceAll("\\", "/");
    if (prefix && !name.startsWith(prefix)) continue; // rác ngoài thư mục skill
    const rel = name.slice(prefix.length);
    // Kiểm tra kích thước trong ZIP trước khi giải nén để chặn ZIP bomb.
    if (e.header.size > ZIP_MAX_FILE_BYTES) throw new Error(`File ${rel} quá 100MB`);
    if (total + e.header.size > ZIP_MAX_TOTAL_BYTES) throw new Error("ZIP giải nén vượt 100MB");
    const data = e.getData();
    if (data.length > ZIP_MAX_FILE_BYTES) throw new Error(`File ${rel} quá 100MB`);
    total += data.length;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new Error("ZIP giải nén vượt 100MB");
    if (rel === "SKILL.md") {
      skillMd = data.toString("utf8");
      continue;
    }
    const safe = sanitizeSkillPath(rel);
    if (!safe) continue; // bỏ entry ẩn/nguy hiểm thay vì fail cả ZIP
    files.push({ path: safe, contentB64: data.toString("base64") });
  }
  if (!skillMd) throw new Error("SKILL.md rỗng");
  return { skillMd, files };
}

/** Đóng gói skill thành ZIP để tải về / chia sẻ giữa workspace. */
export function buildSkillZip(
  skillMd: string,
  files: Array<{ path: string; contentB64: string }>,
): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(skillMd, "utf8"));
  for (const f of files) {
    zip.addFile(f.path, Buffer.from(f.contentB64, "base64"));
  }
  return zip.toBuffer();
}
