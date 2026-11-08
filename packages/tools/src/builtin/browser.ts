import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import type { BrowserAction } from "../browser/manager.js";
import { assertWritable, displayPath, resolveWorkPathChecked } from "../workspace-paths.js";

/**
 * Chuẩn hóa tên file thành slug tiếng Việt không dấu (a-z0-9-), cắt gọn ở ranh giới từ
 * để tên file luôn có ý nghĩa và không quá dài.
 */
function toCleanFileSlug(raw: string, maxLen = 95): string {
  const withoutExt = raw.trim().replace(/\.(docx|doc|pdf|xlsx|xls|zip|rar|txt)$/i, "");
  const slug = withoutExt
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "tai-lieu";
  if (slug.length <= maxLen) return slug;
  const cut = slug.slice(0, maxLen);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 35 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "") || "tai-lieu";
}

/**
 * Dựng đường dẫn file tải về không trùng lặp trong thư mục đích:
 * nếu `<slug>.<ext>` đã tồn tại thì tự động đổi tên thành `<slug>-1.<ext>`, `<slug>-2.<ext>`...
 */
function resolveUniqueDownloadTarget(
  dirAbs: string,
  desiredName: string | undefined,
  suggestedFilename: string,
): { absPath: string; finalName: string; baseName: string; renamed: boolean } {
  const suggestedExt = extname(suggestedFilename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const desiredExt = desiredName ? extname(desiredName).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  const ext = suggestedExt || desiredExt || ".bin";
  const stem = toCleanFileSlug(desiredName?.trim() || suggestedFilename || "tai-lieu");
  const baseName = `${stem}${ext}`;
  let finalName = baseName;
  let absPath = join(dirAbs, finalName);
  let counter = 1;
  while (existsSync(absPath)) {
    finalName = `${stem}-${counter}${ext}`;
    absPath = join(dirAbs, finalName);
    counter += 1;
  }
  return { absPath, finalName, baseName, renamed: finalName !== baseName };
}

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
  saveTo: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Thư mục lưu file tải về khi click nút tải file (vd "." = thư mục làm việc, "thu-vien" = thư viện file của agent).',
    ),
  fileName: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Tên file mong muốn khi tải về (chuẩn slug có ý nghĩa theo tên văn bản; hệ thống tự giữ đuôi gốc .docx/.doc/.pdf và tự thêm -1, -2 nếu file đã tồn tại).",
    ),
  report: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Tin nhắn báo cáo tiến độ gửi trực tiếp cho người dùng ngay ở bước này (vd: 'Đã truy cập vbpl.vn và thấy 10 văn bản mới... Đang mở văn bản số 1...').",
    ),
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
    "TẢI FILE: click nút tải kèm saveTo (vd \".\" thư mục làm việc, \"thu-vien\" thư viện của agent nếu được ghi) và fileName có ý nghĩa — " +
    "file được lưu lại (tên chuẩn hóa không dấu, giữ đuôi gốc, trùng thì thêm -1, -2), rồi đọc bằng read_document hoặc gửi bằng send_file. " +
    "Việc nhiều bước thì điền report (một câu báo tiến độ) để người dùng thấy đang làm tới đâu. " +
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
        a = {
          action: "click",
          ref: need(args.ref, "ref"),
          ...(args.saveTo || args.fileName ? { expectDownload: true } : {}),
        };
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
    if (res.download) {
      const MAX_DOWNLOAD = 100 * 1024 * 1024;
      const targetDirRaw = args.saveTo?.trim() || ".";
      const resolvedDir = await resolveWorkPathChecked(toolCtx, targetDirRaw);
      assertWritable(resolvedDir, toolCtx);
      await mkdir(resolvedDir.abs, { recursive: true });
      const target = resolveUniqueDownloadTarget(
        resolvedDir.abs,
        args.fileName,
        res.download.suggestedFilename,
      );
      await res.download.saveAs(target.absPath);
      const info = await stat(target.absPath).catch(() => null);
      if (info && info.size > MAX_DOWNLOAD) {
        await rm(target.absPath, { force: true });
        return `File tải về quá lớn (${Math.round(info.size / 1048576)} MB > 100 MB) — đã bỏ, không lưu.\n\n` + res.text;
      }
      const disp = displayPath(toolCtx, target.absPath);
      const renameNote = target.renamed
        ? ` (file "${target.baseName}" đã tồn tại nên tự động đổi tên thành "${target.finalName}")`
        : "";
      return (
        `📥 Đã tải và lưu file thành công: ${disp} (${info?.size ?? 0} bytes)${renameNote}\n\n` +
        res.text
      );
    }
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
