import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { resolveWorkPathChecked } from "../workspace-paths.js";

const MAX_PUBLISH_BYTES = 100 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;
// Landing page can nhung asset on dinh. Link van co the thu hoi trong Dashboard/API.
const MAX_TTL_HOURS = 24 * 365 * 10;

const schema = z.object({
  path: z.string().describe("Đường dẫn file trong thư mục làm việc (vd banner.png)"),
  ttlHours: z
    .number()
    .optional()
    .describe(
      `Số giờ link còn hiệu lực (mặc định ${DEFAULT_TTL_HOURS}, tối đa 10 năm; ` +
        `ảnh nhúng landing page nên dùng thời hạn dài)`,
    ),
  fileName: z
    .string()
    .optional()
    .describe("Tên file hiển thị khi tải về (mặc định lấy theo tên file gốc)"),
});

/**
 * Tạo link HTTPS công khai có thời hạn cho 1 file trong vùng làm việc — dùng khi
 * cần đưa file cho dịch vụ bên ngoài (vd upload ảnh vào Canva qua URL) hoặc gửi
 * link tải cho người dùng. Link là token ngẫu nhiên không đoán được, tự hết hạn.
 */
export const publishFileTool: ToolHandler<typeof schema> = {
  name: "publish_file",
  description:
    "Tạo link công khai (HTTPS, có thời hạn) cho một file trong thư mục làm việc. " +
    "Dùng khi cần đưa file cho dịch vụ ngoài (vd upload ảnh vào Canva bằng URL) " +
    "hoặc gửi link tải cho người dùng. Muốn gửi file trực tiếp qua kênh chat thì " +
    "dùng send_file, KHÔNG cần tool này.",
  schema,
  async execute(args, toolCtx) {
    if (!toolCtx.publishFile) {
      return "Tính năng link công khai chưa bật trên hệ thống này (thiếu PENAI_PUBLIC_URL).";
    }
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    const info = await stat(res.abs).catch(() => null);
    if (!info?.isFile()) {
      return `Không tìm thấy file "${args.path}" trong thư mục làm việc.`;
    }
    if (info.size > MAX_PUBLISH_BYTES) {
      return `File quá lớn (${Math.round(info.size / 1024 / 1024)} MB > 100 MB) — không tạo link công khai được.`;
    }
    const ttlHours = Math.min(Math.max(args.ttlHours ?? DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS);
    const fileName = (args.fileName ?? basename(res.abs)).trim() || basename(res.abs);
    const out = await toolCtx.publishFile(res.abs, {
      ttlSeconds: ttlHours * 3600,
      fileName,
    });
    return (
      `Đã tạo link công khai cho "${res.display}" (hết hạn ${out.expiresAt}):\n${out.url}\n` +
      `Lưu ý: ai có link đều mở được — chỉ dùng cho file được phép chia sẻ.`
    );
  },
};
