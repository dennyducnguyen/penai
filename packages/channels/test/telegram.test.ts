import { describe, expect, it } from "vitest";
import { chunkText } from "../src/telegram.js";
import { isChannelKindSupported, supportedChannelKinds } from "../src/manager.js";

describe("chunkText (Telegram 4096 limit)", () => {
  it("text ngắn giữ nguyên", () => {
    expect(chunkText("xin chào")).toEqual(["xin chào"]);
  });

  it("text dài chia nhiều đoạn <= max", () => {
    const long = "dòng\n".repeat(2000); // ~10000 ký tự
    const parts = chunkText(long, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    // ghép lại (bỏ khoảng trắng) không mất nội dung
    expect(parts.join("").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
  });

  it("ưu tiên cắt theo dòng", () => {
    const text = "A".repeat(4000) + "\n" + "B".repeat(4000);
    const parts = chunkText(text, 4096);
    expect(parts[0]).toBe("A".repeat(4000));
  });
});

describe("channel manager", () => {
  it("telegram được hỗ trợ", () => {
    expect(isChannelKindSupported("telegram")).toBe(true);
    expect(isChannelKindSupported("khong-ton-tai")).toBe(false);
    expect(supportedChannelKinds()).toContain("telegram");
  });
});
