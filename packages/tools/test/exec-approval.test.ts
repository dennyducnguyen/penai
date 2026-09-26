import { mkdtemp } from "node:fs/promises";
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-exec-"));
});

describe("exec tool (approval + deny)", () => {
  it("có đủ tool built-in cốt lõi", () => {
    const names = reg.list().map((t) => t.name);
    for (const t of ["current_time", "exec", "http_fetch", "read_file", "web_search", "memory_add", "skill_search", "delegate"]) {
      expect(names).toContain(t);
    }
  });

  it("lệnh trong allowlist chạy thẳng, không cần approval", async () => {
    const r = await reg.execute("exec", { command: "echo penai-ok" }, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(false);
    expect(r.result).toContain("penai-ok");
  });

  it("lệnh ngoài allowlist + không có approval callback → từ chối", async () => {
    const r = await reg.execute(
      "exec",
      { command: "binary_la_hoac --chay" },
      { ctx, workspaceDataDir: dir },
    );
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/chưa được phê duyệt/);
  });

  it("lệnh ngoài allowlist + approval từ chối → không chạy", async () => {
    const r = await reg.execute(
      "exec",
      { command: "binary_la_hoac --chay" },
      { ctx, workspaceDataDir: dir, requestApproval: async () => false },
    );
    expect(r.isError).toBe(true);
  });

  it("lệnh ngoài allowlist + approval đồng ý → được chạy", async () => {
    const r = await reg.execute(
      "exec",
      { command: "binary_la_hoac --chay" },
      { ctx, workspaceDataDir: dir, requestApproval: async () => true },
    );
    // chạy thật (binary không tồn tại → shell báo lỗi), nhưng KHÔNG bị chặn vì thiếu duyệt
    expect(r.result).not.toMatch(/chưa được phê duyệt/);
  });

  it("lệnh nguy hiểm bị chặn cứng dù có approval", async () => {
    const r = await reg.execute(
      "exec",
      { command: "rm -rf /" },
      { ctx, workspaceDataDir: dir, requestApproval: async () => true },
    );
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/nguy hiểm|chặn/);
  });
});

describe("web_search", () => {
  it("dùng provider webSearch nếu có", async () => {
    const r = await reg.execute(
      "web_search",
      { query: "test" },
      {
        ctx,
        workspaceDataDir: dir,
        webSearch: async (q, n) => `kết quả cho ${q} (${n})`,
      },
    );
    expect(r.isError).toBe(false);
    expect(r.result).toContain("kết quả cho test");
  });
});
