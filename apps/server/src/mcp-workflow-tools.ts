/**
 * PenAI MCP server — bộ công cụ quy trình (workflow_*) cho ứng dụng AI bên ngoài
 * (Claude Desktop, Claude Code, ChatGPT…). Quyền:
 *   workflow:read   — xem danh sách, định nghĩa, lịch sử chạy
 *   workflow:run    — chạy quy trình
 *   workflow:manage — tạo, sửa, chạy thử, xóa (cần tài khoản operator trở lên)
 * Dùng chung runtime với tool workflow_* của agent (workflow-tools.ts).
 */
import { z } from "zod";
import { hasRole, logger } from "@penai/shared";
import type { Db } from "@penai/db";
import type { McpServer } from "@penai/mcp";
import { makeWorkflowToolApi } from "./workflow-tools.js";
import { WORKFLOW_GUIDE } from "./workflow-guide.js";
import type { WorkflowService } from "./workflow-service.js";
import type { McpPrincipal } from "./mcp-server.js";

export const WORKFLOW_SCOPES = ["workflow:read", "workflow:run", "workflow:manage"] as const;

export const WORKFLOW_SCOPE_LABEL: Record<(typeof WORKFLOW_SCOPES)[number], string> = {
  "workflow:read": "Quy trình tự động: xem danh sách, định nghĩa và lịch sử chạy",
  "workflow:run": "Quy trình tự động: chạy quy trình",
  "workflow:manage": "Quy trình tự động: tạo, sửa, chạy thử, xóa (cần tài khoản operator trở lên)",
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function addWorkflowMcpTools(server: McpServer, p: McpPrincipal, svc: WorkflowService, db: Db): void {
  const has = (s: string) => p.scopes.includes(s);
  if (!has("workflow:read") && !has("workflow:run") && !has("workflow:manage")) return;
  const api = makeWorkflowToolApi(svc, db, p.ctx, {
    via: "mcp",
    role: p.ctx.role,
    who: `tài khoản ${p.ctx.userId.slice(0, 8)}`,
  });
  const manage = has("workflow:manage") && hasRole(p.ctx.role, "operator");

  const reg = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    scope: (typeof WORKFLOW_SCOPES)[number],
    shape: S,
    readOnly: boolean,
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: name === "workflow_delete", openWorldHint: !readOnly } },
      (async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
        if (!has(scope) && !(scope !== "workflow:manage" && has("workflow:manage"))) {
          return { content: [{ type: "text", text: `Kết nối chưa được cấp quyền ${scope}. Kết nối lại và tick quyền này.` }], isError: true };
        }
        try {
          return { content: [{ type: "text", text: await fn(args) }] };
        } catch (err) {
          logger.warn(`mcp_server.tool ${name} lỗi: ${(err as Error).message}`);
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }) as never,
    );
  };

  const id = z.string().min(1).max(80).describe("id (uuid) hoặc slug quy trình — lấy từ workflow_list");
  const inputs = z.record(z.string(), z.unknown()).optional().describe("Tham số đầu vào (inputs)");
  const definition = z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .describe("Định nghĩa JSON đầy đủ { name, description, triggers, inputs, steps, settings }. Gọi workflow_guide để xem cú pháp.");

  reg("workflow_list", "Danh sách quy trình", "Các quy trình tự động: id, tên, trạng thái, trigger, lần chạy gần nhất/kế tiếp.", "workflow:read", { query: z.string().max(100).optional() }, true, (a) => api.list(a.query));
  reg("workflow_get", "Xem quy trình", "Định nghĩa JSON đầy đủ của một quy trình + link webhook + kết quả lần chạy gần nhất.", "workflow:read", { id }, true, (a) => api.get(a.id));
  reg(
    "workflow_runs",
    "Lịch sử chạy",
    "Lịch sử chạy của một quy trình, hoặc chi tiết từng bước của một lần chạy (runId).",
    "workflow:read",
    { id, runId: z.string().uuid().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    true,
    (a) => api.runs({ id: a.id, ...(a.runId ? { runId: a.runId } : {}), ...(a.status ? { status: a.status } : {}), limit: a.limit ?? 10 }),
  );
  reg(
    "workflow_run",
    "Chạy quy trình",
    "Chạy thật một quy trình với inputs; wait=true (mặc định) chờ kết quả tối đa ~2 phút.",
    "workflow:run",
    { id, inputs, wait: z.boolean().optional() },
    false,
    (a) => api.run({ id: a.id, ...(a.inputs ? { inputs: a.inputs } : {}), wait: a.wait ?? true }),
  );
  if (!manage) return;
  reg("workflow_guide", "Hướng dẫn định dạng quy trình", "Cú pháp JSON quy trình: loại bước, trigger, biểu thức {{ }}, ví dụ. Đọc trước khi tạo/sửa.", "workflow:manage", {}, true, async () => WORKFLOW_GUIDE);
  reg(
    "workflow_catalog",
    "Danh mục để dựng bước",
    "Kênh chat + cuộc trò chuyện gần đây, tool, MCP server + tool, agent, quy trình khác, tên khóa bí mật, loại bước, mẫu có sẵn — để điền đúng tên.",
    "workflow:manage",
    { kind: z.enum(["channels", "tools", "mcp", "agents", "workflows", "secrets", "database", "steps", "templates"]).optional() },
    true,
    (a) => api.catalog(a.kind),
  );
  reg(
    "workflow_create",
    "Tạo quy trình",
    "Tạo quy trình từ định nghĩa JSON. Lỗi trả về có đường dẫn + gợi ý để sửa. Tạo xong nên gọi workflow_test (dryRun).",
    "workflow:manage",
    { definition, enabled: z.boolean().optional(), note: z.string().max(300).optional() },
    false,
    (a) => api.create({ definition: a.definition, enabled: a.enabled ?? true, ...(a.note ? { note: a.note } : {}) }),
  );
  reg(
    "workflow_update",
    "Sửa quy trình",
    "Sửa bằng definition đầy đủ hoặc ops (update_step / insert / remove_step / move_step / set_step / set_triggers / set), và/hoặc bật/tắt. Mỗi lần sửa là một phiên bản mới.",
    "workflow:manage",
    {
      id,
      definition: definition.optional(),
      ops: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
      enabled: z.boolean().optional(),
      note: z.string().max(300).optional(),
    },
    false,
    (a) =>
      api.update({
        id: a.id,
        ...(a.definition !== undefined ? { definition: a.definition } : {}),
        ...(a.ops ? { ops: a.ops } : {}),
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        ...(a.note ? { note: a.note } : {}),
      }),
  );
  reg(
    "workflow_test",
    "Chạy thử quy trình",
    "Chạy thử và nhận nhật ký từng bước; dryRun=true (mặc định) không gửi tin / không gọi POST, MCP, tool thật.",
    "workflow:manage",
    { id, inputs, dryRun: z.boolean().optional() },
    false,
    (a) => api.test({ id: a.id, ...(a.inputs ? { inputs: a.inputs } : {}), dryRun: a.dryRun ?? true }),
  );
  reg("workflow_delete", "Xóa quy trình", "Xóa hẳn quy trình (kèm lịch sử). Chỉ gọi khi người dùng đã xác nhận.", "workflow:manage", { id, confirm: z.literal(true) }, false, (a) => api.remove(a.id));
}

export { WORKFLOW_GUIDE };
