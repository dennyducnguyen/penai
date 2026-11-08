/** Trình soạn tách đôi: ánh xạ dòng mã ↔ vị trí bản xem (cuộn song song, bấm nhảy) — hàm thuần, không DOM. */
import { describe, expect, it } from "vitest";
import { lineInBlock, lineToOffset, normalizeAnchors, offsetToLine, prepareMarkdownSource } from "../src/md-linemap.js";

const A = normalizeAnchors([{ line: 0, top: 0 }, { line: 4, top: 100 }, { line: 10, top: 400 }, { line: 4, top: 120 }, { line: 7, top: 0 /* phần tử ẩn */ }, { line: 20, top: 500 }]);

describe("md-linemap", () => {
  it("chuẩn hóa mốc: một mốc mỗi dòng, bỏ mốc đi lùi", () => {
    expect(A).toEqual([{ line: 0, top: 0 }, { line: 4, top: 100 }, { line: 10, top: 400 }, { line: 20, top: 500 }]);
  });
  it("nội suy hai chiều và khứ hồi", () => {
    expect(lineToOffset(A, 4)).toBe(100);
    expect(lineToOffset(A, 7)).toBe(250);
    expect(lineToOffset(A, 15)).toBe(450);
    expect(lineToOffset(A, 99)).toBe(500);
    expect(offsetToLine(A, 250)).toBe(7);
    expect(offsetToLine(A, 50)).toBe(2);
    for (const l of [0, 1.5, 4, 6.25, 12, 19]) expect(offsetToLine(A, lineToOffset(A, l))).toBeCloseTo(l, 6);
    expect(lineToOffset([], 3)).toBe(0);
    expect(offsetToLine([], 3)).toBe(0);
  });
  it("bấm trong khối nhiều dòng → dòng theo tỉ lệ", () => {
    expect(lineInBlock(10, 20, 0, 200)).toBe(10);
    expect(lineInBlock(10, 20, 100, 200)).toBe(15);
    expect(lineInBlock(10, 20, 500, 200)).toBe(19);
    expect(lineInBlock(3, 3, 5, 0)).toBe(3);
  });
  it("frontmatter thành khối rào, giữ đúng số dòng", () => {
    const src = "---\nname: x\nagents: [a]\n---\n# Tiêu đề\n";
    const out = prepareMarkdownSource(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.startsWith("```frontmatter\nname: x")).toBe(true);
    expect(prepareMarkdownSource("# không có\n")).toBe("# không có\n");
  });
});
