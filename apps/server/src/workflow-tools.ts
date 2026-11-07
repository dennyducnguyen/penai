/**
 * Runtime của tool workflow_* (agent tạo/sửa/chạy quy trình khi chat).
 *
 * Quyền theo NGƯỜI ĐANG CHAT:
 *   - Trang Chat web, vai trò operator trở lên → quản lý đầy đủ (tạo, sửa, chạy thử, chạy, xóa).
 *   - Còn lại (người dùng kênh Zalo/Telegram…, member, viewer) → chỉ xem + chạy các quy trình
 *     được đánh dấu settings.allowFromChat.
 * Agent sửa thì lưu thẳng thành phiên bản mới (via = "agent"), Dashboard hiện dải
 * "🤖 Agent vừa sửa" kèm nút hoàn về; cờ approved của bước cần duyệt không tự đặt được.
 */
import { hasRole, type WorkspaceContext, type WorkspaceRole } from "@penai/shared";
import { getWorkflowRun, listWorkflowRuns, listWorkflowRunSteps, listWorkflows, type Db, type WorkflowRow } from "@penai/db";
import { formatIssues, WORKFLOW_TEMPLATES, type WorkflowDefinition, type WorkflowOp } from "@penai/core";
import type { ToolContext } from "@penai/tools";
import { WorkflowError, type WorkflowService } from "./workflow-service.js";
import { WORKFLOW_GUIDE } from "./workflow-guide.js";

export type WorkflowToolApi = NonNullable<ToolContext["workflows"]>;

export interface WorkflowToolScope {
  /** Agent đang chat (tool workflow_*). Không có = ứng dụng AI ngoài qua PenAI MCP server. */
  agentId?: string;
  via?: "agent" | "mcp";
  /** Vai trò web của người đang chat; null = người ngoài qua kênh chat. */
  role: WorkspaceRole | null;
  /** Nhãn người đang chat (ghi vào lần chạy). */
  who: string;
}

const short = (v: unknown, n = 1500): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "…" : (s ?? "");
};

function issuesText(err: WorkflowError): string {
  const parts = [err.message];
  if (err.warnings.length) parts.push(`Cảnh báo:\n${formatIssues(err.warnings)}`);
  return parts.join("\n");
}

