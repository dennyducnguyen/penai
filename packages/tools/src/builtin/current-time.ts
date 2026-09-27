import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone, ví dụ Asia/Ho_Chi_Minh. Mặc định múi giờ của hệ thống PenAI."),
});

export const currentTimeTool: ToolHandler<typeof schema> = {
  name: "current_time",
  description: "Lấy ngày giờ hiện tại.",
  schema,
  async execute(args, toolCtx) {
    const now = new Date();
    const timeZone = args.timezone ?? toolCtx.timezone;
    if (timeZone) {
      const local = new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now);
      return `${local} (${timeZone}) — ISO ${now.toISOString()}`;
    }
    return now.toISOString();
  },
};
