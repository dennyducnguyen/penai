import { z } from "zod";
import type { ToolHandler } from "../registry.js";

/**
 * Bộ tool để agent TẠO, SỬA, CHẠY THỬ và CHẠY quy trình tự động (Dashboard →
 * Quy trình) khi chat. Mọi kiểm tra quyền + validate nằm ở runtime
 * (toolCtx.workflows); tool chỉ chuyển tham số.
 */

const NOT_AVAILABLE =
  "Không dùng được quy trình trong ngữ cảnh này (chỉ khi đang chat trực tiếp với người dùng; lượt chạy theo lịch / " +
  "trong quy trình không tự tạo quy trình). Quản trị viên quản lý ở Dashboard → Quy trình.";

const definition = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .describe(
    "Định nghĩa quy trình JSON đầy đủ { name, description, triggers, inputs, steps, settings } (object hoặc chuỗi JSON). " +
      "Cú pháp: gọi workflow_catalog kind=guide.",
  );
const idParam = z.string().min(1).max(80).describe("id (uuid) hoặc slug của quy trình — lấy từ workflow_list.");
const inputsParam = z.record(z.string(), z.unknown()).optional().describe("Tham số đầu vào (inputs) của lần chạy.");

const listSchema = z.object({ query: z.string().max(100).optional().describe("Lọc theo tên/mô tả.") });
export const workflowListTool: ToolHandler<typeof listSchema> = {
  name: "workflow_list",
  description:
    "Liệt kê các quy trình tự động của workspace: id, tên, trạng thái bật/tắt, trigger (lịch/webhook/tay), lần chạy gần nhất + kết quả, lần chạy kế. " +
    'Dùng khi người dùng hỏi "đang có quy trình nào", "sao sáng nay không chạy", hoặc trước khi sửa/chạy một quy trình.',
  schema: listSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.list(args.query);
  },
};

const getSchema = z.object({ id: idParam });
export const workflowGetTool: ToolHandler<typeof getSchema> = {
  name: "workflow_get",
  description: "Lấy định nghĩa JSON đầy đủ của một quy trình (để đọc hiểu hoặc sửa), kèm link webhook nếu có và kết quả từng bước lần chạy gần nhất.",
  schema: getSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.get(args.id);
  },
};

const catalogSchema = z.object({
  kind: z
    .enum(["guide", "channels", "tools", "mcp", "agents", "workflows", "secrets", "steps", "templates"])
    .optional()
    .describe("guide = hướng dẫn cú pháp JSON quy trình (đọc trước khi tạo lần đầu). Nhóm khác = danh mục tương ứng. Bỏ trống = mọi danh mục (dài)."),
});
export const workflowCatalogTool: ToolHandler<typeof catalogSchema> = {
  name: "workflow_catalog",
  description:
    "Danh mục để dựng bước quy trình cho ĐÚNG TÊN: kênh chat + các cuộc trò chuyện gần đây (cho bước send / agent.deliver), tool có sẵn + custom tool (kèm JSON Schema tham số), " +
    "MCP server + tool, agent, quy trình khác (subworkflow), tên khóa bí mật (secrets.*), loại bước, mẫu có sẵn. GỌI TRƯỚC khi tạo bước send/tool/mcp/agent.",
  schema: catalogSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.catalog(args.kind);
  },
};

const createSchema = z.object({
  definition,
  enabled: z.boolean().default(true).describe("Bật ngay (lịch/webhook có hiệu lực). false = lưu nháp ở trạng thái tắt."),
  note: z.string().max(300).optional().describe("Ghi chú phiên bản."),
});
export const workflowCreateTool: ToolHandler<typeof createSchema> = {
  name: "workflow_create",
  description:
    "Tạo quy trình tự động mới từ định nghĩa JSON (chạy việc không cần AI: gọi API, chạy mã, rẽ nhánh, lặp, gửi tin, gọi tool/MCP; có thể nhờ agent ở một bước). " +
    "Lỗi định nghĩa trả về danh sách có đường dẫn + gợi ý → sửa đúng chỗ rồi gọi lại. Tạo xong NÊN gọi workflow_test (dryRun) để kiểm tra, rồi báo người dùng link Dashboard.",
  schema: createSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.create({ definition: args.definition, enabled: args.enabled, ...(args.note ? { note: args.note } : {}) });
  },
};

