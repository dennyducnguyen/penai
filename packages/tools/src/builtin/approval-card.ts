import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  text: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Nội dung cần xin quyết định — nêu RÕ việc gì, số liệu liên quan và ai nên bấm nút.",
    ),
  approveLabel: z.string().max(40).default("✅ Duyệt"),
  rejectLabel: z.string().max(40).default("❌ Từ chối"),
});

/**
 * Thẻ duyệt có nút bấm — dùng khi cần con người QUYẾT ĐỊNH trước khi làm tiếp
 * (xuất bản nội dung, thay đổi giá/tồn kho, gửi thông tin ra ngoài...).
 * Mô hình bất đồng bộ: gửi thẻ xong là kết thúc lượt; khi có người bấm, hệ
 * thống bơm tin "[Thẻ duyệt #id] ..." vào hội thoại để agent xử lý tiếp.
 */
export const approvalCardTool: ToolHandler<typeof schema> = {
  name: "send_approval_card",
  description:
    "Gửi THẺ DUYỆT có nút bấm (Duyệt / Từ chối) vào cuộc trò chuyện — dùng khi hành động " +
    "cần con người quyết định trước khi thực hiện (xuất bản, đổi giá, gửi email...). " +
    "Gửi xong hãy KẾT THÚC lượt và chờ: khi có người bấm nút, bạn sẽ nhận tin nhắn " +
    "'[Thẻ duyệt #id] ...' cho biết ai chọn gì để xử lý tiếp. Thẻ tự khóa nút sau khi bấm.",
  schema,
  async execute(args, toolCtx) {
    if (!toolCtx.approvalCard) {
      return "Kênh chat hiện tại chưa hỗ trợ thẻ nút bấm (chỉ Telegram và Microsoft Teams).";
    }
    const id = await toolCtx.approvalCard({
      text: args.text,
      buttons: [
        { label: args.approveLabel, value: "approve" },
        { label: args.rejectLabel, value: "reject" },
      ],
    });
    return (
      `Đã gửi thẻ duyệt #${id}. ĐỪNG chờ hay hỏi thêm trong lượt này — khi có người bấm nút, ` +
      `bạn sẽ nhận tin nhắn hệ thống "[Thẻ duyệt #${id}]" kèm lựa chọn của họ để làm tiếp.`
    );
  },
};
