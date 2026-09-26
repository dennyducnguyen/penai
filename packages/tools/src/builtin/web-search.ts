import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  query: z.string().min(1).describe("Câu truy vấn tìm kiếm."),
  limit: z.number().int().min(1).max(10).default(5),
});

/**
 * Tìm kiếm web. Dùng provider `webSearch` trong ToolContext nếu có cấu hình
 * (vd Brave API); nếu không thì fallback DuckDuckGo Instant Answer (miễn phí,
 * không cần key) — chỉ trả abstract, phù hợp tra cứu nhanh.
 */
export const webSearchTool: ToolHandler<typeof schema> = {
  name: "web_search",
  description: "Tìm kiếm thông tin trên web.",
  schema,
  async execute(args, toolCtx) {
    if (toolCtx.webSearch) {
      return toolCtx.webSearch(args.query, args.limit);
    }
    // Fallback: DuckDuckGo Instant Answer API (không cần key)
    const url =
      "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(args.query);
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`DuckDuckGo lỗi ${res.status}`);
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const parts: string[] = [];
    if (data.AbstractText) {
      parts.push(`${data.Heading ?? args.query}: ${data.AbstractText}`);
      if (data.AbstractURL) parts.push(`Nguồn: ${data.AbstractURL}`);
    }
    for (const t of (data.RelatedTopics ?? []).slice(0, args.limit)) {
      if (t.Text) parts.push(`• ${t.Text}${t.FirstURL ? " — " + t.FirstURL : ""}`);
    }
    return parts.length
      ? parts.join("\n")
      : `Không tìm thấy kết quả tóm tắt cho "${args.query}". Thử dùng http_fetch với một URL cụ thể.`;
  },
};
