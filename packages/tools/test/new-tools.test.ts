import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import { createDefaultToolRegistry } from "../src/index.js";

const ctx: WorkspaceContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  role: "operator",
};

let dir: string;
const reg = createDefaultToolRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  reg.execute(name, args, { ctx, workspaceDataDir: dir });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-tools2-"));
});

describe("registry có đủ tool built-in", () => {
  it("liệt kê đủ tool built-in (>= 16)", () => {
    const names = reg.list().map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(16);
    for (const t of [
      "write_file",
      "list_files",
      "memory_search",
      "use_skill",
      "update_skill",
      "landing_page_save",
      "landing_page_list",
      "landing_page_get",
      "team_add_task",
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe("write_file + list_files (path-guard)", () => {
  it("ghi rồi liệt kê thấy file", async () => {
    const w = await run("write_file", { path: "sub/note.txt", content: "xin chào" });
    expect(w.isError).toBe(false);
    expect(await readFile(join(dir, "sub", "note.txt"), "utf8")).toBe("xin chào");

    const l = await run("list_files", { path: "sub" });
    expect(l.isError).toBe(false);
    expect(l.result).toContain("sub/note.txt");
  });

  it("write_file chặn traversal", async () => {
    const w = await run("write_file", { path: "../evil.txt", content: "x" });
    expect(w.isError).toBe(true);
    expect(w.result).toMatch(/ngoài thư mục/);
  });
});

describe("http_fetch SSRF guard", () => {
  it("chặn localhost", async () => {
    const r = await run("http_fetch", { url: "http://127.0.0.1:5433/" });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/nội bộ/);
  });

  it("chặn IP private 192.168.x", async () => {
    const r = await run("http_fetch", { url: "http://192.168.1.1/" });
    expect(r.isError).toBe(true);
  });

  it("chặn scheme file://", async () => {
    const r = await run("http_fetch", { url: "file:///etc/passwd" });
    expect(r.isError).toBe(true);
  });
});
