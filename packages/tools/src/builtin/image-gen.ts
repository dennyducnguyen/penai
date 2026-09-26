import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ImageRouter, openAIImageBackend } from "@penai/providers";
import type { ToolHandler } from "../registry.js";
import { workDirOf, resolveWorkPathChecked } from "../workspace-paths.js";

const MAX_REF_IMAGES = 5;
const MAX_REF_BYTES = 10 * 1024 * 1024;

const schema = z.object({
  prompt: z.string().min(1).describe("Mô tả hình ảnh cần tạo."),
  size: z
    .enum(["1024x1024", "1536x1024", "1024x1536"])
    .optional()
    .describe("Bỏ trống: sửa ảnh (có refImages) thì giữ khung ảnh gốc, tạo mới thì 1024x1024."),
  aspectRatio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/)
    .optional()
    .describe("Tỷ lệ khung, vd 16:9, 9:16, 4:5, 1:1 — có thì thắng size."),
  filename: z.string().default("image.png"),
  refImages: z
    .array(z.string())
    .max(MAX_REF_IMAGES)
    .optional()
    .describe(
      "Đường dẫn các file ảnh trong workspace dùng làm ảnh tham chiếu " +
        "(vd ảnh người dùng vừa gửi: anh-nhan-*.jpg) — tạo/sửa ảnh dựa trên chúng.",
    ),
  provider: z
    .enum(["auto", "antigravity", "codex"])
    .default("auto")
    .describe(
      "Nơi tạo ảnh. auto (mặc định) = Antigravity trước, lỗi/bận thì ChatGPT (codex). " +
      "Chỉ chọn codex/antigravity khi người dùng yêu cầu rõ.",
    ),
  publish: z
    .boolean()
    .optional()
    .describe(
      "Bật khi cần URL ảnh HTTPS trực tiếp để nhúng landing page/dịch vụ ngoài. " +
        "Link mặc định bền 10 năm và có thể bị admin thu hồi.",
    ),
  publishTtlHours: z
    .number()
    .min(1)
    .max(24 * 365 * 10)
    .optional()
    .describe("Thời hạn URL công khai; mặc định 10 năm khi publish=true."),
});

function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

/** Đọc các ảnh tham chiếu (trong jail workspace) thành data URL. */
async function loadRefImages(
  toolCtx: Parameters<ToolHandler["execute"]>[1],
  paths: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const res = await resolveWorkPathChecked(toolCtx, p);
    const buf = await readFile(res.abs).catch(() => null);
    if (!buf) throw new Error(`Không đọc được ảnh tham chiếu: ${res.display}`);
    if (buf.length > MAX_REF_BYTES) throw new Error(`Ảnh ${res.display} quá 10MB`);
    out.push(`data:${mimeOf(res.abs)};base64,${buf.toString("base64")}`);
  }
  return out;
}

/**
 * Tạo ảnh: lõi nằm ở ImageRouter (packages/providers/src/images) — dùng chung
 * với route API /v1/images/*, nên tool và API không bao giờ lệch hành vi.
 * Thứ tự ứng viên do runtime dựng (toolCtx.generateImage): Antigravity → codex,
 * qua ProviderGate. OPENAI_API_KEY (Images API gpt-image-1) chỉ còn là dự phòng
 * cuối khi provider=auto.
 * Lưu file vào thư mục làm việc (đuôi theo định dạng thật: agy trả JPEG). Kết
 * quả kèm marker [[media:path]] để channel gửi ảnh cho người dùng.
 */
export const imageGenTool: ToolHandler<typeof schema> = {
  name: "image_generation",
  description:
    "Tạo hình ảnh từ mô tả văn bản. Có thể kèm refImages (đường dẫn ảnh trong " +
    "workspace, vd ảnh người dùng đã gửi) để tạo/sửa ảnh dựa trên ảnh mẫu. " +
    "Bật publish để nhận URL ảnh trực tiếp phù hợp nhúng vào landing page.",
  schema,
  async execute(args, toolCtx) {
    const refImages = args.refImages?.length ? await loadRefImages(toolCtx, args.refImages) : [];
    // Không ghi size: sửa ảnh giữ khung ảnh gốc (provider tự đọc), tạo mới vẫn vuông như cũ.
    const size = args.size ?? (refImages.length || args.aspectRatio ? undefined : "1024x1024");
    const req = {
      prompt: args.prompt,
      ...(size ? { size } : {}),
      ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
      ...(refImages.length ? { refImages } : {}),
    };
    const apiKey = process.env.OPENAI_API_KEY;
    const viaOpenAI = () => new ImageRouter([openAIImageBackend(apiKey!)]).generate(req);

    let img: { data: Buffer; mime: string; route?: string };
    if (toolCtx.generateImage) {
      try {
        img = await toolCtx.generateImage({
          ...req,
          ...(args.provider !== "auto" ? { provider: args.provider } : {}),
        });
      } catch (err) {
        if (!apiKey || args.provider !== "auto") throw err;
        img = await viaOpenAI();
      }
    } else if (apiKey) {
      img = await viaOpenAI();
    } else {
      throw new Error("Chưa cấu hình tạo ảnh: cần đăng nhập Antigravity / ChatGPT hoặc OPENAI_API_KEY");
    }

    const ext = img.mime.includes("jpeg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
    const base = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.(png|jpe?g|webp|gif)$/i, "");
    const name = `${base || "image"}.${ext}`;
    const path = join(workDirOf(toolCtx), name);
    await writeFile(path, img.data);
    let publicLine = "";
    if (args.publish) {
      if (!toolCtx.publishFile) {
        publicLine = "\nChưa tạo được URL công khai: hệ thống thiếu PENAI_PUBLIC_URL.";
      } else {
        const published = await toolCtx.publishFile(path, {
          ttlSeconds: (args.publishTtlHours ?? 24 * 365 * 10) * 3600,
          fileName: name,
        });
        publicLine = `\nURL ảnh trực tiếp (hết hạn ${published.expiresAt}): ${published.url}`;
      }
    }
    return `Đã tạo ảnh: ${name}${img.route ? ` (qua ${img.route})` : ""}${publicLine}
[[media:${path}]]`;
  },
};
