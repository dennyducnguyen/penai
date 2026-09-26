import { mkdtemp, writeFile } from "node:fs/promises";
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
const registry = createDefaultToolRegistry();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-tools-"));
  await writeFile(join(dir, "ghi-chu.txt"), "nội dung bí mật của workspace", "utf8");
});

describe("read_file path-guard (spec security)", () => {
  it("đọc file trong workspace data dir", async () => {
    const res = await registry.execute(
      "read_file",
      { path: "ghi-chu.txt" },
      { ctx, workspaceDataDir: dir },
    );
    expect(res.isError).toBe(false);
    expect(res.result).toContain("bí mật");
  });

  it("chặn path traversal ..", async () => {
    const res = await registry.execute(
      "read_file",
      { path: "..\\..\\windows\\win.ini" },
      { ctx, workspaceDataDir: dir },
    );
    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/ngoài thư mục/);
  });

  it("chặn đường dẫn tuyệt đối ra ngoài", async () => {
    const res = await registry.execute(
      "read_file",
      { path: "C:\\Windows\\win.ini" },
      { ctx, workspaceDataDir: dir },
    );
    expect(res.isError).toBe(true);
  });

  it("tool không tồn tại → isError, không throw", async () => {
    const res = await registry.execute("khong_ton_tai", {}, { ctx, workspaceDataDir: dir });
    expect(res.isError).toBe(true);
  });

  it("args sai schema → isError", async () => {
    const res = await registry.execute("read_file", {}, { ctx, workspaceDataDir: dir });
    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/không hợp lệ/i);
  });
});
