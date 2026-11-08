/**
 * CSDL riêng của workspace (0037) — bảng PostgreSQL thật cho quy trình (bước db),
 * agent (tool db_*), API /v1/db/*, MCP và trang 🗃️ Dữ liệu.
 *
 * Mỗi workspace = một schema + một role `wsdb_<uuid>`. Mọi câu lệnh của người dùng:
 *   1. qua bộ kiểm (wsdb-guard.ts) — cây cú pháp thật của PostgreSQL;
 *   2. chạy trong MỘT giao dịch: statement_timeout, search_path = schema của workspace,
 *      SET LOCAL ROLE wsdb_<uuid> (role không có quyền ngoài schema của nó);
 *   3. lệnh ghi / đổi cấu trúc được ghi nhật ký wsdb_audit.
 * dryRun = chạy thật trong giao dịch rồi ROLLBACK (biết trước số dòng bị ảnh hưởng).
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { wsdbAudit, wsdbSnapshots } from "./schema.js";
import { checkWsdbSql, kindRank, WsdbGuardError, type WsdbCheckResult, type WsdbStatementKind } from "./wsdb-guard.js";

export { WsdbGuardError, checkWsdbSql, wsdbTablesOf, type WsdbCheckResult, type WsdbStatementKind } from "./wsdb-guard.js";

export interface WsdbLimits {
  /** Số dòng trả về tối đa mỗi lệnh. */
  maxRows: number;
  /** statement_timeout (ms). */
  timeoutMs: number;
  /** Dung lượng tối đa của CSDL workspace (byte) — vượt thì chỉ còn đọc + xóa. */
  quotaBytes: number;
  /** Kích thước kết quả tối đa (byte JSON). */
  maxResultBytes: number;
}

export const DEFAULT_WSDB_LIMITS: WsdbLimits = {
  maxRows: 1000,
  timeoutMs: 15_000,
  quotaBytes: 500 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
};

export type WsdbVia = "dashboard" | "api" | "agent" | "mcp" | "workflow";

export interface WsdbActor {
  via: WsdbVia;
  userId?: string | null;
  agentId?: string | null;
  workflowId?: string | null;
}

export interface WsdbQueryInput {
  sql: string;
  params?: unknown[];
  /** Mức tối đa người gọi được làm: read < write < ddl. */
  allow: WsdbStatementKind;
  /** Đồng ý chạy lệnh phá dữ liệu (DROP, TRUNCATE, DELETE/UPDATE không WHERE, xóa cột). */
  confirm?: boolean;
  /** Chạy trong giao dịch rồi hoàn tác. */
  dryRun?: boolean;
  actor: WsdbActor;
  limits?: Partial<WsdbLimits>;
}

export interface WsdbStatementResult {
  command: string;
  rowCount: number | null;
  fields: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface WsdbQueryResult {
  /** Kết quả của lệnh CUỐI (thường là SELECT). */
  rows: Record<string, unknown>[];
  row: Record<string, unknown> | null;
  count: number;
  fields: string[];
  truncated: boolean;
  kind: WsdbStatementKind;
  dryRun: boolean;
  statements: Array<{ command: string; rowCount: number | null }>;
}

export class WsdbError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "WsdbError";
  }
}

/** Tên schema (= tên role) của workspace. */
export function wsdbSchemaName(workspaceId: string): string {
  const hex = workspaceId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new WsdbError("workspace id không hợp lệ", 500);
  return `wsdb_${hex}`;
}

function poolOf(db: Db): pg.Pool {
  const p = (db as unknown as { $client?: pg.Pool }).$client;
  if (!p) throw new WsdbError("Không lấy được kết nối CSDL", 500);
  return p;
}

const ensured = new Set<string>();

/** Tạo schema + role của workspace nếu chưa có (gọi hàm SECURITY DEFINER). */
export async function wsdbEnsure(db: Db, workspaceId: string): Promise<string> {
  const name = wsdbSchemaName(workspaceId);
  if (ensured.has(name)) return name;
  const res = await db.execute(sql`SELECT wsdb_ensure(${workspaceId}::uuid) AS s`);
  const s = String((res.rows[0] as { s: string }).s);
  if (s !== name) throw new WsdbError("Tên schema không khớp", 500);
  ensured.add(name);
  return name;
}

