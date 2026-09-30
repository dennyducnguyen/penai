import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildXlsx, safeSheetName, xmlEscape } from "../src/xlsx.js";

describe("buildXlsx — file Excel tối giản", () => {
  it("đủ các phần bắt buộc, nhiều sheet, tên sheet hợp lệ", () => {
    const buf = buildXlsx([
      { name: "Contacts", rows: [["A", "B"], ["x", 1]] },
      { name: "Danh bạ Zalo - zalo/nmd:[1]", rows: [["Tên"]] },
    ]);
    const zip = new AdmZip(buf);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
      ].sort(),
    );
    const wb = zip.readAsText("xl/workbook.xml");
    expect(wb).toContain('name="Contacts"');
    expect(wb).toContain('name="Danh bạ Zalo - zalo nmd  1"');
  });

  it("uid Zalo 19 chữ số và SĐT 0 đầu giữ nguyên dạng chữ; ngày giờ thành số serial", () => {
    const zip = new AdmZip(buildXlsx([{ name: "S", rows: [["uid", "sđt", "lúc"], ["1498938896179704755", "0907253168", new Date("2026-09-30T00:00:00Z")]] }]));
    const xml = zip.readAsText("xl/worksheets/sheet1.xml");
    expect(xml).toContain("<t xml:space=\"preserve\">1498938896179704755</t>");
    expect(xml).toContain("<t xml:space=\"preserve\">0907253168</t>");
    expect(xml).toMatch(/<c r="C2" s="2"><v>46295\.29/);
    expect(xml).toContain('<pane ySplit="1"');
  });

  it("thoát ký tự XML + bỏ ký tự điều khiển", () => {
    expect(xmlEscape('a<b>&"c"\u0001')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
    const used = new Set<string>();
    expect(safeSheetName("Contacts", used)).toBe("Contacts");
    expect(safeSheetName("contacts", used)).toBe("contacts (2)");
    expect(safeSheetName("x".repeat(40), used)).toHaveLength(31);
  });
});
