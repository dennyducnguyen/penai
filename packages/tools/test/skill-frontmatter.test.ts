import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, slugify } from "../src/skill-frontmatter.js";

describe("parseSkillFrontmatter", () => {
  it("đọc name/description/slug + tags dạng [a, b]", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: Viết email\ndescription: Soạn email bán hàng\nslug: viet-email\ntags: [email, sales]\n---\n# Hướng dẫn\nBước 1...",
    );
    expect(fm.fields.name).toBe("Viết email");
    expect(fm.fields.description).toBe("Soạn email bán hàng");
    expect(fm.fields.slug).toBe("viet-email");
    expect(fm.tags).toEqual(["email", "sales"]);
    expect(fm.body.startsWith("# Hướng dẫn")).toBe(true);
  });

  it("đọc tags dạng danh sách gạch đầu dòng", () => {
    const fm = parseSkillFrontmatter("---\nname: X\ntags:\n  - a\n  - b\n---\nnội dung");
    expect(fm.tags).toEqual(["a", "b"]);
  });

  it("bỏ dấu nháy quanh giá trị", () => {
    const fm = parseSkillFrontmatter('---\nname: "Có: dấu hai chấm"\n---\nx');
    expect(fm.fields.name).toBe("Có: dấu hai chấm");
  });

  it("không có frontmatter → body là toàn bộ nội dung", () => {
    const fm = parseSkillFrontmatter("# Chỉ là markdown\nnội dung");
    expect(fm.fields).toEqual({});
    expect(fm.tags).toEqual([]);
    expect(fm.body).toBe("# Chỉ là markdown\nnội dung");
  });

  it("chịu được CRLF", () => {
    const fm = parseSkillFrontmatter("---\r\nname: A\r\ndescription: B\r\n---\r\nnội dung");
    expect(fm.fields.name).toBe("A");
    expect(fm.fields.description).toBe("B");
    expect(fm.body).toBe("nội dung");
  });
});

describe("slugify", () => {
  it("bỏ dấu tiếng Việt và chuẩn hóa", () => {
    expect(slugify("Viết Email Chuyên Nghiệp")).toBe("viet-email-chuyen-nghiep");
    expect(slugify("Báo cáo tuần / tháng")).toBe("bao-cao-tuan-thang");
    expect(slugify("Đơn hàng")).toBe("don-hang");
  });
});
