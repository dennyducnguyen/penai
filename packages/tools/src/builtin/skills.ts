import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { parseSkillFrontmatter, slugify } from "../skill-frontmatter.js";
import { resolveWorkPathChecked } from "../workspace-paths.js";

const searchSchema = z.object({
  query: z.string().min(1).describe("Việc cần làm / chủ đề cần kỹ năng."),
});

export const skillSearchTool: ToolHandler<typeof searchSchema> = {
  name: "skill_search",
  description:
    "Tìm kỹ năng (skill) phù hợp với công việc. Trả về danh sách slug + mô tả; " +
    "dùng use_skill để nạp hướng dẫn chi tiết.",
  schema: searchSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.skills) throw new Error("Skills chưa được bật");
    return toolCtx.skills.search(args.query);
  },
};

const useSchema = z.object({
  slug: z.string().min(1).describe("slug của skill (lấy từ skill_search)."),
});

export const useSkillTool: ToolHandler<typeof useSchema> = {
  name: "use_skill",
  description: "Nạp nội dung hướng dẫn chi tiết của một skill theo slug.",
  schema: useSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.skills) throw new Error("Skills chưa được bật");
    return toolCtx.skills.get(args.slug);
  },
};

// Giới hạn đóng gói skill (publish_skill)
const PUBLISH_MAX_FILES = 60;
const PUBLISH_MAX_FILE_BYTES = 100 * 1024 * 1024;
const PUBLISH_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv"]);

const publishSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Thư mục trong workspace chứa SKILL.md (vd "skills-draft/bao-cao-tuan").'),
});

export const publishSkillTool: ToolHandler<typeof publishSchema> = {
  name: "publish_skill",
  description:
    "Đăng ký một thư mục skill (SKILL.md + scripts/ + references/) thành skill dùng lại được. " +
    "SKILL.md cần frontmatter (--- name: ... description: ... ---). " +
    "Skill mới mặc định chỉ cấp cho chính bạn; admin có thể mở cho agent khác trong dashboard.",
  schema: publishSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.skills?.publish) throw new Error("publish_skill chưa được bật");
    const dir = await resolveWorkPathChecked(toolCtx, args.path);
    // Đọc SKILL.md
    let raw: string;
    try {
      raw = await readFile(join(dir.abs, "SKILL.md"), "utf8");
    } catch {
      throw new Error(`Không thấy SKILL.md trong ${dir.display}`);
    }
    const fm = parseSkillFrontmatter(raw);
    const name = fm.fields.name ?? "";
    const description = fm.fields.description ?? "";
    const slug = fm.fields.slug || (name ? slugify(name) : "");
    if (!name || !description || !slug) {
      throw new Error("SKILL.md thiếu frontmatter name/description (slug tự sinh từ name)");
    }
    // Gom file kèm theo (trừ SKILL.md), có giới hạn an toàn
    const files: Array<{ path: string; contentB64: string }> = [];
    let total = 0;
    const entries = await readdir(dir.abs, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const parentPath = (e as { parentPath?: string; path?: string }).parentPath ?? (e as { path?: string }).path ?? dir.abs;
      const abs = join(parentPath, e.name);
      const rel = relative(dir.abs, abs).replaceAll("\\", "/");
      if (rel === "SKILL.md") continue;
      if (rel.split("/").some((seg) => seg.startsWith(".") || SKIP_DIRS.has(seg))) continue;
      const st = await stat(abs);
      if (st.size > PUBLISH_MAX_FILE_BYTES) {
        throw new Error(`File ${rel} quá lớn (${st.size} bytes, tối đa 100MB)`);
      }
      total += st.size;
      if (total > PUBLISH_MAX_TOTAL_BYTES) throw new Error("Tổng dung lượng skill vượt 100MB");
      if (files.length >= PUBLISH_MAX_FILES) throw new Error(`Quá ${PUBLISH_MAX_FILES} file`);
      files.push({ path: rel, contentB64: (await readFile(abs)).toString("base64") });
    }
    return toolCtx.skills.publish({ slug, name, description, content: raw, files });
  },
};

