import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone, ví dụ Asia/Ho_Chi_Minh. Mặc định giờ hệ thống."),
});

export const currentTimeTool: ToolHandler<typeof schema> = {
  name: "current_time",
  description: "Lấy ngày giờ hiện tại.",
  schema,
  async execute(args) {
    if (args.timezone) {
      return new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone,
      }).format(new Date());
    }
    return new Date().toISOString();
  },
};
