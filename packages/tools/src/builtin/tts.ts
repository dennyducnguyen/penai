import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { workDirOf } from "../workspace-paths.js";

const schema = z.object({
  text: z.string().min(1).max(4000).describe("Văn bản cần đọc thành giọng nói."),
  voice: z.string().default("alloy").describe("Giọng đọc (alloy, echo, nova...)."),
  filename: z.string().default("speech.mp3"),
});

/**
 * Text-to-speech. Dùng OpenAI Audio API (cần env OPENAI_API_KEY).
 * Lưu file mp3 vào thư mục dữ liệu workspace, trả về đường dẫn.
 * (Có thể mở rộng ElevenLabs/Edge — xem DEVIATIONS.)
 */
export const ttsTool: ToolHandler<typeof schema> = {
  name: "text_to_speech",
  description: "Chuyển văn bản thành file âm thanh (giọng nói).",
  schema,
  async execute(args, toolCtx) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Cần env OPENAI_API_KEY để dùng TTS");
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: args.voice,
        input: args.text,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`TTS lỗi ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const safeName = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(workDirOf(toolCtx), safeName);
    await writeFile(path, buf);
    return `Đã tạo âm thanh: ${safeName} (${buf.length} bytes)\n[[media:${path}]]`;
  },
};
