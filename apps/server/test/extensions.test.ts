import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "@penai/tools";
import { extensionUiHtml, loadExtensions, registerExtensionRoutes } from "../src/extensions.js";
import { INDEX_HTML } from "../src/ui.js";

// Điểm gắn mở rộng cho bản fork: nạp file trong thư mục, thêm route, tool, script Dashboard.
describe("extensions", () => {
  it("nạp extension: route, tool cho agent, script Dashboard; file lỗi bị bỏ qua", async () => {
    // Thư mục tạm nằm trong apps/server để file extension import được zod như mã thật
    const dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".tmp-ext-"));
    await writeFile(
      join(dir, "noi-bo.mjs"),
      `import { z } from "zod";
      export default {
        name: "noi-bo",
        routes(app) { app.get("/v1/ext/ping", async () => ({ pong: true })); },
        tools: [{ name: "ext_hello", description: "chào", schema: z.object({}), async execute() { return "xin chào"; } }],
        uiScript: "PenaiUI.addPage('noi-bo', '🏢', 'Nội bộ', function () {});",
      };`,
    );
    await writeFile(join(dir, "hong.mjs"), "throw new Error('hỏng');");
    await writeFile(join(dir, "_nhap.mjs"), "export default { name: 'khong-nap' };");
    const exts = await loadExtensions(dir);
    expect(exts.map((e) => e.name)).toEqual(["noi-bo"]);

    const app = Fastify();
    registerExtensionRoutes(app, {} as never, exts);
    const r = await app.inject({ method: "GET", url: "/v1/ext/ping" });
    expect(r.json()).toEqual({ pong: true });
    await app.close();

    expect(createDefaultToolRegistry().has("ext_hello")).toBe(true);
    const html = extensionUiHtml(exts);
    expect(html).toContain("PenaiUI.addPage('noi-bo'");
    expect(html.startsWith("<script>")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("Dashboard có window.PenaiUI.addPage cho extension", () => {
    expect(INDEX_HTML).toContain("window.PenaiUI = {");
    expect(INDEX_HTML).toContain("addPage: function (id, icon, label, render, opts)");
  });
});
