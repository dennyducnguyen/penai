import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, PenaiConfigSchema } from "@penai/shared";

// Mẫu cấu hình học viên nhận lúc cài (deploy/templates/penai.config.json5).
// Sai cú pháp JSON5 hay sai schema ở đây = cài xong dịch vụ không khởi động được.
describe("mẫu cấu hình deploy/templates/penai.config.json5", () => {
  it("dựng ra file hợp lệ, đủ 3 provider thuê bao, alias API và thương hiệu", () => {
    const tpl = readFileSync(new URL("../../../deploy/templates/penai.config.json5", import.meta.url), "utf8");
    const text = tpl
      .replaceAll("{{INSTANCE}}", "penai")
      .replaceAll("{{PORT}}", "18800")
      .replaceAll("{{DATA_HOME}}", "/var/lib/penai")
      .replaceAll("{{CLI_TOTAL}}", "1");
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const file = join(mkdtempSync(join(tmpdir(), "penai-cfg-")), "penai.config.json5");
    writeFileSync(file, text);
    const cfg = loadConfig(file);
    expect(Object.keys(cfg.providers).sort()).toEqual(["antigravity", "claude-code", "codex"]);
    expect(cfg.dataDir).toBe("/var/lib/penai/data");
    expect(cfg.api.enabled).toBe(true);
    expect(Object.keys(cfg.api.models)).toEqual(
      expect.arrayContaining(["penai-fast", "penai-smart", "penai-image", "penai-image-codex"]),
    );
    expect(cfg.api.queue.cliTotal).toBe(1);
    expect(cfg.branding).toMatchObject({ name: "PenAI", theme: "xanh-duong" });
    expect(cfg.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("file cấu hình cũ không có timezone → giờ Việt Nam; múi giờ sai → báo lỗi ngay", () => {
    expect(PenaiConfigSchema.parse({}).timezone).toBe("Asia/Ho_Chi_Minh");
    expect(PenaiConfigSchema.parse({ timezone: "UTC" }).timezone).toBe("UTC");
    expect(() => PenaiConfigSchema.parse({ timezone: "Viet Nam" })).toThrow(/múi giờ không hợp lệ/);
  });
});