/** Quên cache "đã tạo" (test / sau khi khôi phục). */
export function wsdbForget(workspaceId?: string): void {
  if (workspaceId) ensured.delete(wsdbSchemaName(workspaceId));
  else ensured.clear();
}

/**
 * Chạy fn trong giao dịch mang quyền role của workspace. Dùng cho câu lệnh của
 * người dùng (sau bộ kiểm) và việc nội bộ (bản chụp, khôi phục).
 */
async function asWorkspace<T>(
  db: Db,
  ctx: WorkspaceContext,
  opts: { readOnly: boolean; timeoutMs: number; rollback?: boolean },
  fn: (c: pg.PoolClient, schema: string) => Promise<T>,
): Promise<T> {
  const schema = await wsdbEnsure(db, ctx.workspaceId);
  const client = await poolOf(db).connect();
  let broken = false;
  try {
    await client.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true), set_config('search_path', $4, true)",
      [String(opts.timeoutMs), String(Math.min(opts.timeoutMs, 5000)), String(opts.timeoutMs + 5000), `"${schema}"`],
    );
    // Tên schema đã kiểm bằng regex (chỉ a-z0-9_) — an toàn khi ghép.
    await client.query(`SET LOCAL ROLE "${schema}"`);
    const out = await fn(client, schema);
    // Lớp bảo vệ cuối: câu lệnh không được đổi role giữa chừng
    const who = (await client.query("SELECT current_user AS u")).rows[0] as { u: string };
    if (who.u !== schema) {
      await client.query("ROLLBACK");
      throw new WsdbError("Câu lệnh đã tìm cách đổi quyền — đã hủy", 403);
    }
    await client.query(opts.rollback ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

function jsonSize(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/** Dung lượng CSDL của workspace (byte). */
export async function wsdbSize(db: Db, workspaceId: string): Promise<number> {
  const schema = wsdbSchemaName(workspaceId);
  const res = await db.execute(sql`
    SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'm', 'p')`);
  return Number((res.rows[0] as { n: string | number }).n ?? 0);
}

/** Lỗi PostgreSQL → câu dễ hiểu (giữ nguyên thông báo gốc). */
function pgMessage(err: unknown): string {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
  let m = e.message ?? String(err);
  if (e.code === "57014") m = `Câu lệnh chạy quá lâu, đã dừng (${m})`;
  else if (e.code === "42501") m = `Không đủ quyền: ${m} — CSDL của workspace chỉ dùng bảng của chính nó`;
  else if (e.code === "42P01") m = `${m} — xem danh sách bảng bằng db_schema`;
  else if (e.code === "25006") m = "Lệnh này ghi dữ liệu nhưng đang ở chế độ chỉ đọc";
  if (e.detail) m += ` (${e.detail})`;
  if (e.hint) m += ` Gợi ý: ${e.hint}`;
  return m;
}

const normParam = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
};

/** Chạy SQL của người dùng trong CSDL của workspace. */
export async function wsdbQuery(db: Db, ctx: WorkspaceContext, input: WsdbQueryInput): Promise<WsdbQueryResult> {
  const lim = { ...DEFAULT_WSDB_LIMITS, ...(input.limits ?? {}) };
  const schema = wsdbSchemaName(ctx.workspaceId);
  let check: WsdbCheckResult;
  try {
    check = await checkWsdbSql(input.sql, schema);
  } catch (err) {
    if (err instanceof WsdbGuardError) throw new WsdbError(err.message, 400);
    throw err;
  }
  const params = (input.params ?? []).map(normParam);
  if (params.length && check.statements.length > 1) {
    throw new WsdbError("Có tham số ($1, $2…) thì mỗi lần chỉ chạy MỘT câu lệnh");
  }
  if (kindRank(check.kind) > kindRank(input.allow)) {
    throw new WsdbError(
      check.kind === "ddl"
        ? "Lệnh tạo/sửa/xóa bảng cần quyền đổi cấu trúc (operator trở lên)"
        : "Lệnh ghi dữ liệu cần quyền ghi (operator trở lên / quyền db:write)",
      403,
    );
  }
  if (check.destructive && !input.confirm) {
    const which = check.statements.filter((s) => s.destructive).map((s) => s.sql.slice(0, 120));
    throw new WsdbError(
      `Lệnh có thể xóa nhiều dữ liệu (${which.join(" | ")}) — hỏi lại người dùng, rồi gọi lại với confirm=true. DELETE/UPDATE nên có WHERE.`,
      409,
    );
  }
  const writes = check.kind !== "read";
  if (writes && !input.dryRun) {
    const onlyShrinks = check.statements.every((s) => s.kind === "read" || ["DeleteStmt", "DropStmt", "TruncateStmt"].includes(s.node));
    if (!onlyShrinks) {
      const size = await wsdbSize(db, ctx.workspaceId).catch(() => 0);
      if (size > lim.quotaBytes) {
        throw new WsdbError(
          `CSDL của workspace đã dùng ${(size / 1048576).toFixed(1)} MB, vượt hạn mức ${(lim.quotaBytes / 1048576).toFixed(0)} MB — chỉ còn đọc và xóa. Xóa bớt dữ liệu cũ hoặc nhờ quản trị máy chủ nâng hạn mức.`,
          413,
        );
      }
    }
  }

  const results: WsdbStatementResult[] = [];
  let error: string | null = null;
  try {
    await asWorkspace(db, ctx, { readOnly: !writes, timeoutMs: lim.timeoutMs, rollback: input.dryRun === true }, async (client) => {
      for (const st of check.statements) {
        let text = st.sql;
        // SELECT thuần: lấy tối đa maxRows + 1 dòng để biết có bị cắt không
        if (st.plainSelect) text = `SELECT * FROM (\n${st.sql}\n) AS _penai_q LIMIT ${lim.maxRows + 1}`;
        const r = await client.query({ text, values: params });
        const fields = (r.fields ?? []).map((f) => f.name);
        let rows = (r.rows ?? []) as Record<string, unknown>[];
        let truncated = false;
        if (rows.length > lim.maxRows) {
          rows = rows.slice(0, lim.maxRows);
          truncated = true;
        }
        while (rows.length > 1 && jsonSize(rows) > lim.maxResultBytes) {
          rows = rows.slice(0, Math.floor(rows.length / 2));
          truncated = true;
        }
        results.push({ command: r.command ?? st.node, rowCount: r.rowCount ?? null, fields, rows, truncated });
      }
    });
  } catch (err) {
    if (err instanceof WsdbError) throw err;
    error = pgMessage(err);
  } finally {
    if (writes && !input.dryRun) {
      await wsdbAuditWrite(db, ctx, {
        kind: check.kind === "ddl" ? "ddl" : "write",
        actor: input.actor,
        statement: input.sql,
        rowCount: results.reduce((n, r) => n + (r.rowCount ?? 0), 0),
        destructive: check.destructive,
        error,
      }).catch(() => {});
    }
  }
  if (error) throw new WsdbError(error, 400);
  const last = results[results.length - 1]!;
  return {
    rows: last.rows,
    row: last.rows[0] ?? null,
    count: last.command === "SELECT" ? last.rows.length : (last.rowCount ?? last.rows.length),
    fields: last.fields,
    truncated: last.truncated,
    kind: check.kind,
    dryRun: input.dryRun === true,
    statements: results.map((r) => ({ command: r.command, rowCount: r.rowCount })),
  };
}

// ---------------- nhật ký ----------------

export async function wsdbAuditWrite(
  db: Db,
  ctx: WorkspaceContext,
  e: { kind: string; actor: WsdbActor; statement: string; rowCount?: number | null; destructive?: boolean; error?: string | null },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.insert(wsdbAudit).values({
      workspaceId: ctx.workspaceId,
      kind: e.kind,
      via: e.actor.via,
      actorUserId: e.actor.userId && e.actor.userId !== ctx.workspaceId ? e.actor.userId : null,
      actorAgentId: e.actor.agentId ?? null,
      workflowId: e.actor.workflowId ?? null,
      statement: e.statement.slice(0, 20_000),
      rowCount: e.rowCount ?? null,
      destructive: e.destructive ?? false,
      error: e.error ? e.error.slice(0, 2000) : null,
    }),
  );
}

