import { open, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { resolveWorkPathChecked } from "../workspace-paths.js";

const MAX_BYTES = 256 * 1024;

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('File cần đọc. Tương đối thư mục làm việc riêng; "shared/..." để đọc file chung; "thu-vien/..." để đọc thư viện file của agent.'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES)
    .optional()
    .describe("Giới hạn số byte đọc (mặc định 256KB)."),
});

/**
 * Đọc file văn bản trong thư mục làm việc (riêng người dùng) hoặc shared/.
 * Path-guard nằm ở resolveWorkPath — chặn traversal ra ngoài 2 vùng này.
 */
export const readFileTool: ToolHandler<typeof schema> = {
  name: "read_file",
  description:
    'Đọc nội dung file văn bản trong thư mục làm việc riêng, hoặc file dùng chung ("shared/...").',
  schema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    const info = await stat(res.abs).catch(() => null);
    if (!info) throw new Error(`Không tìm thấy ${res.display}`);
    if (!info.isFile()) throw new Error("Không phải file");
    const limit = args.maxBytes ?? MAX_BYTES;
    if (info.size > limit) {
      // Chỉ đọc đúng phần cần — file 5GB do exec tạo ra không được phép nuốt
      // hết RAM tiến trình.
      const fh = await open(res.abs, "r");
      try {
        const buf = Buffer.alloc(limit);
        const { bytesRead } = await fh.read(buf, 0, limit, 0);
        return (
          buf.subarray(0, bytesRead).toString("utf8") +
          `\n\n[... file dài ${info.size} bytes, đã cắt còn ${limit}]`
        );
      } finally {
        await fh.close();
      }
    }
    return readFile(res.abs, "utf8");
  },
};
