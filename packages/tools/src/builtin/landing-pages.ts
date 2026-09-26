import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { slugify } from "../skill-frontmatter.js";
import { assertWritable, resolveWorkPathChecked } from "../workspace-paths.js";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

const saveSchema = z.object({
  slug: z.string().min(1).max(120).describe("Ten ngan trong URL, vd chien-dich-he-2026."),
  title: z.string().min(1).max(300).describe("Tieu de landing page."),
  sourcePath: z
    .string()
    .min(1)
    .describe("File HTML trong workspace; CSS va JavaScript phai viet inline trong file."),
});

export const saveLandingPageTool: ToolHandler<typeof saveSchema> = {
  name: "landing_page_save",
  description:
    "Tao moi hoac cap nhat landing page cong khai tu mot file HTML trong workspace. " +
    "Dung cung slug de sua trang da co; tra ve URL xem truc tiep tren domain PenAI.",
  schema: saveSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.landingPages) throw new Error("Landing page chua duoc bat");
    const source = await resolveWorkPathChecked(toolCtx, args.sourcePath);
    const info = await stat(source.abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`Khong tim thay ${source.display}`);
    if (info.size > MAX_HTML_BYTES) throw new Error("HTML vuot 2MB");
    const html = await readFile(source.abs, "utf8");
    if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
      throw new Error("File phai la tai lieu HTML day du co the <html> va <body>");
    }
    return toolCtx.landingPages.save({
      slug: slugify(args.slug),
      title: args.title.trim(),
      html,
    });
  },
};

const listSchema = z.object({
  query: z.string().optional().describe("Tu khoa tim trong slug/tieu de; bo trong de liet ke moi nhat."),
});

export const listLandingPagesTool: ToolHandler<typeof listSchema> = {
  name: "landing_page_list",
  description: "Liet ke/tim cac landing page cua workspace, kem slug, phien ban va URL cong khai.",
  schema: listSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.landingPages) throw new Error("Landing page chua duoc bat");
    return toolCtx.landingPages.list(args.query);
  },
};

const getSchema = z.object({
  slug: z.string().min(1).describe("Slug landing page can lay ve de sua."),
  outputPath: z
    .string()
    .optional()
    .describe('File HTML dich trong workspace, mac dinh "landing-pages/<slug>.html".'),
});

export const getLandingPageTool: ToolHandler<typeof getSchema> = {
  name: "landing_page_get",
  description:
    "Lay HTML hien tai cua landing page ve workspace de sua. Sau khi sua, goi landing_page_save cung slug.",
  schema: getSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.landingPages) throw new Error("Landing page chua duoc bat");
    const slug = slugify(args.slug);
    const page = await toolCtx.landingPages.get(slug);
    if (!page) return `Khong tim thay landing page "${slug}"`;
    const output = await resolveWorkPathChecked(
      toolCtx,
      args.outputPath ?? `landing-pages/${slug}.html`,
    );
    assertWritable(output, toolCtx);
    await mkdir(dirname(output.abs), { recursive: true });
    await writeFile(output.abs, page.html, "utf8");
    return (
      `Da lay "${page.title}" v${page.version} ve ${output.display}\n` +
      `URL hien tai: ${page.url}`
    );
  },
};
