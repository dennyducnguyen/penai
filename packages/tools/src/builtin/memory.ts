import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const addSchema = z.object({
  content: z.string().min(1).describe("Nội dung cần ghi nhớ (fact bền vững về user/công việc)."),
  importance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Độ quan trọng 0..1. >=0.7 sẽ luôn được nạp vào ngữ cảnh."),
});

export const memoryAddTool: ToolHandler<typeof addSchema> = {
  name: "memory_add",
  description:
    "Ghi nhớ một fact NGẮN GỌN, bền vững (tên, sở thích, quyết định, deadline...) để dùng lại " +
    "trong các cuộc trò chuyện sau. Thông tin dài/nhiều chi tiết thì ghi vào file ghi nhớ " +
    "(MEMORY.md hoặc memory/YYYY-MM-DD.md) bằng write_file thay vì tool này.",
  schema: addSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.memory) throw new Error("Memory chưa được bật cho agent này");
    await toolCtx.memory.add(args.content, {
      ...(args.importance !== undefined ? { importance: args.importance } : {}),
    });
    return "Đã ghi nhớ.";
  },
};

const searchSchema = z.object({
  query: z.string().min(1).describe(
    "Truy vấn tự nhiên. QUAN TRỌNG: dùng CÙNG NGÔN NGỮ với nội dung đã lưu " +
      "(ghi nhớ tiếng Việt thì tìm bằng tiếng Việt) — khớp ngôn ngữ tăng độ chính xác rõ rệt.",
  ),
  limit: z.number().int().min(1).max(10).default(5),
});

export const memorySearchTool: ToolHandler<typeof searchSchema> = {
  name: "memory_search",
  description:
    "Bước truy hồi BẮT BUỘC trước khi trả lời về việc đã làm, quyết định, ngày tháng, con người, " +
    "sở thích hay việc cần làm: tìm trong bộ nhớ dài hạn (fact của agent + Workspace Semantic nếu được bật " +
    "+ file MEMORY.md, memory/*.md). " +
    "Kết quả file có kèm path — đọc thêm ngữ cảnh bằng memory_get. " +
    "Không thấy kết quả liên quan thì nói thật là đã kiểm tra nhưng không có — TUYỆT ĐỐI không bịa.",
  schema: searchSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.memory) throw new Error("Memory chưa được bật cho agent này");
    return toolCtx.memory.search(args.query, args.limit);
  },
};

const getSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path file ghi nhớ, vd "MEMORY.md" hoặc "memory/2026-08-05.md" (lấy từ memory_search).'),
  from: z.number().int().min(1).optional().describe("Dòng bắt đầu (1-based). Bỏ trống = từ đầu."),
  lines: z.number().int().min(1).max(400).optional().describe("Số dòng cần đọc (mặc định 120)."),
});

export const memoryGetTool: ToolHandler<typeof getSchema> = {
  name: "memory_get",
  description:
    "Đọc một file ghi nhớ (MEMORY.md, memory/*.md) theo cửa sổ dòng — dùng SAU memory_search " +
    "để lấy đúng phần cần thiết, giữ ngữ cảnh nhỏ. Đọc được cả file ghi nhớ chung của agent.",
  schema: getSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.memory?.getDoc) throw new Error("Memory chưa được bật cho agent này");
    return toolCtx.memory.getDoc(args.path, args.from, args.lines);
  },
};