const updateSkillSchema = z
  .object({
    slug: z.string().min(1).describe("Slug chinh xac cua skill can sua."),
    skillMdSourcePath: z
      .string()
      .optional()
      .describe(
        "File SKILL.md moi trong workspace. Bo trong neu chi them/thay/xoa file kem theo.",
      ),
    upsertFiles: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .describe('Duong dan dich trong skill, vd "references/logo.png".'),
          sourcePath: z
            .string()
            .min(1)
            .describe("File nguon trong workspace, co the la file nguoi dung vua gui."),
        }),
      )
      .max(PUBLISH_MAX_FILES)
      .default([]),
    deleteFiles: z
      .array(z.string().min(1))
      .max(PUBLISH_MAX_FILES)
      .default([])
      .describe("Duong dan file cu trong skill can xoa."),
  })
  .refine(
    (v) => Boolean(v.skillMdSourcePath || v.upsertFiles.length || v.deleteFiles.length),
    { message: "Can co it nhat mot thay doi" },
  );

function cleanSkillFilePath(path: string): string {
  const raw = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = raw.split("/");
  if (
    !raw ||
    raw.length > 200 ||
    raw === "SKILL.md" ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".") || SKIP_DIRS.has(p))
  ) {
    throw new Error(`Duong dan file skill khong hop le: ${path}`);
  }
  return parts.join("/");
}

/**
 * Sua skill theo lo ma khong buoc agent publish lai ca thu muc. File khong nam
 * trong upsertFiles/deleteFiles duoc giu nguyen; quyen + snapshot nam o runtime.
 */
export const updateSkillTool: ToolHandler<typeof updateSkillSchema> = {
  name: "update_skill",
  description:
    "Sua mot skill co san khi ban co quyen Quan ly: thay SKILL.md, them/thay file nguoi dung gui, " +
    "va/hoac xoa file cu. Thao tac giu nguyen cac file khong duoc nhac den va tu tao phien ban khoi phuc.",
  schema: updateSkillSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.skills?.update) throw new Error("update_skill chua duoc bat");
    let content: string | undefined;
    if (args.skillMdSourcePath) {
      const source = await resolveWorkPathChecked(toolCtx, args.skillMdSourcePath);
      const info = await stat(source.abs).catch(() => null);
      if (!info?.isFile()) throw new Error(`Khong tim thay ${source.display}`);
      if (info.size > PUBLISH_MAX_FILE_BYTES) throw new Error("SKILL.md vuot 100MB");
      content = await readFile(source.abs, "utf8");
      const fm = parseSkillFrontmatter(content);
      if (!fm.fields.name || !fm.fields.description) {
        throw new Error("SKILL.md moi thieu frontmatter name/description");
      }
    }

    const upsertFiles: Array<{ path: string; contentB64: string }> = [];
    let total = 0;
    for (const f of args.upsertFiles) {
      const path = cleanSkillFilePath(f.path);
      const source = await resolveWorkPathChecked(toolCtx, f.sourcePath);
      const info = await stat(source.abs).catch(() => null);
      if (!info?.isFile()) throw new Error(`Khong tim thay ${source.display}`);
      if (info.size > PUBLISH_MAX_FILE_BYTES) {
        throw new Error(`File ${source.display} vuot 100MB`);
      }
      total += info.size;
      if (total > PUBLISH_MAX_TOTAL_BYTES) throw new Error("Tong file cap nhat vuot 100MB");
      upsertFiles.push({ path, contentB64: (await readFile(source.abs)).toString("base64") });
    }
    const deleteFiles = [...new Set(args.deleteFiles.map(cleanSkillFilePath))];
    const overlap = upsertFiles.find((f) => deleteFiles.includes(f.path));
    if (overlap) throw new Error(`Khong the vua thay vua xoa ${overlap.path}`);
    return toolCtx.skills.update({
      slug: args.slug,
      ...(content !== undefined ? { content } : {}),
      upsertFiles,
      deleteFiles,
    });
  },
};
