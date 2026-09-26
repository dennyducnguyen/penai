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
  dir = await mkdtemp(join(tmpdir(), "penai-p9-"));
});

describe("tool TTS/sandbox/browser đã đăng ký", () => {
  it("có text_to_speech, sandbox_exec, browser", () => {
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("text_to_speech");
    expect(names).toContain("sandbox_exec");
    expect(names).toContain("browser");
  });

  it("sandbox_exec cần approval → từ chối khi không có", async () => {
    const r = await reg.execute("sandbox_exec", { code: "print(1)" }, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/phê duyệt/);
  });

  it("TTS không có OPENAI_API_KEY → lỗi rõ ràng (không crash)", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await reg.execute("text_to_speech", { text: "xin chào" }, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/OPENAI_API_KEY/);
    if (saved) process.env.OPENAI_API_KEY = saved;
  });
});
