import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import type { BrowserAction } from "../browser/manager.js";

const schema = z.object({
  action: z
    .enum(["open", "snapshot", "text", "click", "type", "select", "press", "scroll", "back", "wait", "screenshot", "close", "title"])
    .default("snapshot")
    .describe(
      "open = mở url · snapshot = xem lại trang (danh sách phần tử có ref + chữ) · text = đọc thêm chữ (offset) · " +
        "click/type/select = thao tác lên phần tử theo ref · press = nhấn phím · scroll = cuộn (direction hoặc ref) · " +
        "back = quay lại · wait = chờ (ms hoặc chờ chữ xuất hiện) · screenshot = chụp màn hình để bạn XEM ảnh · close = đóng trình duyệt.",
    ),
  url: z.string().max(2000).optional().describe("Địa chỉ trang (action open)."),
  ref: z
    .string()
    .max(10)
    .optional()
    .describe('Mã phần tử lấy từ kết quả lần trước, vd "e12" (click, type, select, scroll tới phần tử).'),
  text: z.string().max(4000).optional().describe("Chữ cần gõ (type) hoặc chữ cần chờ xuất hiện (wait)."),
  submit: z.boolean().optional().describe("type: gõ xong nhấn Enter (tìm kiếm, gửi form)."),
  value: z.string().max(200).optional().describe("select: nhãn hoặc giá trị lựa chọn."),
  key: z.string().max(40).optional().describe('press: tên phím, vd "Enter", "Escape", "Tab", "PageDown".'),
  direction: z.enum(["down", "up"]).optional().describe("scroll: hướng cuộn (mặc định down, ~1 màn hình)."),
  offset: z.number().int().min(0).optional().describe("text: đọc từ ký tự thứ N (lấy số từ gợi ý 'đọc tiếp')."),
  ms: z.number().int().min(0).max(20000).optional().describe("wait: số mili giây chờ."),
  fullPage: z.boolean().optional().describe("screenshot: chụp cả trang dài thay vì một màn hình."),
});

const NOT_AVAILABLE =
  "Trình duyệt chưa bật trong ngữ cảnh này. Dùng http_fetch cho trang HTML tĩnh, hoặc nhờ quản trị viên kiểm tra Dashboard → Trình duyệt.";

/**
 * Trình duyệt thật (Chromium chạy ngầm) giữ trang mở suốt cuộc trò chuyện: agent mở
 * trang, đọc danh sách phần tử (mỗi phần tử một ref), rồi bấm/gõ/chọn/cuộn theo ref,
 * chụp màn hình để tự xem. Cookie đăng nhập sẵn lấy từ hồ sơ trình duyệt quản trị
 * viên gán cho agent (Dashboard → Trình duyệt) — agent không đọc được giá trị cookie.
 */
export const browserTool: ToolHandler<typeof schema> = {
  name: "browser",
  description:
    "Dùng trình duyệt web thật (chạy được trang JavaScript như Shopee, Lazada, trang quản trị) và GIỮ trang mở giữa các lần gọi " +
    "để làm nhiều bước: open url → đọc kết quả (mỗi nút/ô nhập/link có ref như e12) → click/type/select theo ref → " +
    "scroll để xem thêm → screenshot khi cần nhìn bố cục/hình ảnh. Mỗi thao tác trả về trang mới nhất kèm ref MỚI — " +
    "luôn dùng ref của kết quả gần nhất. Nếu agent được gán hồ sơ trình duyệt thì đã đăng nhập sẵn các trang trong hồ sơ. " +
    "Trước khi bấm nút có hậu quả thật (đặt hàng, thanh toán, gửi, xóa, đăng bài) phải hỏi người dùng xác nhận. " +
    "Gặp CAPTCHA/trang xác minh thì dừng và báo người dùng. Xong việc gọi action close. " +
    "Chỉ cần đọc trang HTML tĩnh thì http_fetch nhanh hơn.",
  schema,
  async execute(args, toolCtx) {
    if (!toolCtx.browser) return NOT_AVAILABLE;
    const need = (v: string | undefined, what: string): string => {
      if (!v) throw new Error(`action "${args.action}" cần tham số ${what}`);
      return v;
    };
    let a: BrowserAction;
    switch (args.action) {
      case "open":
        a = { action: "open", url: need(args.url, "url") };
        break;
      case "title":
      case "text":
        // Tương thích bản cũ: {url, action:"text"|"title"} = mở rồi đọc
        if (args.url) {
          const opened = await toolCtx.browser.act({ action: "open", url: args.url });
          if (args.action === "title") return opened.text.split("\n").slice(0, 2).join("\n");
        }
        a = { action: "text", ...(args.offset !== undefined ? { offset: args.offset } : {}) };
        break;
      case "snapshot":
        a = args.url ? { action: "open", url: args.url } : { action: "snapshot" };
        break;
      case "click":
        a = { action: "click", ref: need(args.ref, "ref") };
        break;
      case "type":
        a = {
          action: "type",
          ref: need(args.ref, "ref"),
          text: args.text ?? "",
          ...(args.submit ? { submit: true } : {}),
        };
        break;
      case "select":
        a = { action: "select", ref: need(args.ref, "ref"), value: need(args.value, "value") };
        break;
      case "press":
        a = { action: "press", key: need(args.key, "key") };
        break;
      case "scroll":
        a = {
          action: "scroll",
          ...(args.direction ? { direction: args.direction } : {}),
          ...(args.ref ? { ref: args.ref } : {}),
        };
        break;
      case "back":
        a = { action: "back" };
        break;
      case "wait":
        a = {
          action: "wait",
          ...(args.ms !== undefined ? { ms: args.ms } : {}),
          ...(args.text ? { text: args.text } : {}),
        };
        break;
      case "screenshot":
        a = { action: "screenshot", ...(args.fullPage ? { fullPage: true } : {}) };
        break;
      case "close":
        a = { action: "close" };
        break;
    }
    const res = await toolCtx.browser.act(a);
    if (!res.image) return res.text;
    // Lưu ảnh vào thư mục làm việc (agent gửi được cho người dùng bằng send_file)
    // và đưa ảnh cho mô hình xem ở bước kế tiếp.
    const dir = join(toolCtx.workDir ?? toolCtx.workspaceDataDir, "browser");
    await mkdir(dir, { recursive: true });
    const name = `man-hinh-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}.jpg`;
    await writeFile(join(dir, name), res.image);
    toolCtx.showImage?.(`data:image/jpeg;base64,${res.image.toString("base64")}`);
    return (
      `${res.text}
Đã lưu ảnh: browser/${name} (gửi cho người dùng bằng send_file nếu cần).
` +
      (toolCtx.showImage
        ? "Ảnh chụp được đính kèm ngay sau kết quả này để bạn xem (mô hình không xem được ảnh thì dùng snapshot/text)."
        : "Ngữ cảnh này không đưa ảnh cho mô hình xem được — dùng action snapshot/text để đọc nội dung.")
    );
  },
};
