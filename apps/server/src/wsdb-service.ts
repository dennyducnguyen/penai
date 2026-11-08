/**
 * CSDL riêng của workspace — phần máy chủ: quyền theo người gọi, hạn mức từ cấu hình,
 * "Dùng bởi" (quy trình nào đọc/ghi bảng nào), bản chụp hằng ngày.
 * Dùng chung cho API /v1/db/* (wsdb-routes.ts), bước db của quy trình, tool db_* của
 * agent và PenAI MCP server. Logic SQL nằm ở packages/db/src/wsdb.ts.
 */
import { hasRole, logger, type WorkspaceContext, type WorkspaceRole } from "@penai/shared";
import {
  describeWsdbSchema,
  listWorkflows,
  wsdbLastSnapshotAt,
  wsdbListWorkspaces,
  wsdbQuery,
  wsdbSchema,
  wsdbSchemaName,
  wsdbTablesOf,
  wsdbTakeSnapshot,
  type WsdbActor,
  type WsdbLimits,
  type WsdbQueryResult,
  type WsdbStatementKind,
} from "@penai/db";
import { buildDbQuery, walkSteps, type DbForm, type WorkflowDefinition } from "@penai/core";
import type { RuntimeDeps } from "./agent-runtime.js";

export interface WsdbCaller {
  ctx: WorkspaceContext;
  actor: WsdbActor;
  /** Mức tối đa được làm. */
  allow: WsdbStatementKind;
}

/** Vai trò → mức được làm trên CSDL: viewer chỉ đọc; operator trở lên đọc, ghi, đổi cấu trúc. */
export function allowForRole(role: WorkspaceRole | null | undefined): WsdbStatementKind | null {
  if (!role) return null;
  if (hasRole(role, "operator")) return "ddl";
  if (role === "viewer") return "read";
  return null;
}

