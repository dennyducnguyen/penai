import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  writeFileTool,
  editFileTool,
  deleteFileTool,
  moveFileTool,
  memoryGetTool,
  isMemoryPath,
  ensureWorkDirs,
  type ToolContext,
} from "../src/index.js";

const ctx: WorkspaceContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "tester",
  role: "ws_admin",
};

let toolCtx: ToolContext;
let saved: Array<{ path: string; content: string }> = [];
let deleted: string[] = [];

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "penai-mem-"));
  const shared = resolve(root, "shared");
  const work = resolve(root, "users", "telegram-111");
  await ensureWorkDirs(work, shared);
  toolCtx = {
    ctx,
    workspaceDataDir: root,
    workDir: work,
    sharedDir: shared,
    memory: {
      add: async () => {},
      search: async () => "",
      saveDoc: async (path, content) => {
        saved.push({ path, content });
      },
      deleteDoc: async (path) => {
        deleted.push(path);
      },
    },
  };
});

beforeEach(() => {
  saved = [];
  deleted = [];
});

describe("isMemoryPath", () => {
  it("nhận diện đúng path ghi nhớ", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(true);
    expect(isMemoryPath("memory.md")).toBe(true);
    expect(isMemoryPath("memory/2026-08-05.md")).toBe(true);
    expect(isMemoryPath("memory/notes/du-an.md")).toBe(true);
    expect(isMemoryPath("bao-cao.md")).toBe(false);
    expect(isMemoryPath("docs/MEMORY.md")).toBe(false);
    expect(isMemoryPath("memories.txt")).toBe(false);
  });
});

describe("fs-tools tự index file ghi nhớ", () => {
  it("write_file vào memory/ → saveDoc được gọi với nội dung đầy đủ", async () => {
    const out = await writeFileTool.execute(
      { path: "memory/2026-08-05.md", content: "# Ghi chu\nKhach A muon website", append: false },
      toolCtx,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.path).toBe("memory/2026-08-05.md");
    expect(saved[0]!.content).toContain("Khach A muon website");
    expect(out).toContain("bộ nhớ dài hạn");
  });

  it("write_file append → saveDoc nhận nội dung GỘP (cả cũ lẫn mới)", async () => {
    await writeFileTool.execute(
      { path: "MEMORY.md", content: "dong 1\n", append: false },
      toolCtx,
    );
    await writeFileTool.execute(
      { path: "MEMORY.md", content: "dong 2\n", append: true },
      toolCtx,
    );
    expect(saved).toHaveLength(2);
    expect(saved[1]!.content).toBe("dong 1\ndong 2\n");
  });

  it("edit_file file ghi nhớ → saveDoc với nội dung sau sửa", async () => {
    await writeFileTool.execute(
      { path: "memory/prefs.md", content: "mau yeu thich: xanh", append: false },
      toolCtx,
    );
    saved = [];
    await editFileTool.execute(
      { path: "memory/prefs.md", find: "xanh", replace: "do", all: false },
      toolCtx,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.content).toBe("mau yeu thich: do");
  });

  it("file thường không kích hoạt saveDoc", async () => {
    await writeFileTool.execute(
      { path: "bao-cao.md", content: "noi dung binh thuong", append: false },
      toolCtx,
    );
    expect(saved).toHaveLength(0);
  });

  it("delete_file file ghi nhớ → deleteDoc; move_file → delete cũ + save mới", async () => {
    await writeFileTool.execute(
      { path: "memory/tam.md", content: "tam thoi", append: false },
      toolCtx,
    );
    await deleteFileTool.execute({ path: "memory/tam.md", recursive: false }, toolCtx);
    expect(deleted).toContain("memory/tam.md");

    saved = [];
    deleted = [];
    await writeFileTool.execute(
      { path: "memory/cu.md", content: "noi dung giu lai", append: false },
      toolCtx,
    );
    await moveFileTool.execute({ from: "memory/cu.md", to: "memory/moi.md" }, toolCtx);
    expect(deleted).toContain("memory/cu.md");
    expect(saved.some((s) => s.path === "memory/moi.md" && s.content === "noi dung giu lai")).toBe(
      true,
    );
  });

  it("thiếu memory provider thì ghi file vẫn chạy bình thường", async () => {
    const bare: ToolContext = { ...toolCtx };
    delete (bare as { memory?: unknown }).memory;
    const out = await writeFileTool.execute(
      { path: "memory/khong-provider.md", content: "van ghi duoc", append: false },
      bare,
    );
    expect(out).toContain("Đã ghi");
    expect(out).not.toContain("bộ nhớ dài hạn");
  });
});

describe("memory_get tool", () => {
  it("chuyển tiếp path/from/lines cho provider", async () => {
    const calls: unknown[] = [];
    const withGet: ToolContext = {
      ...toolCtx,
      memory: {
        add: async () => {},
        search: async () => "",
        getDoc: async (path, from, lines) => {
          calls.push([path, from, lines]);
          return "# MEMORY.md — dòng 1-2/2\nnoi dung";
        },
      },
    };
    const out = await memoryGetTool.execute({ path: "MEMORY.md", from: 1, lines: 2 }, withGet);
    expect(calls).toEqual([["MEMORY.md", 1, 2]]);
    expect(out).toContain("noi dung");
  });

  it("báo lỗi rõ khi memory chưa bật", async () => {
    const bare: ToolContext = { ...toolCtx };
    delete (bare as { memory?: unknown }).memory;
    await expect(
      memoryGetTool.execute({ path: "MEMORY.md" } as never, bare),
    ).rejects.toThrow(/Memory chưa được bật/);
  });
});