const updateSchema = z.object({
  id: idParam,
  definition: definition.optional().describe("Định nghĩa JSON ĐẦY ĐỦ mới (ưu tiên cách này khi sửa nhiều). Lấy bản hiện tại bằng workflow_get rồi sửa."),
  ops: z
    .array(z.record(z.string(), z.unknown()))
    .max(50)
    .optional()
    .describe(
      "Thao tác nhỏ thay cho definition: {op:'update_step',id,fields:{...}} · {op:'insert',step:{...},after?|before?:id,into?:{id,key:'then|else|body|default|branches[0]'}} · " +
        "{op:'remove_step',id} · {op:'move_step',id,after?|before?|into?} · {op:'set_step',id,step} · {op:'set_triggers',triggers:[...]} · {op:'set',key:'name|description|inputs|settings',value}",
    ),
  enabled: z.boolean().optional().describe("Bật/tắt quy trình."),
  note: z.string().max(300).optional().describe("Ghi chú phiên bản (vd 'thêm bước gửi email cho sếp')."),
});
export const workflowUpdateTool: ToolHandler<typeof updateSchema> = {
  name: "workflow_update",
  description:
    "Sửa quy trình: gửi definition đầy đủ HOẶC ops (thao tác nhỏ), và/hoặc bật/tắt. Mỗi lần sửa thành một phiên bản mới (người dùng hoàn về được trên Dashboard). Trả danh sách bước thêm/xóa/đổi.",
  schema: updateSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.update({
      id: args.id,
      ...(args.definition !== undefined ? { definition: args.definition } : {}),
      ...(args.ops ? { ops: args.ops } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.note ? { note: args.note } : {}),
    });
  },
};

const testSchema = z.object({
  id: idParam,
  inputs: inputsParam,
  dryRun: z
    .boolean()
    .default(true)
    .describe("true (mặc định) = KHÔNG gửi tin/gọi POST/MCP/tool thật, chỉ hiện sẽ làm gì; false = chạy thật như bấm Chạy thử."),
});
export const workflowTestTool: ToolHandler<typeof testSchema> = {
  name: "workflow_test",
  description: "Chạy thử quy trình và nhận nhật ký từng bước (trạng thái, kết quả rút gọn, lỗi) để tự kiểm tra rồi sửa bằng workflow_update.",
  schema: testSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.test({ id: args.id, ...(args.inputs ? { inputs: args.inputs } : {}), dryRun: args.dryRun });
  },
};

const runSchema = z.object({
  id: idParam,
  inputs: inputsParam,
  wait: z.boolean().default(true).describe("Chờ kết quả (tối đa ~2 phút). false = chạy nền, trả runId."),
});
export const workflowRunTool: ToolHandler<typeof runSchema> = {
  name: "workflow_run",
  description:
    "Chạy THẬT một quy trình ngay (như bấm nút Chạy) với tham số inputs, trả kết quả. Dùng khi người dùng nhờ chạy quy trình, " +
    "hoặc khi việc người dùng nhờ đúng là việc một quy trình có sẵn làm (vd 'gửi báo cáo doanh thu hôm qua').",
  schema: runSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.run({ id: args.id, ...(args.inputs ? { inputs: args.inputs } : {}), wait: args.wait });
  },
};

const runsSchema = z.object({
  id: idParam,
  runId: z.string().uuid().optional().describe("Xem chi tiết từng bước của một lần chạy."),
  status: z.enum(["success", "failed", "stopped", "timeout", "running", "cancelled"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export const workflowRunsTool: ToolHandler<typeof runsSchema> = {
  name: "workflow_runs",
  description: "Lịch sử chạy của một quy trình (thời điểm, trigger, trạng thái, lỗi) hoặc chi tiết từng bước của một lần chạy — để trả lời 'sao không chạy', 'lỗi ở đâu'.",
  schema: runsSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    return toolCtx.workflows.runs({ id: args.id, ...(args.runId ? { runId: args.runId } : {}), ...(args.status ? { status: args.status } : {}), limit: args.limit });
  },
};

const deleteSchema = z.object({
  id: idParam,
  confirm: z.boolean().describe("Phải là true, và CHỈ đặt true sau khi người dùng đã xác nhận rõ muốn xóa."),
});
export const workflowDeleteTool: ToolHandler<typeof deleteSchema> = {
  name: "workflow_delete",
  description: "Xóa hẳn một quy trình (kèm lịch sử chạy và phiên bản). Hỏi lại người dùng trước; muốn tạm ngưng thì dùng workflow_update enabled=false.",
  schema: deleteSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.workflows) return NOT_AVAILABLE;
    if (!args.confirm) return "Chưa xóa: cần người dùng xác nhận rồi gọi lại với confirm=true.";
    return toolCtx.workflows.remove(args.id);
  },
};
