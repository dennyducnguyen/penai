import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import { publishFileTool } from "../src/builtin/publish-file.js";
import type { ToolContext } from "../src/registry.js";

const ctx: WorkspaceContext = { workspaceId: "ws", userId: "u", role: "ws_admin" };
let wsDir = "";
let userDir = "";

function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    ctx,
    workspaceDataDir: wsDir,
    workDir: userDir,
    sharedDir: join(wsDir, "shared"),
    ...over,
  };
}

beforeAll(async () => {
  wsDir = await mkdtemp(join(tmpdir(), "penai-pub-"));
  userDir = join(wsDir, "users", "telegram-1");
  await mkdir(userDir, { recursive: true });
  await mkdir(join(wsDir, "shared"), { recursive: true });
  await writeFile(join(userDir, "banner.png"), Buffer.from("png-data"));
});

describe("publish_file tool", () => {
  it("không có provider publishFile → báo tính năng chưa bật", async () => {
    const out = await publishFileTool.execute({ path: "banner.png" }, toolCtx());
    expect(out).toContain("chưa bật");
  });

  it("gọi provider với đường dẫn đã kiểm tra + ttl chuẩn hóa, trả URL", async () => {
    let got: { abs: string; ttlSeconds: number; fileName: string } | null = null;
    const out = await publishFileTool.execute(
      { path: "banner.png", ttlHours: 2, fileName: "hinh-canva.png" },
      toolCtx({
        publishFile: async (abs, o) => {
          got = { abs, ...o };
          return { url: "https://ai.example.com/f/tok123", expiresAt: "2026-09-02T00:00:00Z" };
        },
      }),
    );
    expect(out).toContain("https://ai.example.com/f/tok123");
    expect(got!.abs).toBe(join(userDir, "banner.png"));
    expect(got!.ttlSeconds).toBe(2 * 3600);
    expect(got!.fileName).toBe("hinh-canva.png");
  });

  it("file không tồn tại → báo lỗi thân thiện, không gọi provider", async () => {
    let called = false;
    const out = await publishFileTool.execute(
      { path: "khong-co.png" },
      toolCtx({
        publishFile: async () => {
          called = true;
          return { url: "x", expiresAt: "y" };
        },
      }),
    );
    expect(out).toContain("Không tìm thấy");
    expect(called).toBe(false);
  });

  it("path thoát ra ngoài vùng làm việc → bị chặn", async () => {
    await expect(
      publishFileTool.execute(
        { path: "../../../../etc/passwd" },
        toolCtx({ publishFile: async () => ({ url: "x", expiresAt: "y" }) }),
      ),
    ).rejects.toThrow(/ngoài/);
  });
});
