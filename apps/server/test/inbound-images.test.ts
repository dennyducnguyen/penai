import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extOfDataUrl,
  mergeMediaText,
  saveInboundImages,
} from "../src/channels-runtime.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("extOfDataUrl", () => {
  it("map mime → đuôi file", () => {
    expect(extOfDataUrl("data:image/jpeg;base64,xx")).toBe("jpg");
    expect(extOfDataUrl("data:image/png;base64,xx")).toBe("png");
    expect(extOfDataUrl("data:image/webp;base64,xx")).toBe("webp");
    expect(extOfDataUrl("khong-phai-dataurl")).toBe("jpg");
  });
});

describe("saveInboundImages", () => {
  it("lưu ảnh thành file anh-nhan-*.png trong thư mục người gửi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "penai-img-"));
    const saved = await saveInboundImages(dir, [
      { kind: "photo", dataUrl: `data:image/png;base64,${PNG_1PX}` },
      { kind: "photo", dataUrl: `data:image/jpeg;base64,${PNG_1PX}` },
      { kind: "photo" }, // không có dataUrl → bỏ qua
    ]);
    expect(saved.length).toBe(2);
    expect(saved[0]!.name).toMatch(/^anh-nhan-\d{4}-\d{6}-1\.png$/);
    expect(saved[1]!.name).toMatch(/\.jpg$/);
    expect(existsSync(saved[0]!.path)).toBe(true);
    // nội dung đúng là ảnh gốc (roundtrip base64)
    const buf = await readFile(saved[0]!.path);
    expect(buf.toString("base64")).toBe(PNG_1PX);
  });
});

describe("saveInboundDocs", () => {
  it("giữ tên gốc, trùng tên thì thêm hậu tố (không ghi đè)", async () => {
    const { saveInboundDocs } = await import("../src/channels-runtime.js");
    const dir = await mkdtemp(join(tmpdir(), "penai-doc-"));
    const b64 = Buffer.from("noi dung pdf gia").toString("base64");
    const s1 = await saveInboundDocs(dir, [{ kind: "document", name: "bao cao.pdf", dataB64: b64 }]);
    const s2 = await saveInboundDocs(dir, [{ kind: "document", name: "bao cao.pdf", dataB64: b64 }]);
    expect(s1[0]!.name).toBe("bao cao.pdf");
    expect(s2[0]!.name).toBe("bao cao-2.pdf");
    expect(existsSync(s2[0]!.path)).toBe(true);
  });
  it("tên nguy hiểm bị làm sạch", async () => {
    const { saveInboundDocs, safeDocName } = await import("../src/channels-runtime.js");
    expect(safeDocName("../../etc/passwd")).toBe("passwd");
    expect(safeDocName("a\\b\\há»£p Ä‘á»“ng.docx")).toMatch(/docx$/);
    const dir = await mkdtemp(join(tmpdir(), "penai-doc2-"));
    const s = await saveInboundDocs(dir, [
      { kind: "document", name: "../../x.pdf", dataB64: Buffer.from("x").toString("base64") },
    ]);
    expect(s[0]!.name).toBe("x.pdf");
    expect(s[0]!.path.startsWith(dir)).toBe(true);
  });
});

describe("mergeMediaText", () => {
  it("document đã lưu → placeholder chỉ dẫn read_document", () => {
    const out = mergeMediaText(
      "",
      [{ kind: "document", name: "bao-cao.pdf", dataB64: "eA==" }],
      [],
      ["bao-cao.pdf"],
    );
    expect(out).toContain("đã lưu tại: bao-cao.pdf");
    expect(out).toContain("read_document");
  });
  it("file text inline vẫn kèm tên đã lưu", () => {
    const out = mergeMediaText(
      "phân tích",
      [{ kind: "document", name: "d.csv", text: "a,b\n1,2", dataB64: "eA==" }],
      [],
      ["d.csv"],
    );
    expect(out).toContain("a,b");
    expect(out).toContain("đã lưu tại: d.csv");
  });
  it("ảnh đã lưu → placeholder ghi rõ tên file (model tham chiếu lại được)", () => {
    const out = mergeMediaText(
      "tạo ảnh quảng cáo",
      [
        { kind: "photo", dataUrl: "data:image/jpeg;base64,x" },
        { kind: "photo", dataUrl: "data:image/jpeg;base64,y" },
      ],
      ["anh-nhan-0208-1.jpg", "anh-nhan-0208-2.jpg"],
    );
    expect(out).toContain("tạo ảnh quảng cáo");
    expect(out).toContain("đã lưu tại: anh-nhan-0208-1.jpg");
    expect(out).toContain("đã lưu tại: anh-nhan-0208-2.jpg");
  });
  it("không có tên đã lưu → placeholder cũ, không vỡ", () => {
    const out = mergeMediaText("x", [{ kind: "photo", dataUrl: "data:image/jpeg;base64,x" }]);
    expect(out).toContain("[Người dùng gửi kèm 1 ảnh]");
  });
});