export async function wsdbAuditList(db: Db, ctx: WorkspaceContext, limit = 100) {
  return withWorkspace(db, ctx, (tx) =>
    tx.select().from(wsdbAudit).orderBy(desc(wsdbAudit.createdAt)).limit(Math.min(Math.max(limit, 1), 500)),
  );
}

// ---------------- cấu trúc ----------------

export interface WsdbColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: boolean;
  primaryKey: boolean;
  unique: boolean;
  comment: string;
}
export interface WsdbTable {
  name: string;
  kind: "table" | "view" | "matview";
  comment: string;
  rowsEstimate: number;
  sizeBytes: number;
  columns: WsdbColumn[];
  primaryKey: string[];
  constraints: Array<{ name: string; type: string; definition: string }>;
  indexes: Array<{ name: string; definition: string }>;
}
export interface WsdbSchemaInfo {
  schema: string;
  sizeBytes: number;
  quotaBytes: number;
  tables: WsdbTable[];
}

/** Cấu trúc CSDL của workspace (đọc catalog, không cần quyền của role). */
export async function wsdbSchema(db: Db, ctx: WorkspaceContext, limits?: Partial<WsdbLimits>): Promise<WsdbSchemaInfo> {
  const schema = await wsdbEnsure(db, ctx.workspaceId);
  const lim = { ...DEFAULT_WSDB_LIMITS, ...(limits ?? {}) };
  const rel = await db.execute(sql`
    SELECT c.oid::bigint AS oid, c.relname AS name, c.relkind AS kind,
      COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment,
      GREATEST(c.reltuples, 0)::bigint AS est,
      pg_total_relation_size(c.oid)::bigint AS size
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relname`);
  const cols = await db.execute(sql`
    SELECT a.attrelid::bigint AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity <> '' AS ident,
      COALESCE(col_description(a.attrelid, a.attnum), '') AS comment
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = ${schema} AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum`);
  const cons = await db.execute(sql`
    SELECT con.conrelid::bigint AS oid, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def,
      ARRAY(SELECT a.attname FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS cols
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE n.nspname = ${schema} AND con.conrelid <> 0`);
  const idx = await db.execute(sql`
    SELECT i.indrelid::bigint AS oid, ci.relname AS name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ci.relnamespace
    WHERE n.nspname = ${schema}
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`);
  type R = Record<string, unknown>;
  const tables: WsdbTable[] = (rel.rows as R[]).map((r) => {
    const oid = String(r.oid);
    const myCons = (cons.rows as R[]).filter((c) => String(c.oid) === oid);
    const pk = myCons.find((c) => c.type === "p");
    const pkCols = pk ? ((pk.cols as string[]) ?? []) : [];
    const uniqCols = new Set(myCons.filter((c) => c.type === "u" && ((c.cols as string[]) ?? []).length === 1).map((c) => (c.cols as string[])[0]));
    return {
      name: String(r.name),
      kind: r.kind === "v" ? "view" : r.kind === "m" ? "matview" : "table",
      comment: String(r.comment ?? ""),
      rowsEstimate: Number(r.est ?? 0),
      sizeBytes: Number(r.size ?? 0),
      columns: (cols.rows as R[])
        .filter((c) => String(c.oid) === oid)
        .map((c) => ({
          name: String(c.name),
          type: String(c.type),
          notNull: c.not_null === true,
          default: c.def === null || c.def === undefined ? null : String(c.def),
          identity: c.ident === true,
          primaryKey: pkCols.includes(String(c.name)),
          unique: uniqCols.has(String(c.name)),
          comment: String(c.comment ?? ""),
        })),
      primaryKey: pkCols,
      constraints: myCons.filter((c) => c.type !== "p").map((c) => ({ name: String(c.name), type: String(c.type), definition: String(c.def) })),
      indexes: (idx.rows as R[]).filter((i) => String(i.oid) === oid).map((i) => ({ name: String(i.name), definition: String(i.def) })),
    };
  });
  // reltuples = -1 khi chưa ANALYZE → đếm thật với bảng nhỏ
  for (const t of tables) {
    if (t.kind === "table" && t.rowsEstimate === 0 && t.sizeBytes < 8 * 1024 * 1024) {
      const n = await asWorkspace(db, ctx, { readOnly: true, timeoutMs: 3000 }, async (c) =>
        Number(((await c.query(`SELECT count(*)::bigint AS n FROM "${t.name.replace(/"/g, '""')}"`)).rows[0] as { n: string }).n),
      ).catch(() => 0);
      t.rowsEstimate = n;
    }
  }
  return { schema, sizeBytes: tables.reduce((n, t) => n + t.sizeBytes, 0), quotaBytes: lim.quotaBytes, tables };
}

