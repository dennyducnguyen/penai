import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import { createDefaultToolRegistry, type ToolContext } from "../src/index.js";

// Tool cron_* chỉ chuyển tham số cho runtime (toolCtx.cron); kiểm tra lịch,
// giới hạn và quyền nằm ở apps/server/src/cron-tools.ts.

const ctx: WorkspaceContext = { workspaceId: "ws", userId: "u", role: "operator" };
const reg = createDefaultToolRegistry();

function fakeCron() {
  const calls: Array<[string, unknown]> = [];
  const cron: NonNullable<ToolContext["cron"]> = {
    create: async (input) => (calls.push(["create", input]), "tạo"),
    list: async (input) => (calls.push(["list", input]), "danh sách"),
    update: async (input) => (calls.push(["update", input]), "sửa"),
    remove: async (id) => (calls.push(["remove", id]), "xóa"),
  };
  return { cron, calls };
}

describe("tool cron_*", () => {
  it("không có toolCtx.cron → báo không đặt lịch được, không lỗi", async () => {
    const r = await reg.execute(
      "cron_create",
      { name: "a", schedule: "in 5m", prompt: "b" },
      { ctx, workspaceDataDir: "." },
    );
    expect(r.isError).toBe(false);
    expect(r.result).toContain("Không đặt lịch được trong ngữ cảnh này");
  });

  it("chuyển đúng tham số, deliver mặc định true", async () => {
    const { cron, calls } = fakeCron();
    const base = { ctx, workspaceDataDir: ".", cron };
    expect((await reg.execute("cron_create", { name: "Nhắc", schedule: "0 8 * * *", prompt: "Nhắc họp" }, base)).result).toBe("tạo");
    expect((await reg.execute("cron_list", {}, base)).result).toBe("danh sách");
    expect((await reg.execute("cron_update", { id: "3f9a1c2e", enabled: false }, base)).result).toBe("sửa");
    expect((await reg.execute("cron_delete", { id: "#3f9a" }, base)).result).toBe("xóa");
    expect(calls).toEqual([
      ["create", { name: "Nhắc", schedule: "0 8 * * *", prompt: "Nhắc họp", deliver: true }],
      ["list", { includeDone: false }],
      ["update", { id: "3f9a1c2e", enabled: false }],
      ["remove", "#3f9a"],
    ]);
  });

  it("cron_update không có gì để sửa → nhắc, không gọi runtime", async () => {
    const { cron, calls } = fakeCron();
    const r = await reg.execute("cron_update", { id: "3f9a1c2e" }, { ctx, workspaceDataDir: ".", cron });
    expect(r.result).toContain("Không có gì để sửa");
    expect(calls).toHaveLength(0);
  });

  it("lỗi từ runtime thành kết quả lỗi cho agent đọc", async () => {
    const { cron } = fakeCron();
    cron.create = async () => {
      throw new Error("Lịch lặp lại dày quá — tối thiểu 5 phút một lần.");
    };
    const r = await reg.execute(
      "cron_create",
      { name: "a", schedule: "every 1m", prompt: "b" },
      { ctx, workspaceDataDir: ".", cron },
    );
    expect(r.isError).toBe(true);
    expect(r.result).toContain("tối thiểu 5 phút");
  });

  it("current_time mặc định theo múi giờ của hệ thống", async () => {
    const r = await reg.execute("current_time", {}, { ctx, workspaceDataDir: ".", timezone: "Asia/Ho_Chi_Minh" });
    expect(r.result).toContain("(Asia/Ho_Chi_Minh)");
    expect(r.result).toMatch(/ISO \d{4}-\d{2}-\d{2}T/);
  });
});
