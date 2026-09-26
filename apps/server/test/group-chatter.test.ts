import { describe, expect, it } from "vitest";
import { bufferGroupChatter, joinGroupChatter } from "../src/channels-runtime.js";

describe("Zalo group chatter — nối tin liền trước khi tag", () => {
  it("gộp các tin cùng người gửi trong cửa sổ, bỏ tin người khác", () => {
    const key = "ch1:group:1";
    const t0 = 1_000_000;
    bufferGroupChatter(key, "A", "tin 1 của A", t0);
    bufferGroupChatter(key, "B", "tin của B", t0 + 1_000);
    bufferGroupChatter(key, "A", "tin 2 của A", t0 + 2_000);
    const joined = joinGroupChatter(key, "A", "Anh A", "câu hỏi chính?", t0 + 10_000);
    expect(joined).toContain("tin 1 của A");
    expect(joined).toContain("tin 2 của A");
    expect(joined).toContain("câu hỏi chính?");
    expect(joined).not.toContain("tin của B");
    // đã tiêu thụ — tag lần nữa không lặp lại ngữ cảnh cũ
    const again = joinGroupChatter(key, "A", "Anh A", "hỏi tiếp", t0 + 11_000);
    expect(again).toBe("hỏi tiếp");
  });

  it("tin quá cửa sổ 60 giây không được nối", () => {
    const key = "ch1:group:2";
    const t0 = 5_000_000;
    bufferGroupChatter(key, "A", "tin cũ", t0);
    const joined = joinGroupChatter(key, "A", undefined, "hỏi mới", t0 + 61_000);
    expect(joined).toBe("hỏi mới");
    // trong cửa sổ thì vẫn nối bình thường
    bufferGroupChatter(key, "A", "tin mới", t0 + 100_000);
    expect(joinGroupChatter(key, "A", "A", "hỏi", t0 + 155_000)).toContain("tin mới");
  });

  it("không có tin đệm → trả nguyên văn", () => {
    expect(joinGroupChatter("ch1:group:3", "A", "A", "xin chào")).toBe("xin chào");
  });
});