/** Bản mô tả gọn cho AI: CREATE TABLE … kèm chú thích. */
export function describeWsdbSchema(info: WsdbSchemaInfo): string {
  if (!info.tables.length) {
    return "CSDL của workspace chưa có bảng nào. Tạo bằng db_query: CREATE TABLE ten_bang (...); rồi COMMENT ON TABLE ten_bang IS 'mô tả';";
  }
  const lines = [`CSDL của workspace: ${info.tables.length} bảng, ${(info.sizeBytes / 1048576).toFixed(2)} MB / ${(info.quotaBytes / 1048576).toFixed(0)} MB.`];
  for (const t of info.tables) {
    lines.push("");
    if (t.comment) lines.push(`-- ${t.comment}`);
    lines.push(`${t.kind === "table" ? "TABLE" : t.kind === "view" ? "VIEW" : "MATERIALIZED VIEW"} ${t.name} (~${t.rowsEstimate} dòng)`);
    for (const c of t.columns) {
      lines.push(
        `  ${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.unique ? " UNIQUE" : ""}${c.identity ? " (tự tăng)" : ""}${c.notNull && !c.primaryKey ? " NOT NULL" : ""}` +
          `${c.default && !c.identity ? ` DEFAULT ${c.default}` : ""}${c.comment ? `  -- ${c.comment}` : ""}`,
      );
    }
    for (const k of t.constraints) lines.push(`  CONSTRAINT ${k.name} ${k.definition}`);
    for (const i of t.indexes) lines.push(`  ${i.definition.replace(/ ON "?wsdb_[0-9a-f]+"?\./, " ON ")}`);
  }
  return lines.join("\n");
}

