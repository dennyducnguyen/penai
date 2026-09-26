import { describe, expect, it } from "vitest";
import { recallTerms } from "../src/memory-repo.js";

describe("recallTerms (từ khóa dò trí nhớ)", () => {
  it("bỏ hư từ trong câu hỏi tự nhiên", () => {
    expect(recallTerms("Cho tôi biết chính sách đổi trả").terms).toEqual(["chính", "sách", "đổi", "trả"]);
  });

  it("ngưỡng khớp: 1 khi ít từ, nửa số từ khi nhiều, tối đa 3", () => {
    expect(recallTerms("bảo hành").minMatch).toBe(1);
    expect(recallTerms("ngân sách quảng cáo").minMatch).toBe(2);
    expect(recallTerms("một hai ba bốn năm sáu bảy tám chín mười").minMatch).toBe(3);
  });

  it("chỉ giữ chữ và số, bỏ trùng, tối đa 12 từ", () => {
    expect(recallTerms("giá: 50k!! (giá) 'x' | & ! y").terms).toEqual(["giá", "50k", "x", "y"]);
    expect(recallTerms(Array.from({ length: 30 }, (_, i) => `tu${i}`).join(" ")).terms).toHaveLength(12);
  });

  it("câu chỉ có hư từ → không dò", () => {
    expect(recallTerms("cho tôi hỏi với").terms).toEqual([]);
  });
});
