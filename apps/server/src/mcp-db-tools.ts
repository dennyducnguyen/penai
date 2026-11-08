/**
 * PenAI MCP server — CSDL của workspace cho ứng dụng AI bên ngoài (Claude, ChatGPT…).
 *   db:read  — xem cấu trúc + chạy SELECT
 *   db:write — ghi dữ liệu, tạo/sửa/xóa bảng (cần tài khoản operator trở lên)
 */
import { z } from "zod";
import { hasRole, logger } from "@penai/shared";
import type { McpServer } from "@penai/mcp";
import { formatDbResult, type WsdbService } from "./wsdb-service.js";
import type { McpPrincipal } from "./mcp-server.js";

export const DB_SCOPES = ["db:read", "db:write"] as const;

export const DB_SCOPE_LABEL: Record<(typeof DB_SCOPES)[number], string> = {
  "db:read": "CSDL của workspace: xem các bảng và đọc dữ liệu (SELECT)",
  "db:write": "CSDL của workspace: thêm/sửa/xóa dữ liệu, tạo/sửa/xóa bảng (cần tài khoản operator trở lên)",
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function addDbMcpTools(server: McpServer, p: McpPrincipal, svc: WsdbService): void {
  const canRead = p.scopes.includes("db:read") || p.scopes.includes("db:write");
  if (!canRead || !svc.cfg.enabled) return;
  const canWrite = p.scopes.includes("db:write") && hasRole(p.ctx.role, "operator");
  const allow = canWrite ? ("ddl" as const) : ("read" as const);
  const caller = { ctx: p.ctx, allow, actor: { via: "mcp" as const, userId: p.ctx.userId } };
  const wrap = async (fn: () => Promise<string>): Promise<ToolResult> => {
    try {
      return { content: [{ type: "text", text: await fn() }] };
    } catch (err) {
      logger.warn(`mcp_server.db lỗi: ${(err as Error).message}`);
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  };

  server.registerTool(
    "db_schema",
    {
      title: "Cấu trúc CSDL",
      description: "Các bảng trong CSDL riêng của workspace PenAI: cột, kiểu, khóa, chú thích, số dòng. Gọi trước khi viết SQL.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (async (): Promise<ToolResult> => wrap(() => svc.schemaText(p.ctx))) as never,
  );
  server.registerTool(
    "db_query",
    {
      title: "Chạy SQL",
      description:
        "Chạy SQL PostgreSQL trên CSDL riêng của workspace (một hoặc nhiều lệnh, một giao dịch). Giá trị dùng $1, $2… + params. " +
        (canWrite
          ? "Được đọc, ghi, tạo/sửa bảng; lệnh xóa nhiều dữ liệu (DROP, TRUNCATE, DELETE/UPDATE không WHERE) cần confirm=true sau khi người dùng đồng ý."
          : "Kết nối này chỉ có quyền ĐỌC (SELECT)."),
      inputSchema: {
        sql: z.string().min(1).max(200_000),
        params: z.array(z.unknown()).max(1000).optional(),
        confirm: z.boolean().optional(),
        dryRun: z.boolean().optional().describe("Chạy thử rồi hoàn tác"),
      },
      annotations: { readOnlyHint: !canWrite, destructiveHint: canWrite, openWorldHint: false },
    },
    (async (a: { sql: string; params?: unknown[]; confirm?: boolean; dryRun?: boolean }): Promise<ToolResult> =>
      wrap(async () => formatDbResult(await svc.query(caller, { sql: a.sql, params: a.params ?? [], confirm: a.confirm === true, dryRun: a.dryRun === true })))) as never,
  );
}
