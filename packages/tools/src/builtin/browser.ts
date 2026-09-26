import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  url: z.string().url().describe("URL cần mở."),
  action: z.enum(["text", "title"]).default("text").describe("text = lấy nội dung; title = tiêu đề."),
});

/**
 * Duyệt web bằng trình duyệt thật (playwright-core, kết nối Chromium).
 * Cần Chromium cài sẵn (playwright install chromium) hoặc CHROME_PATH.
 * Nếu không có trình duyệt → lỗi rõ ràng (gợi ý dùng http_fetch).
 */
export const browserTool: ToolHandler<typeof schema> = {
  name: "browser",
  description:
    "Mở một trang web bằng trình duyệt thật và lấy nội dung (chạy được cả trang JS). " +
    "Nếu chỉ cần HTML tĩnh, dùng http_fetch nhanh hơn.",
  schema,
  async execute(args) {
    let chromium: typeof import("playwright-core").chromium;
    try {
      chromium = (await import("playwright-core")).chromium;
    } catch {
      throw new Error("playwright-core không nạp được");
    }
    const executablePath = process.env.CHROME_PATH;
    let browser;
    try {
      browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
      });
    } catch {
      throw new Error(
        "Không mở được Chromium. Cài: npx playwright install chromium, hoặc đặt CHROME_PATH. " +
          "Tạm thời dùng http_fetch cho trang HTML tĩnh.",
      );
    }
    try {
      const page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (args.action === "title") return await page.title();
      // Dùng string expression để tránh phụ thuộc DOM types khi typecheck
      const text = (await page.evaluate("document.body && document.body.innerText || ''")) as string;
      return text.slice(0, 16_000).trim() || "(trang không có nội dung text)";
    } finally {
      await browser.close();
    }
  },
};
