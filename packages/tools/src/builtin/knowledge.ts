import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const searchSchema = z.object({ query: z.string().min(1) });
export const vaultSearchTool: ToolHandler<typeof searchSchema> = {
  name: "vault_search",
  description:
    "Tìm các đoạn liên quan trong Kho tri thức bằng hybrid keyword + semantic, đã tự lọc theo Collection, agent và người/conversation hiện tại. Trả nguồn và slug; chỉ dùng vault_get khi thực sự cần đọc toàn văn.",
  schema: searchSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.vault) throw new Error("Vault chưa được bật");
    return toolCtx.vault.search(args.query);
  },
};

const getSchema = z.object({
  slug: z.string().min(1),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Đọc tiếp từ ký tự thứ N — dùng khi tài liệu dài bị cắt cửa sổ."),
});
export const vaultGetTool: ToolHandler<typeof getSchema> = {
  name: "vault_get",
  description:
    "Đọc toàn văn một tài liệu Kho tri thức theo slug (kiểm tra lại quyền). " +
    "Tài liệu rất dài trả theo cửa sổ lớn — gọi lại với offset để đọc trọn phần còn lại.",
  schema: getSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.vault) throw new Error("Vault chưa được bật");
    return toolCtx.vault.get(args.slug, args.offset);
  },
};

const writeSchema = z.object({
  slug: z.string().min(1).describe("định danh tài liệu (kebab-case)."),
  title: z.string().min(1),
  content: z.string().min(1).describe("nội dung markdown, dùng [[slug]] để liên kết tài liệu khác."),
});
export const vaultWriteTool: ToolHandler<typeof writeSchema> = {
  name: "vault_write",
  description: "Tạo/cập nhật tài liệu trong Collection mặc định của Kho tri thức và lập chỉ mục lại.",
  schema: writeSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.vault) throw new Error("Vault chưa được bật");
    return toolCtx.vault.write(args.slug, args.title, args.content);
  },
};

const kgSchema = z.object({
  name: z.string().min(1).describe("tên thực thể cần tra trong đồ thị tri thức."),
  depth: z.number().int().min(1).max(4).default(2),
});
export const kgSearchTool: ToolHandler<typeof kgSchema> = {
  name: "kg_search",
  description: "Tra một thực thể trong đồ thị tri thức và các quan hệ liên quan.",
  schema: kgSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.kg) throw new Error("Knowledge graph chưa được bật");
    return toolCtx.kg.search(args.name, args.depth);
  },
};
