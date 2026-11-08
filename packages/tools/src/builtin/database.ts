import { z } from "zod";
import type { ToolHandler } from "../registry.js";

/**
 * Tool CSDL của workspace (bảng PostgreSQL thật dùng chung với quy trình, API, MCP,
 * trang 🗃️ Dữ liệu). Quyền + bộ kiểm SQL nằm ở runtime (toolCtx.database).
 */

const NOT_AVAILABLE =
  "Không dùng được CSDL của workspace trong ngữ cảnh này (chỉ khi người dùng có quyền chat trên trang Chat của Dashboard). " +
  "Muốn khách qua Zalo/Telegram tra cứu dữ liệu: tạo quy trình có bước Cơ sở dữ liệu và bật 'Cho chạy từ chat'.";

const schemaSchema = z.object({});
export const dbSchemaTool: ToolHandler<typeof schemaSchema> = {
  name: "db_schema",
  description:
    "Xem cấu trúc CSDL của workspace: các bảng, cột (kiểu, khóa, mặc định), chú thích, số dòng. GỌI TRƯỚC khi viết SQL hoặc tạo bước db trong quy trình — để dùng đúng tên bảng/cột.",
  schema: schemaSchema,
  async execute(_args, toolCtx) {
    if (!toolCtx.database) return NOT_AVAILABLE;
    return toolCtx.database.schema();
  },
};

const querySchema = z.object({
  sql: z
    .string()
    .min(1)
    .max(200_000)
    .describe(
      "Câu SQL PostgreSQL (một hoặc nhiều lệnh, chạy trong MỘT giao dịch). Giá trị từ người dùng đặt bằng $1, $2… và truyền ở params. " +
        "Tạo bảng: CREATE TABLE … kèm COMMENT ON TABLE/COLUMN để lần sau tự hiểu. Không tên schema, không BEGIN/COMMIT, không SET.",
    ),
  params: z.array(z.unknown()).max(1000).optional().describe("Giá trị cho $1, $2… (chỉ khi sql là MỘT câu lệnh)."),
  confirm: z
    .boolean()
    .optional()
    .describe("true CHỈ khi người dùng đã đồng ý lệnh xóa nhiều dữ liệu (DROP, TRUNCATE, DELETE/UPDATE không WHERE, xóa cột)."),
  dryRun: z.boolean().optional().describe("true = chạy thử rồi hoàn tác (xem trước số dòng bị ảnh hưởng), không lưu."),
});
export const dbQueryTool: ToolHandler<typeof querySchema> = {
  name: "db_query",
  description:
    "Chạy SQL trên CSDL riêng của workspace (bảng do người dùng/agent/quy trình tạo — khách hàng, đơn hàng, nhật ký, trạng thái…): đọc (SELECT), ghi (INSERT/UPDATE/DELETE), " +
    "tạo/sửa bảng (CREATE/ALTER TABLE, COMMENT). Trả các dòng kết quả (tối đa ~1000). Lệnh phá dữ liệu cần confirm=true sau khi người dùng đồng ý. " +
    "Không có bảng của PenAI (agent, hội thoại…) trong CSDL này. Không lưu mật khẩu/token ở đây — token dùng Khóa bí mật của quy trình.",
  schema: querySchema,
  async execute(args, toolCtx) {
    if (!toolCtx.database) return NOT_AVAILABLE;
    return toolCtx.database.query({
      sql: args.sql,
      ...(args.params ? { params: args.params } : {}),
      confirm: args.confirm === true,
      dryRun: args.dryRun === true,
    });
  },
};
