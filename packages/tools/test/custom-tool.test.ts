import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import { buildCustomTool, ToolRegistry } from "../src/index.js";

const ctx: WorkspaceContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  role: "operator",
};
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-custom-"));
});

describe("custom tool (shell template)", () => {
  it("thay {{param}} + chạy, requiresApproval=false", async () => {
    const reg = new ToolRegistry().registerRaw(
      buildCustomTool({
        name: "say",
        description: "in ra lời chào",
        commandTemplate: "echo Xin chao {{ten}}",
        paramsSchema: { type: "object", properties: { ten: { type: "string" } }, required: ["ten"] },
        requiresApproval: false,
      }),
    );
    const r = await reg.execute("say", { ten: "PenAI" }, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(false);
    expect(r.result).toContain("Xin chao PenAI");
  });

  it("requiresApproval=true, không duyệt → lỗi", async () => {
    const reg = new ToolRegistry().registerRaw(
      buildCustomTool({
        name: "danger",
        description: "x",
        commandTemplate: "echo hi",
        paramsSchema: {},
        requiresApproval: true,
      }),
    );
    const r = await reg.execute("danger", {}, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/phê duyệt/);
  });

  it("chống shell injection (escape tham số)", async () => {
    const reg = new ToolRegistry().registerRaw(
      buildCustomTool({
        name: "echo2",
        description: "x",
        commandTemplate: "echo {{val}}",
        paramsSchema: { type: "object", properties: { val: { type: "string" } } },
        requiresApproval: false,
      }),
    );
    // Giá trị chứa ; rm -rf phải được escape thành literal, không thực thi
    const r = await reg.execute(
      "echo2",
      { val: "hello; echo INJECTED" },
      { ctx, workspaceDataDir: dir },
    );
    expect(r.isError).toBe(false);
    expect(r.result).toContain("hello; echo INJECTED");
    expect(r.result).not.toMatch(/^INJECTED$/m);
  });

  it("raw tool xuất hiện trong definitions với JSON Schema gốc", () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    const reg = new ToolRegistry().registerRaw(
      buildCustomTool({ name: "t", description: "d", commandTemplate: "echo {{x}}", paramsSchema: schema, requiresApproval: false }),
    );
    const def = reg.definitions()[0]!;
    expect(def.parameters).toEqual(schema);
  });
});
