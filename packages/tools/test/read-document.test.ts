import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { readDocumentTool } from "../src/builtin/read-document.js";
import type { ToolContext } from "../src/registry.js";

async function makeCtx(): Promise<{ toolCtx: ToolContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "penai-readdoc-"));
  return {
    dir,
    toolCtx: { ctx: { workspaceId: "ws", userId: "u", role: "ws_admin" }, workspaceDataDir: dir },
  };
}

/** PDF tối giản hợp lệ (tự tính offset xref) chứa 1 dòng text. */
function buildPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "", // 4: content stream — điền sau
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

/** DOCX tối giản (zip OOXML) chứa 2 đoạn văn. */
function buildDocx(paragraphs: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ),
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

describe("read_document (JS thuần: pdf-parse / mammoth / xlsx)", () => {
  it("PDF → trích text", async () => {
    const { toolCtx, dir } = await makeCtx();
    await writeFile(join(dir, "bao-cao.pdf"), buildPdf("Doanh thu quy 3 tang 25 phan tram"));
    const out = await readDocumentTool.execute(
      { path: "bao-cao.pdf", offset: 0, maxChars: 15_000 },
      toolCtx,
    );
    expect(out).toContain("Doanh thu quy 3");
    expect(out).toContain("bao-cao.pdf");
  });

  it("DOCX → trích text", async () => {
    const { toolCtx, dir } = await makeCtx();
    await writeFile(
      join(dir, "hop-dong.docx"),
      buildDocx(["Điều 1: Bên A thuê bên B", "Điều 2: Giá trị 500 triệu đồng"]),
    );
    const out = await readDocumentTool.execute(
      { path: "hop-dong.docx", offset: 0, maxChars: 15_000 },
      toolCtx,
    );
    expect(out).toContain("Điều 1: Bên A thuê bên B");
    expect(out).toContain("500 triệu");
  });

  it("XLSX → CSV từng sheet", async () => {
    const { toolCtx, dir } = await makeCtx();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Tháng", "Doanh thu"],
        ["7", 120],
        ["8", 150],
      ]),
      "DoanhThu",
    );
    await writeFile(join(dir, "so-lieu.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const out = await readDocumentTool.execute(
      { path: "so-lieu.xlsx", offset: 0, maxChars: 15_000 },
      toolCtx,
    );
    expect(out).toContain("## Sheet: DoanhThu");
    expect(out).toContain("Tháng,Doanh thu");
    expect(out).toContain("8,150");
  });

  it("tài liệu dài → cắt theo maxChars + chỉ dẫn offset đọc tiếp", async () => {
    const { toolCtx, dir } = await makeCtx();
    await writeFile(join(dir, "dai.txt"), "x".repeat(500) + "CUOI");
    const out1 = await readDocumentTool.execute({ path: "dai.txt", offset: 0, maxChars: 200 }, toolCtx);
    expect(out1).toContain("offset=200");
    expect(out1).not.toContain("CUOI");
    const out2 = await readDocumentTool.execute({ path: "dai.txt", offset: 400, maxChars: 200 }, toolCtx);
    expect(out2).toContain("CUOI");
  });

  it("file nhị phân lạ → lỗi rõ; thoát jail → từ chối", async () => {
    const { toolCtx, dir } = await makeCtx();
    await writeFile(join(dir, "la.bin"), Buffer.alloc(100, 0));
    await expect(
      readDocumentTool.execute({ path: "la.bin", offset: 0, maxChars: 1000 }, toolCtx),
    ).rejects.toThrow(/nhị phân/);
    await expect(
      readDocumentTool.execute({ path: "../../etc/passwd", offset: 0, maxChars: 1000 }, toolCtx),
    ).rejects.toThrow(/ngoài/);
  });
});
