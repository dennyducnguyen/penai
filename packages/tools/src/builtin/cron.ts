import { z } from "zod";
import type { ToolHandler } from "../registry.js";

/**
 * Lịch hẹn do agent tự đặt khi chat: nhắc việc, hẹn giờ, báo cáo định kỳ.
 * Tới giờ hệ thống chạy lại agent với `prompt` và gửi câu trả lời về đúng cuộc
 * trò chuyện đã đặt lịch. Mọi kiểm tra (lịch hợp lệ, tối thiểu 5 phút, giới hạn
 * số lịch, quyền xem/sửa) nằm ở runtime (toolCtx.cron) — tool chỉ chuyển tham số.
 */

const NOT_AVAILABLE =
  "Không đặt lịch được trong ngữ cảnh này (chỉ dùng khi đang chat với người dùng qua kênh chat hoặc trang Chat). " +
  "Quản trị viên có thể tạo lịch ở Dashboard → Cron.";

const SCHEDULE_HELP =
  'Một trong các dạng: "in 30m" / "in 2h" / "in 1d" (sau một khoảng, chạy 1 lần); ' +
  '"at 2026-09-28 08:00" (một lần, giờ địa phương); "every 2h" (lặp theo chu kỳ, tối thiểu 5 phút); ' +
  'hoặc cron 5 trường "phút giờ ngày tháng thứ": "0 8 * * *" = 8:00 hằng ngày, ' +
  '"30 17 * * 1-5" = 17:30 thứ Hai–thứ Sáu, "0 9 * * 1" = 9:00 mỗi thứ Hai, "0 9 1 * *" = 9:00 ngày 1 hằng tháng.';

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .describe('Tên ngắn để người dùng nhận ra lịch, vd "Nhắc gọi anh Nam", "Báo cáo doanh thu sáng thứ Hai".'),
  schedule: z.string().min(1).max(100).describe(SCHEDULE_HELP),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Việc BẠN sẽ làm khi tới giờ, viết như lời dặn gửi chính mình và ĐỦ NGỮ CẢNH — lúc chạy bạn KHÔNG thấy " +
        'hội thoại này. Vd: "Nhắc anh Đức gọi cho anh Nam (0909 123 456) về hợp đồng ABC trước 10h" hoặc ' +
        '"Tìm 5 tin AI nổi bật trong 24 giờ qua, tóm tắt mỗi tin 1 câu kèm link".',
    ),
  deliver: z
    .boolean()
    .default(true)
    .describe("Gửi kết quả về cuộc trò chuyện này (mặc định có). false = chỉ chạy ngầm, xem kết quả ở Dashboard."),
});

export const cronCreateTool: ToolHandler<typeof createSchema> = {
  name: "cron_create",
  description:
    "Đặt LỊCH để tự làm một việc vào thời điểm định trước rồi gửi kết quả về cuộc trò chuyện này — dùng khi " +
    'người dùng muốn được nhắc việc, hẹn giờ hoặc nhận báo cáo/tổng hợp định kỳ ("nhắc tôi 8h sáng mai...", ' +
    '"30 phút nữa báo tôi...", "sáng thứ Hai hằng tuần gửi tôi..."). Tới giờ, hệ thống chạy lại bạn với `prompt` ' +
    "và gửi câu trả lời cho người dùng. Giờ tính theo múi giờ của hệ thống (thường là giờ Việt Nam). " +
    "Lịch lặp lại mà người dùng chưa nói rõ tần suất/giờ thì hỏi lại trước khi tạo. " +
    "Tạo xong, báo lại ngắn gọn thời điểm chạy đầu tiên theo kết quả tool trả về. " +
    "Sửa/tạm dừng/hủy: cron_list lấy id rồi cron_update / cron_delete.",
  schema: createSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.cron) return NOT_AVAILABLE;
    return toolCtx.cron.create({
      name: args.name,
      schedule: args.schedule,
      prompt: args.prompt,
      deliver: args.deliver,
    });
  },
};

const listSchema = z.object({
  includeDone: z
    .boolean()
    .default(false)
    .describe("Kèm cả lịch đã chạy xong (một lần) hoặc đang tạm dừng."),
});

export const cronListTool: ToolHandler<typeof listSchema> = {
  name: "cron_list",
  description:
    "Xem các lịch hẹn bạn đã đặt cho người dùng này / cuộc trò chuyện này: id, tên, lịch, lần chạy kế tiếp, " +
    'trạng thái. Dùng khi người dùng hỏi "tôi đang có lịch nhắc nào" hoặc trước khi sửa/hủy lịch.',
  schema: listSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.cron) return NOT_AVAILABLE;
    return toolCtx.cron.list({ includeDone: args.includeDone });
  },
};

const idSchema = z
  .string()
  .min(4)
  .max(40)
  .describe('Id lịch (ít nhất 4 ký tự đầu, như cron_list hiển thị, vd "3f9a1c2e").');

const updateSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80).optional().describe("Tên mới."),
  schedule: z.string().min(1).max(100).optional().describe("Lịch mới. " + SCHEDULE_HELP),
  prompt: z.string().min(1).max(4000).optional().describe("Nội dung việc mới (đủ ngữ cảnh)."),
  enabled: z.boolean().optional().describe("false = tạm dừng, true = bật lại."),
});

export const cronUpdateTool: ToolHandler<typeof updateSchema> = {
  name: "cron_update",
  description:
    "Sửa một lịch hẹn: đổi giờ/tần suất (schedule), nội dung việc (prompt), tên, hoặc tạm dừng/bật lại (enabled). " +
    "Đổi lịch của lịch đã chạy xong sẽ bật lại lịch đó. Lấy id bằng cron_list.",
  schema: updateSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.cron) return NOT_AVAILABLE;
    if (
      args.name === undefined &&
      args.schedule === undefined &&
      args.prompt === undefined &&
      args.enabled === undefined
    ) {
      return "Không có gì để sửa — truyền ít nhất một trong: name, schedule, prompt, enabled.";
    }
    return toolCtx.cron.update({
      id: args.id,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    });
  },
};

const deleteSchema = z.object({ id: idSchema });

export const cronDeleteTool: ToolHandler<typeof deleteSchema> = {
  name: "cron_delete",
  description:
    "Xóa hẳn một lịch hẹn (người dùng muốn hủy nhắc / hủy báo cáo định kỳ). Chỉ muốn tạm ngưng thì dùng " +
    "cron_update với enabled=false. Lấy id bằng cron_list.",
  schema: deleteSchema,
  async execute(args, toolCtx) {
    if (!toolCtx.cron) return NOT_AVAILABLE;
    return toolCtx.cron.remove(args.id);
  },
};
