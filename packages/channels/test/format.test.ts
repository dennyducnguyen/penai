import { describe, it, expect } from "vitest";
import {
  markdownToTelegramHtml,
  chunkHtml,
  stripToPlain,
} from "../src/format.js";
import {
  resolveReactionEmoji,
  StatusReactionController,
  REACTION_DEBOUNCE_MS,
} from "../src/status-reactions.js";
import { TypingController } from "../src/typing.js";

describe("markdownToTelegramHtml", () => {
  it("chuyển bold/italic/code", () => {
    const html = markdownToTelegramHtml("**đậm** và *nghiêng* và `code`");
    expect(html).toContain("<b>đậm</b>");
    expect(html).toContain("<i>nghiêng</i>");
    expect(html).toContain("<code>code</code>");
  });

  it("escape HTML trong text và code", () => {
    const html = markdownToTelegramHtml("a < b\n```\nif (a<b) {}\n```");
    expect(html).toContain("a &lt; b");
    expect(html).toContain("<pre><code>if (a&lt;b) {}</code></pre>");
  });

  it("header thành bold, list thành bullet", () => {
    const html = markdownToTelegramHtml("# Tiêu đề\n- mục 1\n- mục 2");
    expect(html).toContain("<b>Tiêu đề</b>");
    expect(html).toContain("• mục 1");
  });

  it("link markdown thành <a>", () => {
    const html = markdownToTelegramHtml("[PenAI](https://example.com/x)");
    expect(html).toContain('<a href="https://example.com/x">PenAI</a>');
  });

  it("bảng markdown thành <pre> căn cột", () => {
    const html = markdownToTelegramHtml("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toMatch(/<pre>A +B\n1 +2<\/pre>/);
  });

  it("giữ nguyên code block không xử lý inline markdown bên trong", () => {
    const html = markdownToTelegramHtml("```\n**không đậm**\n```");
    expect(html).toContain("**không đậm**");
    expect(html).not.toContain("<b>");
  });
});

describe("chunkHtml", () => {
  it("text ngắn giữ nguyên 1 chunk", () => {
    expect(chunkHtml("xin chào")).toEqual(["xin chào"]);
  });

  it("không cắt giữa <pre>", () => {
    const pre = "<pre>" + "x".repeat(1000) + "</pre>";
    const text = "a".repeat(3500) + "\n\n" + pre;
    const chunks = chunkHtml(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[1]).toBe(pre);
  });

  it("pre quá dài được cắt và đóng/mở thẻ", () => {
    const pre = "<pre><code>" + "y".repeat(9000) + "</code></pre>";
    const chunks = chunkHtml(pre, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.startsWith("<pre><code>")).toBe(true);
      expect(c.endsWith("</code></pre>")).toBe(true);
      expect(c.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe("stripToPlain", () => {
  it("gỡ markdown", () => {
    expect(stripToPlain("**a** `b` [c](https://x.vn)")).toBe("a b c (https://x.vn)");
  });
});

describe("status reactions", () => {
  it("chọn emoji đúng trạng thái", () => {
    expect(resolveReactionEmoji("queued")).toBe("👀");
    expect(resolveReactionEmoji("thinking")).toBe("🤔");
    expect(resolveReactionEmoji("tool")).toBe("✍");
    expect(resolveReactionEmoji("coding")).toBe("👨‍💻");
    expect(resolveReactionEmoji("web")).toBe("⚡");
    expect(resolveReactionEmoji("done")).toBe("👍");
    expect(resolveReactionEmoji("error")).toBe("💔");
    expect(resolveReactionEmoji("stallSoft")).toBe("🥱");
    expect(resolveReactionEmoji("stallHard")).toBe("😨");
  });

  it("terminal áp ngay, trung gian debounce", async () => {
    const applied: string[] = [];
    const rc = new StatusReactionController(async (e) => {
      applied.push(e);
    });
    rc.setStatus("thinking");
    expect(applied).toEqual([]); // chưa qua debounce
    rc.setStatus("done"); // terminal — ngay lập tức
    await new Promise((r) => setTimeout(r, 10));
    expect(applied).toEqual(["👍"]);
    // sau terminal không đổi nữa
    rc.setStatus("thinking");
    await new Promise((r) => setTimeout(r, REACTION_DEBOUNCE_MS + 100));
    expect(applied).toEqual(["👍"]);
    rc.stop();
  });

  it("debounce gộp trạng thái trung gian liên tiếp", async () => {
    const applied: string[] = [];
    const rc = new StatusReactionController(async (e) => {
      applied.push(e);
    });
    rc.setStatus("thinking");
    rc.setStatus("tool");
    rc.setStatus("web"); // chỉ trạng thái cuối được áp
    await new Promise((r) => setTimeout(r, REACTION_DEBOUNCE_MS + 100));
    expect(applied).toEqual(["⚡"]);
    rc.stop();
  });
});

describe("TypingController", () => {
  it("start gửi typing, keepalive lặp lại, cleanup 2 tín hiệu", async () => {
    let count = 0;
    const t = new TypingController({
      keepaliveMs: 30,
      start: () => {
        count++;
      },
    });
    t.start();
    expect(count).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBeGreaterThanOrEqual(3);
    t.markRunComplete();
    const at = count;
    await new Promise((r) => setTimeout(r, 80));
    expect(count).toBeGreaterThan(at); // chưa dispatchIdle → vẫn chạy
    t.markDispatchIdle();
    const done = count;
    await new Promise((r) => setTimeout(r, 80));
    expect(count).toBe(done); // đã dừng hẳn
  });
});