export function makeWorkflowToolApi(svc: WorkflowService, db: Db, ctx: WorkspaceContext, scope: WorkflowToolScope): WorkflowToolApi {
  const canManage = scope.role !== null && hasRole(scope.role, "operator");
  const via = scope.via ?? "agent";
  const actor = { ctx, via, ...(scope.agentId ? { agentId: scope.agentId } : {}) };

  const chatAllowed = (row: WorkflowRow) => (row.definition as unknown as WorkflowDefinition).settings?.allowFromChat === true;
  const visible = async (): Promise<WorkflowRow[]> => {
    const rows = await listWorkflows(db, ctx);
    return canManage ? rows : rows.filter(chatAllowed);
  };
  const mustSee = async (id: string): Promise<WorkflowRow> => {
    const row = await svc.mustGet(ctx, id);
    if (!canManage && !chatAllowed(row)) throw new WorkflowError(`Không có quy trình "${id}" được phép chạy từ cuộc trò chuyện này`, 404);
    return row;
  };
  const needManage = () => {
    if (!canManage) {
      throw new WorkflowError(
        "Chỉ quản trị viên/operator chat trên trang Chat của Dashboard mới tạo/sửa quy trình được. Người dùng có thể nhờ quản trị viên, hoặc tự làm ở Dashboard → Quy trình.",
        403,
      );
    }
  };
  const wrap = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WorkflowError) throw new Error(issuesText(err));
      throw err;
    }
  };
  const warnText = (w: Array<{ path: string; message: string }>) => (w.length ? `\nCảnh báo (nên xem lại):\n${formatIssues(w)}` : "");

  const runSummary = async (runId: string, finished: boolean) => {
    const run = await getWorkflowRun(db, ctx, runId);
    const steps = await listWorkflowRunSteps(db, ctx, runId, 300);
    const lines = steps.map(
      (s) =>
        `- ${s.path} (${s.stepId}${s.iteration !== null ? ` #${s.iteration}` : ""}) ${s.status}${s.durationMs ? ` ${s.durationMs}ms` : ""}` +
        (s.error ? ` — LỖI: ${short(s.error, 400)}` : s.output !== null ? ` → ${short(s.output, 300)}` : ""),
    );
    return [
      `Lần chạy ${runId}: ${finished ? run?.status : "vẫn đang chạy ở nền"}${run?.dryRun ? " (dry run — không gửi thật)" : ""}${run?.durationMs ? `, ${run.durationMs}ms` : ""}`,
      run?.error ? `Lỗi: ${run.error}` : "",
      run?.response ? `Trả về webhook: ${short(run.response, 500)}` : "",
      run?.output !== undefined && run?.output !== null ? `Kết quả: ${short(run.output, 800)}` : "",
      steps.length ? `Các bước:\n${lines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  return {
    list: (query) =>
      wrap(async () => {
        let rows = await visible();
        if (query) {
          const q = query.toLowerCase();
          rows = rows.filter((r) => `${r.name} ${r.description} ${r.slug}`.toLowerCase().includes(q));
        }
        if (!rows.length) return canManage ? "(chưa có quy trình nào — tạo bằng workflow_create)" : "(không có quy trình nào được phép chạy từ cuộc trò chuyện này)";
        return JSON.stringify(rows.map((r) => svc.describeRow(r)), null, 1);
      }),

    get: (id) =>
      wrap(async () => {
        const row = await mustSee(id);
        const out: Record<string, unknown> = { ...svc.describeRow(row), definition: row.definition };
        if (canManage) {
          const wh = svc.webhookInfo(row);
          if (wh) out.webhookUrl = wh.url;
          const runs = await listWorkflowRuns(db, ctx, row.id, { limit: 1 });
          if (runs[0]) out.lastRun = await runSummary(runs[0].id, runs[0].status !== "running");
        }
        return JSON.stringify(out, null, 1);
      }),

    catalog: (kind) =>
      wrap(async () => {
        needManage();
        if (kind === "guide") return WORKFLOW_GUIDE;
        if (kind === "templates") return JSON.stringify(WORKFLOW_TEMPLATES.map((t) => ({ key: t.key, title: t.title, summary: t.summary, definition: t.definition })), null, 1);
        const c = await svc.catalog(ctx, kind);
        // Rút gọn JSON Schema tool có sẵn để đỡ dài
        return JSON.stringify(c, null, kind ? 1 : 0).slice(0, 60_000);
      }),

    create: (input) =>
      wrap(async () => {
        needManage();
        const { row, warnings } = await svc.create(actor, input.definition, { enabled: input.enabled, note: input.note ?? (via === "mcp" ? `Ứng dụng AI (MCP) của ${scope.who} tạo` : `Agent tạo khi chat với ${scope.who}`) });
        const wh = svc.webhookInfo(row);
        return (
          `Đã tạo quy trình "${row.name}" (id ${row.id}, bản ${row.version}, ${row.enabled ? "đang bật" : "đang tắt"}).` +
          (row.nextRunAt ? `\nLần chạy theo lịch kế tiếp: ${row.nextRunAt.toISOString()}` : "") +
          (wh ? `\nLink webhook: ${wh.url}` : "") +
          `\nXem/sửa trên Dashboard: ${svc.describeRow(row).dashboardUrl}` +
          warnText(warnings) +
          "\nTiếp theo: gọi workflow_test (dryRun) để kiểm tra."
        );
      }),

    update: (input) =>
      wrap(async () => {
        needManage();
        let row: WorkflowRow | null = null;
        let msg = "";
        if (input.definition !== undefined || input.ops?.length) {
          const r = await svc.update(actor, input.id, {
            ...(input.definition !== undefined ? { definition: input.definition } : {}),
            ...(input.ops?.length ? { ops: input.ops as unknown as WorkflowOp[] } : {}),
            note: input.note ?? (via === "mcp" ? `Ứng dụng AI (MCP) của ${scope.who} sửa` : `Agent sửa khi chat với ${scope.who}`),
          });
          row = r.row;
          msg =
            `Đã lưu bản ${r.row.version} của "${r.row.name}".` +
            (r.diff.length ? `\nThay đổi: ${r.diff.map((d) => `${d.kind === "added" ? "+" : d.kind === "removed" ? "−" : "~"}${d.id}`).join(", ")}` : "\n(Không có thay đổi)") +
            warnText(r.warnings);
        }
        if (input.enabled !== undefined) {
          row = await svc.setEnabled(actor, input.id, input.enabled);
          msg += `${msg ? "\n" : ""}Quy trình đã ${input.enabled ? "BẬT" : "TẮT"}.`;
        }
        if (!row) return "Không có gì để sửa — gửi definition, ops hoặc enabled.";
        return msg;
      }),

    test: (input) =>
      wrap(async () => {
        needManage();
        const row = await mustSee(input.id);
        const r = await svc.runAndWait(ctx, row.id, {
          inputs: input.inputs ?? {},
          triggerType: "test",
          trigger: { by: scope.who, via },
          test: true,
          dryRun: input.dryRun,
          allowDisabled: true,
        });
        if ("skipped" in r && r.skipped) return `Chưa chạy: ${r.skipped}`;
        return runSummary(r.runId!, r.result !== null);
      }),

    run: (input) =>
      wrap(async () => {
        const row = await mustSee(input.id);
        const req = {
          inputs: input.inputs ?? {},
          triggerType: via === "mcp" ? ("mcp" as const) : ("agent" as const),
          trigger: { by: scope.who, ...(scope.agentId ? { agentId: scope.agentId } : {}) },
          allowDisabled: canManage,
        };
        if (!input.wait) {
          const s = await svc.start(ctx, row, req);
          return "skipped" in s ? `Chưa chạy: ${s.skipped}` : `Đã bắt đầu chạy "${row.name}" (runId ${s.runId}). Xem kết quả bằng workflow_runs.`;
        }
        const r = await svc.runAndWait(ctx, row.id, req);
        if ("skipped" in r && r.skipped) return `Chưa chạy: ${r.skipped}`;
        return runSummary(r.runId!, r.result !== null);
      }),

    runs: (input) =>
      wrap(async () => {
        const row = await mustSee(input.id);
        if (input.runId) return runSummary(input.runId, true);
        const runs = await listWorkflowRuns(db, ctx, row.id, { limit: input.limit, ...(input.status ? { status: input.status } : {}) });
        if (!runs.length) return `"${row.name}" chưa chạy lần nào${row.nextRunAt ? ` — lần chạy theo lịch kế tiếp ${row.nextRunAt.toISOString()}` : ""}.`;
        return runs
          .map(
            (r) =>
              `${r.id} · ${r.startedAt.toISOString()} · ${r.triggerType}${r.isTest ? " (thử)" : ""} · ${r.status}${r.durationMs ? ` ${r.durationMs}ms` : ""}` +
              (r.error ? ` · lỗi: ${short(r.error, 300)}` : ""),
          )
          .join("\n");
      }),

    remove: (id) =>
      wrap(async () => {
        needManage();
        const row = await svc.mustGet(ctx, id);
        await svc.remove(actor, row.id);
        return `Đã xóa quy trình "${row.name}".`;
      }),
  };
}