// ---------------- bản chụp + khôi phục ----------------

/** Câu CREATE TABLE dựng lại bảng từ catalog (cột, mặc định, tự tăng, ràng buộc trừ khóa ngoại). */
function tableDdl(t: WsdbTable): { create: string; foreignKeys: string[]; indexes: string[]; comments: string[] } {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts = t.columns.map((c) => {
    let def = `${q(c.name)} ${c.type}`;
    const serial = c.default && /^nextval\(/i.test(c.default);
    if (c.identity || serial) def += " GENERATED BY DEFAULT AS IDENTITY";
    else if (c.default) def += ` DEFAULT ${c.default}`;
    if (c.notNull) def += " NOT NULL";
    return def;
  });
  if (t.primaryKey.length) parts.push(`PRIMARY KEY (${t.primaryKey.map(q).join(", ")})`);
  for (const k of t.constraints) if (k.type !== "f") parts.push(`CONSTRAINT ${q(k.name)} ${k.definition}`);
  const comments: string[] = [];
  if (t.comment) comments.push(`COMMENT ON TABLE ${q(t.name)} IS ${lit(t.comment)}`);
  for (const c of t.columns) if (c.comment) comments.push(`COMMENT ON COLUMN ${q(t.name)}.${q(c.name)} IS ${lit(c.comment)}`);
  return {
    create: `CREATE TABLE ${q(t.name)} (\n  ${parts.join(",\n  ")}\n)`,
    foreignKeys: t.constraints.filter((k) => k.type === "f").map((k) => `ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(k.name)} ${k.definition}`),
    indexes: t.indexes.map((i) => i.definition.replace(/ ON "?wsdb_[0-9a-f]+"?\./, " ON ")),
    comments,
  };
}

interface SnapshotPayload {
  tables: Array<{ name: string; table: WsdbTable; rows: unknown[] }>;
}

/** Chụp toàn bộ bảng của workspace (bỏ qua khi lớn hơn maxBytes). */
export async function wsdbTakeSnapshot(
  db: Db,
  ctx: WorkspaceContext,
  opts: { manual?: boolean; maxBytes?: number; keep?: number } = {},
): Promise<{ id: string; tables: number; sizeBytes: number } | { skipped: string }> {
  const info = await wsdbSchema(db, ctx);
  const tables = info.tables.filter((t) => t.kind === "table");
  if (!tables.length) return { skipped: "Chưa có bảng nào" };
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  if (info.sizeBytes > maxBytes) return { skipped: `CSDL ${(info.sizeBytes / 1048576).toFixed(0)} MB lớn hơn trần chụp ${(maxBytes / 1048576).toFixed(0)} MB — dùng sudo penai backup` };
  const payload: SnapshotPayload = { tables: [] };
  await asWorkspace(db, ctx, { readOnly: true, timeoutMs: 120_000 }, async (c) => {
    for (const t of tables) {
      const r = await c.query(`SELECT COALESCE(json_agg(t), '[]'::json) AS rows FROM "${t.name.replace(/"/g, '""')}" t`);
      payload.tables.push({ name: t.name, table: t, rows: (r.rows[0] as { rows: unknown[] }).rows });
    }
  });
  const data = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const row = await withWorkspace(db, ctx, async (tx) => {
    const ins = await tx
      .insert(wsdbSnapshots)
      .values({
        workspaceId: ctx.workspaceId,
        manual: opts.manual === true,
        tables: payload.tables.map((t) => ({ name: t.name, rows: t.rows.length })),
        data,
        sizeBytes: data.length,
      })
      .returning({ id: wsdbSnapshots.id });
    // Giữ `keep` bản tự động gần nhất + 5 bản chụp tay
    const keep = opts.keep ?? 7;
    await tx.execute(sql`
      DELETE FROM wsdb_snapshots s USING (
        SELECT id, row_number() OVER (PARTITION BY manual ORDER BY taken_at DESC) AS rn, manual FROM wsdb_snapshots
      ) x WHERE s.id = x.id AND ((NOT x.manual AND x.rn > ${keep}) OR (x.manual AND x.rn > 5))`);
    return ins[0]!;
  });
  return { id: row.id, tables: payload.tables.length, sizeBytes: data.length };
}

export async function wsdbListSnapshots(db: Db, ctx: WorkspaceContext) {
  return withWorkspace(db, ctx, (tx) =>
    tx
      .select({ id: wsdbSnapshots.id, takenAt: wsdbSnapshots.takenAt, manual: wsdbSnapshots.manual, tables: wsdbSnapshots.tables, sizeBytes: wsdbSnapshots.sizeBytes })
      .from(wsdbSnapshots)
      .orderBy(desc(wsdbSnapshots.takenAt))
      .limit(50),
  );
}

export async function wsdbLastSnapshotAt(db: Db, ctx: WorkspaceContext): Promise<Date | null> {
  const r = await withWorkspace(db, ctx, (tx) =>
    tx.select({ t: wsdbSnapshots.takenAt }).from(wsdbSnapshots).where(eq(wsdbSnapshots.manual, false)).orderBy(desc(wsdbSnapshots.takenAt)).limit(1),
  );
  return r[0]?.t ?? null;
}

/** Khôi phục MỘT bảng về đúng bản chụp (tạo lại nếu đã xóa; thay toàn bộ dữ liệu hiện có). */
export async function wsdbRestoreTable(db: Db, ctx: WorkspaceContext, snapshotId: string, table: string, actor: WsdbActor): Promise<{ rows: number; recreated: boolean }> {
  const snap = await withWorkspace(db, ctx, (tx) => tx.select().from(wsdbSnapshots).where(and(eq(wsdbSnapshots.id, snapshotId))).limit(1));
  if (!snap[0]) throw new WsdbError("Không có bản chụp này", 404);
  const payload = JSON.parse(gunzipSync(snap[0].data).toString("utf8")) as SnapshotPayload;
  const t = payload.tables.find((x) => x.name === table);
  if (!t) throw new WsdbError(`Bản chụp không có bảng "${table}"`, 404);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const exists = (await wsdbSchema(db, ctx)).tables.some((x) => x.name === table && x.kind === "table");
  const ddl = tableDdl(t.table);
  let rows = 0;
  try {
    await asWorkspace(db, ctx, { readOnly: false, timeoutMs: 120_000 }, async (c) => {
      if (!exists) {
        await c.query(ddl.create);
        for (const s of [...ddl.indexes, ...ddl.comments]) await c.query(s);
      } else await c.query(`TRUNCATE ${q(table)}`);
      if (t.rows.length) {
        const r = await c.query(`INSERT INTO ${q(table)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${q(table)}, $1::json)`, [JSON.stringify(t.rows)]);
        rows = r.rowCount ?? 0;
      }
      // Đưa bộ đếm tự tăng về sau giá trị lớn nhất
      for (const col of t.table.columns.filter((x) => x.identity || (x.default && /^nextval\(/i.test(x.default)))) {
        await c.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(max(${q(col.name)}), 0) FROM ${q(table)}), 1))`,
          [q(table), col.name],
        );
      }
      for (const fk of ddl.foreignKeys) {
        if (exists) break;
        await c.query("SAVEPOINT fk");
        try {
          await c.query(fk);
          await c.query("RELEASE SAVEPOINT fk");
        } catch {
          await c.query("ROLLBACK TO SAVEPOINT fk");
        }
      }
    });
  } catch (err) {
    throw new WsdbError(`Khôi phục lỗi: ${pgMessage(err)}`, 400);
  }
  await wsdbAuditWrite(db, ctx, {
    kind: "restore",
    actor,
    statement: `-- khôi phục bảng ${table} từ bản chụp ${snap[0].takenAt.toISOString()}${exists ? "" : " (tạo lại bảng)"}`,
    rowCount: rows,
    destructive: exists,
  }).catch(() => {});
  return { rows, recreated: !exists };
}

/** Các workspace đã có CSDL (bộ chụp hằng ngày). */
export async function wsdbListWorkspaces(db: Db): Promise<string[]> {
  const res = await db.execute(sql`SELECT workspace_id FROM wsdb_list_workspaces()`);
  return (res.rows as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
}

// ---------------- nhập / xuất ----------------

/** Thêm nhiều dòng vào bảng (nhập CSV) trong MỘT giao dịch; replace = xóa dữ liệu cũ trước. */
export async function wsdbInsertRows(
  db: Db,
  ctx: WorkspaceContext,
  input: { table: string; columns: string[]; rows: unknown[][]; replace: boolean; actor: WsdbActor; limits?: Partial<WsdbLimits> },
): Promise<{ inserted: number }> {
  const lim = { ...DEFAULT_WSDB_LIMITS, ...(input.limits ?? {}) };
  const info = await wsdbSchema(db, ctx, lim);
  const t = info.tables.find((x) => x.name === input.table && x.kind === "table");
  if (!t) throw new WsdbError(`Không có bảng "${input.table}"`, 404);
  const known = new Set(t.columns.map((c) => c.name));
  const bad = input.columns.filter((c) => !known.has(c));
  if (bad.length) throw new WsdbError(`Bảng ${t.name} không có cột: ${bad.join(", ")} (có: ${[...known].join(", ")})`);
  if (info.sizeBytes > lim.quotaBytes) throw new WsdbError("CSDL đã vượt hạn mức dung lượng — chỉ còn đọc và xóa", 413);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  let inserted = 0;
  let error: string | null = null;
  try {
    await asWorkspace(db, ctx, { readOnly: false, timeoutMs: 120_000 }, async (c) => {
      if (input.replace) await c.query(`DELETE FROM ${q(t.name)}`);
      const batch = Math.max(1, Math.floor(5000 / Math.max(1, input.columns.length)));
      for (let i = 0; i < input.rows.length; i += batch) {
        const chunk = input.rows.slice(i, i + batch);
        const values: unknown[] = [];
        const tuples = chunk.map((r) => `(${input.columns.map((_, j) => {
          const v = r[j];
          values.push(v === "" || v === undefined ? null : v);
          return `$${values.length}`;
        }).join(", ")})`);
        const r = await c.query(`INSERT INTO ${q(t.name)} (${input.columns.map(q).join(", ")}) VALUES ${tuples.join(", ")}`, values);
        inserted += r.rowCount ?? 0;
      }
    });
  } catch (err) {
    error = pgMessage(err);
  }
  await wsdbAuditWrite(db, ctx, {
    kind: "import",
    actor: input.actor,
    statement: `-- nhập ${input.rows.length} dòng vào ${t.name}${input.replace ? " (thay toàn bộ dữ liệu cũ)" : ""}`,
    rowCount: inserted,
    destructive: input.replace,
    error,
  }).catch(() => {});
  if (error) throw new WsdbError(`Nhập lỗi, không dòng nào được thêm: ${error}`);
  return { inserted };
}