export class WsdbService {
  private snapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private rt: RuntimeDeps) {}

  get cfg() {
    return this.rt.config.workspaceDb;
  }

  private get db() {
    return this.rt.db.db;
  }

  /** Kết nối CSDL chính (cho các hàm wsdb* ngoài query). */
  get rawDb() {
    return this.rt.db.db;
  }

  limits(): WsdbLimits {
    return {
      maxRows: this.cfg.maxRows,
      timeoutMs: this.cfg.timeoutSeconds * 1000,
      quotaBytes: this.cfg.quotaMb * 1024 * 1024,
      maxResultBytes: 1024 * 1024,
    };
  }

  private mustEnabled() {
    if (!this.cfg.enabled) throw Object.assign(new Error("CSDL của workspace đang tắt trên máy chủ này (cấu hình workspaceDb.enabled)"), { status: 503 });
  }

  async query(c: WsdbCaller, input: { sql: string; params?: unknown[]; confirm?: boolean; dryRun?: boolean }): Promise<WsdbQueryResult> {
    this.mustEnabled();
    return wsdbQuery(this.db, c.ctx, {
      sql: input.sql,
      params: input.params ?? [],
      allow: c.allow,
      confirm: input.confirm === true,
      dryRun: input.dryRun === true,
      actor: c.actor,
      limits: this.limits(),
    });
  }

  /** Thao tác dạng form (op/table/values/where…) → SQL có tham số → chạy. */
  async queryForm(c: WsdbCaller, form: DbForm, opts: { confirm?: boolean; dryRun?: boolean } = {}) {
    const b = buildDbQuery(form);
    const res = await this.query(c, { sql: b.sql, params: b.params, ...opts });
    return { ...res, sql: b.sql, params: b.params };
  }

  async schema(ctx: WorkspaceContext) {
    this.mustEnabled();
    return wsdbSchema(this.db, ctx, this.limits());
  }

  async schemaText(ctx: WorkspaceContext): Promise<string> {
    return describeWsdbSchema(await this.schema(ctx));
  }

  /** Tên bảng (validator quy trình) — lỗi thì không kiểm. */
  async tableNames(ctx: WorkspaceContext): Promise<string[] | undefined> {
    if (!this.cfg.enabled) return undefined;
    try {
      return (await this.schema(ctx)).tables.map((t) => t.name);
    } catch {
      return undefined;
    }
  }

  /** Bảng nào được quy trình nào đọc / ghi (dò bước db). */
  async usage(ctx: WorkspaceContext): Promise<Record<string, Array<{ workflowId: string; name: string; reads: boolean; writes: boolean }>>> {
    const schema = wsdbSchemaName(ctx.workspaceId);
    const out: Record<string, Array<{ workflowId: string; name: string; reads: boolean; writes: boolean }>> = {};
    const add = (table: string, wf: { id: string; name: string }, w: boolean) => {
      const list = (out[table] ??= []);
      let e = list.find((x) => x.workflowId === wf.id);
      if (!e) list.push((e = { workflowId: wf.id, name: wf.name, reads: false, writes: false }));
      if (w) e.writes = true;
      else e.reads = true;
    };
    for (const wf of await listWorkflows(this.db, ctx)) {
      const steps: Array<Record<string, unknown>> = [];
      walkSteps(((wf.definition as unknown as WorkflowDefinition).steps ?? []), (s) => {
        if (s.type === "db") steps.push(s);
      });
      for (const s of steps) {
        if (typeof s.sql === "string" && s.sql.trim()) {
          const t = await wsdbTablesOf(s.sql, schema);
          t?.reads.forEach((x) => add(x, wf, false));
          t?.writes.forEach((x) => add(x, wf, true));
        } else if (typeof s.table === "string" && s.table) {
          add(s.table, wf, !["find", "count", "aggregate"].includes(String(s.op)));
        }
      }
    }
    return out;
  }

  // ---------------- bản chụp hằng ngày ----------------

  start(): void {
    if (!this.cfg.enabled || this.cfg.snapshotKeep <= 0) return;
    const run = () => void this.snapshotAll().catch((e) => logger.warn(`CSDL workspace: chụp hằng ngày lỗi — ${(e as Error).message}`));
    setTimeout(run, 5 * 60_000).unref?.();
    this.snapTimer = setInterval(run, 3 * 3_600_000);
    this.snapTimer.unref?.();
  }

  stop(): void {
    if (this.snapTimer) clearInterval(this.snapTimer);
  }

  /** Chụp mọi workspace có CSDL mà bản tự động gần nhất đã quá 20 giờ. */
  async snapshotAll(): Promise<number> {
    let n = 0;
    for (const ws of await wsdbListWorkspaces(this.db)) {
      const ctx: WorkspaceContext = { workspaceId: ws, userId: ws, role: "ws_admin" } as WorkspaceContext;
      const last = await wsdbLastSnapshotAt(this.db, ctx).catch(() => null);
      if (last && Date.now() - last.getTime() < 20 * 3_600_000) continue;
      const r = await wsdbTakeSnapshot(this.db, ctx, { keep: this.cfg.snapshotKeep, maxBytes: this.cfg.snapshotMaxMb * 1024 * 1024 }).catch((e) => ({ skipped: (e as Error).message }));
      if ("id" in r) n++;
      else if (!/Chưa có bảng/.test(r.skipped)) logger.info(`CSDL workspace ${ws}: bỏ chụp — ${r.skipped}`);
    }
    if (n) logger.info(`CSDL workspace: đã chụp ${n} workspace`);
    return n;
  }
}

const services = new WeakMap<object, WsdbService>();

export function getWsdbService(rt: RuntimeDeps): WsdbService {
  let s = services.get(rt.db);
  if (!s) {
    s = new WsdbService(rt);
    services.set(rt.db, s);
  }
  return s;
}

/** Kết quả gọn cho AI. */
export function formatDbResult(r: WsdbQueryResult & { sql?: string }): string {
  const head =
    (r.dryRun ? "(CHẠY THỬ — đã hoàn tác, không lưu) " : "") +
    (r.kind === "read" ? `${r.rows.length} dòng${r.truncated ? " (đã cắt bớt — thêm WHERE/LIMIT)" : ""}` : `Xong: ${r.statements.map((s) => `${s.command} ${s.rowCount ?? ""}`.trim()).join("; ")}`);
  if (!r.rows.length) return head;
  return `${head}\n${JSON.stringify(r.rows, null, 0).slice(0, 60_000)}`;
}

/** Runtime tool db_* của agent (người đang chat trên trang Chat của Dashboard). */
export function makeDbToolApi(
  svc: WsdbService,
  ctx: WorkspaceContext,
  scope: { role: WorkspaceRole; agentId?: string; via?: "agent" | "mcp" },
): { schema(): Promise<string>; query(input: { sql: string; params?: unknown[]; confirm: boolean; dryRun: boolean }): Promise<string> } {
  const allow = allowForRole(scope.role) ?? "read";
  const caller: WsdbCaller = { ctx, allow, actor: { via: scope.via ?? "agent", userId: ctx.userId, agentId: scope.agentId ?? null } };
  return {
    schema: () => svc.schemaText(ctx),
    query: async (input) => formatDbResult(await svc.query(caller, input)),
  };
}
