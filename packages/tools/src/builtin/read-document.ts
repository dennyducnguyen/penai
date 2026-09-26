import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import { resolveWorkPathChecked } from "../workspace-paths.js";

const MAX_DOC_BYTES = 25 * 1024 * 1024;

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Đường dẫn file trong workspace: pdf, docx, xlsx/xls, csv, txt, md, json..."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Bỏ qua bấy nhiêu ký tự đầu — đọc tiếp phần sau của tài liệu dài."),
  maxChars: z.number().int().min(100).max(50_000).default(15_000),
});

function extOf(p: string): string {
  return p.split(".").pop()?.toLowerCase() ?? "";
}

/** Trích text theo định dạng — thư viện JS thuần, không cần Python/LibreOffice. */
async function extractText(ext: string, buf: Buffer): Promise<string> {
  if (ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const res = await parser.getText();
      return res.text;
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const res = await mammoth.extractRawText({ buffer: buf });
    return res.value;
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      parts.push(`## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`);
    }
    return parts.join("\n\n");
  }
  if (ext === "doc" || ext === "ppt" || ext === "pptx") {
    throw new Error(
      `Định dạng .${ext} chưa hỗ trợ trích text trực tiếp — nhờ người dùng gửi bản PDF/docx/xlsx.`,
    );
  }
  // Còn lại coi là file text (txt, md, csv, json, log...) — kiểm tra nhị phân
  const sample = buf.subarray(0, 4096);
  let nul = 0;
  for (const b of sample) if (b === 0) nul++;
  if (nul > 8) throw new Error(`File .${ext || "?"} có vẻ là nhị phân — không đọc dạng text được`);
  return buf.toString("utf8");
}

/**
 * Trích text từ file văn phòng theo TÊN FILE (pdf/docx/xlsx/xls/txt/md/csv/json...).
 * Dùng chung cho tool read_document và upload tài liệu vào Kho tri thức.
 */
export async function extractDocumentText(fileName: string, buf: Buffer): Promise<string> {
  if (buf.length > MAX_DOC_BYTES) throw new Error("File quá 25MB");
  return (await extractText(extOf(fileName), buf)).trim();
}

/**
 * Đọc nội dung tài liệu (PDF/Word/Excel/text) trong workspace, trả text theo
 * trang cửa sổ offset/maxChars — tài liệu trăm trang không nuốt hết context,
 * model gọi lại với offset để đọc tiếp.
 */
export const readDocumentTool: ToolHandler<typeof schema> = {
  name: "read_document",
  description:
    "Đọc nội dung tài liệu trong workspace: PDF, Word (docx), Excel (xlsx/xls → CSV từng sheet), " +
    "text/csv/json. Tài liệu dài: kết quả bị cắt theo maxChars — gọi lại với offset để đọc tiếp.",
  schema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    const buf = await readFile(res.abs).catch(() => {
      throw new Error(`Không đọc được file: ${res.display}`);
    });
    if (buf.length > MAX_DOC_BYTES) throw new Error("File quá 25MB");
    const text = (await extractText(extOf(res.abs), buf)).trim();
    if (!text) return `(Tài liệu ${res.display} không có text trích được)`;
    const slice = text.slice(args.offset, args.offset + args.maxChars);
    const end = args.offset + slice.length;
    const header = `[${res.display} — ${text.length} ký tự, đang hiển thị ${args.offset}..${end}]`;
    const footer =
      end < text.length
        ? `\n\n[... còn ${text.length - end} ký tự — gọi read_document với offset=${end} để đọc tiếp]`
        : "";
    return `${header}\n${slice}${footer}`;
  },
};
