import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { BrandingSchema } from "@penai/shared";
import { INDEX_HTML } from "../src/ui.js";
import { defaultLogoSvg, renderIndexHtml } from "../src/branding.js";

// Dashboard là JS thuần nhúng trong template literal: một lỗi cú pháp làm chết
// cả trang, không chỉ một mục. Test này dịch thử mọi khối <script> sau khi ráp
// thương hiệu, thay cho bước `node --check` làm tay trước khi deploy.
describe("Dashboard HTML", () => {
  it("mọi khối <script> đều dịch được (không lỗi cú pháp)", () => {
    const html = renderIndexHtml(INDEX_HTML, BrandingSchema.parse({}));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Script(code)).not.toThrow();
  });

  it("không còn ô %%BRAND_*%% chưa thay và tên được escape", () => {
    const html = renderIndexHtml(
      INDEX_HTML,
      BrandingSchema.parse({ name: 'ABC <AI> "x"', tagline: "Trợ lý </script> công ty" }),
    );
    expect(html).not.toContain("%%BRAND_");
    expect(html).toContain("ABC &#60;AI&#62; &#34;x&#34;");
    expect(html).not.toContain("</script> công ty");
  });

  it("logo mặc định là SVG theo màu theme", () => {
    const svg = defaultLogoSvg(BrandingSchema.parse({ theme: "tim" }));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("#7c3aed");
  });
});
