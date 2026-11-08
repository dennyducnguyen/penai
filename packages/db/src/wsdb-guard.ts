/**
 * Bộ kiểm câu lệnh SQL cho CSDL của workspace — dùng bộ phân tích cú pháp THẬT của
 * PostgreSQL (libpg-query, WASM) rồi duyệt cây cú pháp:
 *
 *   • Chỉ cho các loại lệnh trong danh sách (SELECT, INSERT, UPDATE, DELETE, MERGE,
 *     CREATE/ALTER/DROP TABLE|VIEW|INDEX|SEQUENCE, TRUNCATE, COMMENT, EXPLAIN…).
 *   • Chặn đổi quyền / thoát khỏi role của workspace: SET, RESET, set_config(),
 *     hàm chạy SQL động (query_to_xml…), dblink, large object, hàm/bảng hệ thống pg_*.
 *   • Chặn tham chiếu schema khác (schema của workspace khác, public của PenAI).
 *   • Phân loại: read / write / ddl, và "phá dữ liệu" (DROP, TRUNCATE, DELETE/UPDATE
 *     không có WHERE, xóa cột) — cần xác nhận.
 *
 * Đây là lớp thứ 3; hai lớp kia: role của workspace không có quyền ngoài schema của
 * nó, và câu lệnh chạy trong giao dịch SET LOCAL ROLE + statement_timeout.
 */
import { loadModule, parse } from "libpg-query";

export type WsdbStatementKind = "read" | "write" | "ddl";

export interface WsdbStatement {
  /** Câu lệnh gốc (đã cắt riêng từ chuỗi nhiều lệnh). */
  sql: string;
  /** Loại nút gốc trong cây cú pháp, vd SelectStmt. */
  node: string;
  kind: WsdbStatementKind;
  /** DROP, TRUNCATE, DELETE/UPDATE không WHERE, xóa cột → cần xác nhận. */
  destructive: boolean;
  /** SELECT thuần (bọc LIMIT được). */
  plainSelect: boolean;
  /** Bảng/view được đọc. */
  reads: string[];
  /** Bảng/view được ghi hoặc đổi cấu trúc. */
  writes: string[];
}

export interface WsdbCheckResult {
  statements: WsdbStatement[];
  /** Mức cao nhất: read < write < ddl. */
  kind: WsdbStatementKind;
  destructive: boolean;
}

export class WsdbGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsdbGuardError";
  }
}

const RANK: Record<WsdbStatementKind, number> = { read: 0, write: 1, ddl: 2 };
export function kindRank(k: WsdbStatementKind): number {
  return RANK[k];
}

/** Hàm bị chặn (tên cuối, không phân biệt hoa thường). Mọi hàm bắt đầu bằng pg_ cũng bị chặn trừ danh sách cho phép. */
const DENY_FUNCS = new Set([
  "set_config",
  "current_setting",
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "table_to_xml",
  "table_to_xmlschema",
  "table_to_xml_and_xmlschema",
  "schema_to_xml",
  "schema_to_xmlschema",
  "schema_to_xml_and_xmlschema",
  "database_to_xml",
  "database_to_xmlschema",
  "database_to_xml_and_xmlschema",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_connect_u",
  "lo_import",
  "lo_export",
  "lo_create",
  "lo_creat",
  "lo_open",
  "lo_unlink",
  "lo_get",
  "lo_put",
  "lo_from_bytea",
  "lowrite",
  "loread",
  "txid_current",
  "inet_server_addr",
  "inet_server_port",
  "inet_client_addr",
  "inet_client_port",
  "version",
  "has_table_privilege",
  "has_schema_privilege",
  "has_database_privilege",
  "has_function_privilege",
  "to_regclass",
  "to_regnamespace",
  "to_regrole",
  "to_regproc",
  "to_regprocedure",
  "to_regtype",
]);
const ALLOW_PG_FUNCS = new Set(["pg_typeof", "pg_column_size"]);

/** Lệnh được phép → loại. Lệnh không có trong bảng bị từ chối. */
const NODE_KIND: Record<string, WsdbStatementKind> = {
  SelectStmt: "read",
  ExplainStmt: "read",
  InsertStmt: "write",
  UpdateStmt: "write",
  DeleteStmt: "write",
  MergeStmt: "write",
  CreateStmt: "ddl",
  CreateTableAsStmt: "ddl",
  ViewStmt: "ddl",
  IndexStmt: "ddl",
  AlterTableStmt: "ddl",
  RenameStmt: "ddl",
  CommentStmt: "ddl",
  CreateSeqStmt: "ddl",
  AlterSeqStmt: "ddl",
  DropStmt: "ddl",
  TruncateStmt: "ddl",
  RefreshMatViewStmt: "ddl",
};

const ALLOWED_DROP = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_INDEX", "OBJECT_SEQUENCE", "OBJECT_MATVIEW"]);
const ALLOWED_RENAME = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_INDEX", "OBJECT_SEQUENCE", "OBJECT_MATVIEW", "OBJECT_COLUMN", "OBJECT_TABCONSTRAINT"]);
const ALLOWED_COMMENT = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_COLUMN", "OBJECT_INDEX", "OBJECT_SEQUENCE", "OBJECT_MATVIEW"]);
const DENY_ALTER_CMDS = new Set([
  "AT_ChangeOwner",
  "AT_SetTableSpace",
  "AT_EnableTrig",
  "AT_EnableAlwaysTrig",
  "AT_EnableReplicaTrig",
  "AT_DisableTrig",
  "AT_EnableTrigAll",
  "AT_DisableTrigAll",
  "AT_EnableTrigUser",
  "AT_DisableTrigUser",
  "AT_EnableRule",
  "AT_EnableAlwaysRule",
  "AT_EnableReplicaRule",
  "AT_DisableRule",
  "AT_ReplicaIdentity",
  "AT_SetAccessMethod",
]);
/** Schema được nhắc tới ngoài schema của workspace. */
const OK_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

const NODE_LABEL: Record<string, string> = {
  VariableSetStmt: "SET / RESET",
  VariableShowStmt: "SHOW",
  TransactionStmt: "BEGIN / COMMIT / ROLLBACK",
  DoStmt: "DO",
  CreateFunctionStmt: "CREATE FUNCTION",
  CreateTrigStmt: "CREATE TRIGGER",
  CopyStmt: "COPY",
  GrantStmt: "GRANT / REVOKE",
  GrantRoleStmt: "GRANT / REVOKE ROLE",
  CreateRoleStmt: "CREATE ROLE",
  AlterRoleStmt: "ALTER ROLE",
  CreateSchemaStmt: "CREATE SCHEMA",
  CreateExtensionStmt: "CREATE EXTENSION",
  CallStmt: "CALL",
  LockStmt: "LOCK",
  VacuumStmt: "VACUUM / ANALYZE",
  PrepareStmt: "PREPARE",
  ExecuteStmt: "EXECUTE",
  ListenStmt: "LISTEN",
  NotifyStmt: "NOTIFY",
  RuleStmt: "CREATE RULE",
  CreatePolicyStmt: "CREATE POLICY",
};

let loaded: Promise<void> | null = null;
async function ready(): Promise<void> {
  if (!loaded) loaded = loadModule();
  return loaded;
}

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => !!v && typeof v === "object" && !Array.isArray(v);

function strOf(v: unknown): string {
  // {"String":{"sval":"x"}}
  if (isObj(v) && isObj(v.String)) return String((v.String as Node).sval ?? "");
  return "";
}
function namesOf(list: unknown): string[] {
  return Array.isArray(list) ? list.map(strOf) : [];
}

/** Cắt chuỗi nhiều lệnh thành từng lệnh theo vị trí trong cây cú pháp (đơn vị byte UTF-8). */
function sliceStatement(buf: Buffer, loc: number, len: number | undefined): string {
  const end = len && len > 0 ? loc + len : buf.length;
  return buf.subarray(loc, end).toString("utf8").trim().replace(/;\s*$/, "");
}

interface WalkState {
  schema: string;
  reads: Set<string>;
  writes: Set<string>;
  hasDmlCte: boolean;
  ctes: Set<string>;
}

function checkSchemaRef(schemaname: string, what: string, st: WalkState) {
  if (!schemaname) return;
  const s = schemaname.toLowerCase();
  if (s === st.schema) return;
  if (OK_SCHEMAS.has(s) && what !== "bảng") return;
  if (s === "information_schema" && what === "bảng") return;
  throw new WsdbGuardError(`Không dùng được schema "${schemaname}" — CSDL của workspace chỉ có bảng của chính nó (bỏ tên schema đi).`);
}

const REG_TYPES = new Set(["regclass", "regnamespace", "regrole", "regproc", "regprocedure", "regoper", "regoperator", "regtype", "regconfig", "regdictionary", "regcollation"]);

/** Một tham chiếu bảng (RangeVar) — có thể nằm trần (relation, rel, view…) hoặc bọc trong {"RangeVar": …}. */
function visitRangeVar(val: Node, st: WalkState, writeTarget: boolean) {
  const rel = String(val.relname ?? "");
  const schemaname = String(val.schemaname ?? "");
  if (val.catalogname) throw new WsdbGuardError("Không tham chiếu database khác.");
  checkSchemaRef(schemaname, "bảng", st);
  if (!schemaname && /^pg_/i.test(rel)) throw new WsdbGuardError(`Không đọc được bảng hệ thống "${rel}". Xem cấu trúc bằng db_schema.`);
  if (String(val.relpersistence ?? "p") === "t") throw new WsdbGuardError("Không tạo bảng tạm (TEMP) — tạo bảng thường hoặc dùng WITH … AS (…).");
  if (!schemaname || schemaname.toLowerCase() === st.schema) (writeTarget ? st.writes : st.reads).add(rel.toLowerCase());
}

/** Duyệt toàn bộ cây: hàm bị chặn, schema lạ, bảng hệ thống. */
function walk(node: unknown, st: WalkState, writeTarget = false): void {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, st);
    return;
  }
  if (!isObj(node)) return;
  if (typeof node.relname === "string") {
    visitRangeVar(node, st, writeTarget);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === "FuncCall" && isObj(val)) {
      const parts = namesOf(val.funcname).map((x) => x.toLowerCase());
      const fn = parts[parts.length - 1] ?? "";
      if (parts.length > 1) checkSchemaRef(parts[0]!, "hàm", st);
      if (DENY_FUNCS.has(fn) || (fn.startsWith("pg_") && !ALLOW_PG_FUNCS.has(fn))) {
        throw new WsdbGuardError(`Không được gọi hàm ${fn}() trong CSDL của workspace.`);
      }
    } else if ((key === "TypeName" || key === "typeName") && isObj(val)) {
      const parts = namesOf(val.names).map((x) => x.toLowerCase());
      if (parts.length > 1 && parts[0] !== "pg_catalog") checkSchemaRef(parts[0]!, "type", st);
      if (REG_TYPES.has(parts[parts.length - 1] ?? "")) throw new WsdbGuardError(`Không dùng kiểu ${parts[parts.length - 1]} trong CSDL của workspace.`);
    } else if ((key === "InsertStmt" || key === "UpdateStmt" || key === "DeleteStmt" || key === "MergeStmt") && isObj(val)) {
      st.hasDmlCte = true;
    } else if (key === "CommonTableExpr" && isObj(val) && typeof val.ctename === "string") {
      st.ctes.add(val.ctename.toLowerCase());
    }
    walk(val, st, false);
  }
}

function tableName(rel: unknown): string {
  return isObj(rel) ? String(rel.relname ?? "").toLowerCase() : "";
}

/** Phân tích + kiểm. Ném WsdbGuardError (thông báo tiếng Việt) khi bị từ chối. */
export async function checkWsdbSql(sqlText: string, schema: string): Promise<WsdbCheckResult> {
  await ready();
  const text = String(sqlText ?? "");
  if (!text.trim()) throw new WsdbGuardError("Câu SQL trống");
  if (text.length > 200_000) throw new WsdbGuardError("Câu SQL quá dài (> 200.000 ký tự)");
  let tree: { stmts?: Array<{ stmt?: Node; stmt_location?: number; stmt_len?: number }> };
  try {
    tree = (await parse(text)) as typeof tree;
  } catch (err) {
    throw new WsdbGuardError(`Lỗi cú pháp SQL: ${(err as Error).message}`);
  }
  const stmts = tree.stmts ?? [];
  if (!stmts.length) throw new WsdbGuardError("Không có câu lệnh nào");
  if (stmts.length > 50) throw new WsdbGuardError("Tối đa 50 câu lệnh mỗi lần");
  const buf = Buffer.from(text, "utf8");
  const out: WsdbStatement[] = [];
  for (const s of stmts) {
    const raw = s.stmt ?? {};
    const node = Object.keys(raw)[0] ?? "";
    const body = (raw[node] ?? {}) as Node;
    let kind = NODE_KIND[node];
    if (!kind) {
      const label = NODE_LABEL[node] ?? node.replace(/Stmt$/, "").toUpperCase();
      throw new WsdbGuardError(
        `Lệnh ${label} không dùng được trong CSDL của workspace. Được dùng: SELECT, INSERT, UPDATE, DELETE, MERGE, CREATE/ALTER/DROP TABLE|VIEW|INDEX|SEQUENCE, TRUNCATE, COMMENT, EXPLAIN. ` +
          (node === "TransactionStmt" ? "Mỗi lần gọi đã là MỘT giao dịch (lỗi một lệnh thì hủy cả gói) — không cần BEGIN/COMMIT." : ""),
      );
    }
    const st: WalkState = { schema: schema.toLowerCase(), reads: new Set(), writes: new Set(), hasDmlCte: false, ctes: new Set<string>() };
    let destructive = false;
    let plainSelect = false;
    const target = (rel: unknown) => {
      const t = tableName(rel);
      if (t) st.writes.add(t);
    };

    switch (node) {
      case "SelectStmt": {
        if (body.intoClause) {
          kind = "ddl";
          target((body.intoClause as Node).rel);
        }
        walk(body, st);
        if (st.hasDmlCte) kind = kind === "ddl" ? "ddl" : "write";
        plainSelect = kind === "read" && !body.lockingClause;
        if (body.lockingClause) kind = "write";
        break;
      }
      case "ExplainStmt": {
        const opts = Array.isArray(body.options) ? (body.options as Node[]) : [];
        const analyze = opts.some((o) => isObj(o.DefElem) && String((o.DefElem as Node).defname).toLowerCase() === "analyze");
        const inner = await checkInner(body.query as Node, schema);
        if (analyze && inner.kind !== "read") kind = inner.kind;
        destructive = analyze && inner.destructive;
        inner.reads.forEach((x) => st.reads.add(x));
        break;
      }
      case "InsertStmt":
        target(body.relation);
        walk(body, st);
        break;
      case "UpdateStmt":
      case "DeleteStmt":
        target(body.relation);
        if (!body.whereClause) destructive = true;
        walk(body, st);
        break;
      case "MergeStmt":
        target(body.relation);
        walk(body, st);
        break;
      case "CreateStmt":
      case "IndexStmt":
      case "AlterSeqStmt":
      case "CreateSeqStmt":
        target(body.relation ?? body.sequence);
        if (node === "CreateStmt" && Array.isArray(body.inhRelations) && body.inhRelations.length) {
          throw new WsdbGuardError("Không dùng INHERITS — tạo bảng độc lập.");
        }
        walk(body, st);
        break;
      case "CreateTableAsStmt":
        target((body.into as Node | undefined)?.rel);
        walk(body, st);
        break;
      case "ViewStmt":
        target(body.view);
        walk(body, st);
        break;
      case "RefreshMatViewStmt":
        target(body.relation);
        walk(body, st);
        break;
      case "AlterTableStmt": {
        const objtype = String(body.objtype ?? "OBJECT_TABLE");
        if (!["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_INDEX", "OBJECT_SEQUENCE", "OBJECT_MATVIEW"].includes(objtype)) {
          throw new WsdbGuardError(`ALTER ${objtype.replace("OBJECT_", "")} không dùng được.`);
        }
        for (const c of (body.cmds as Node[]) ?? []) {
          const cmd = (c.AlterTableCmd ?? {}) as Node;
          const sub = String(cmd.subtype ?? "");
          if (DENY_ALTER_CMDS.has(sub)) throw new WsdbGuardError(`ALTER TABLE … ${sub.replace(/^AT_/, "")} không dùng được.`);
          if (sub === "AT_DropColumn") destructive = true;
        }
        target(body.relation);
        walk(body, st);
        break;
      }
      case "RenameStmt": {
        const rt = String(body.renameType ?? "");
        if (!ALLOWED_RENAME.has(rt)) throw new WsdbGuardError(`Đổi tên ${rt.replace("OBJECT_", "")} không dùng được.`);
        target(body.relation);
        walk(body, st);
        break;
      }
      case "CommentStmt": {
        const ot = String(body.objtype ?? "");
        if (!ALLOWED_COMMENT.has(ot)) throw new WsdbGuardError(`COMMENT ON ${ot.replace("OBJECT_", "")} không dùng được.`);
        walkObjectNames(body.object, ot === "OBJECT_COLUMN" ? 2 : 1, st);
        break;
      }
      case "DropStmt": {
        const rt = String(body.removeType ?? "");
        if (!ALLOWED_DROP.has(rt)) throw new WsdbGuardError(`DROP ${rt.replace("OBJECT_", "")} không dùng được.`);
        destructive = true;
        for (const o of (body.objects as unknown[]) ?? []) {
          const names = isObj(o) && isObj(o.List) ? namesOf((o.List as Node).items) : [];
          if (names.length > 1) checkSchemaRef(names[0]!, "bảng", st);
          const n = names[names.length - 1];
          if (n) st.writes.add(n.toLowerCase());
        }
        break;
      }
      case "TruncateStmt":
        destructive = true;
        for (const r of (body.relations as unknown[]) ?? []) {
          walk(r, st);
          target(isObj(r) ? r.RangeVar : null);
        }
        break;
    }
    // Lệnh ghi/ddl: đọc lại cả cây một lượt để chắc không sót hàm/bảng bị chặn
    if (node !== "ExplainStmt") walk(body, { ...st, reads: new Set(), writes: new Set(), hasDmlCte: false, ctes: new Set<string>() });
    for (const w of st.writes) st.reads.delete(w);
    for (const c of st.ctes) st.reads.delete(c);
    out.push({
      sql: sliceStatement(buf, s.stmt_location ?? 0, s.stmt_len),
      node,
      kind,
      destructive,
      plainSelect,
      reads: [...st.reads],
      writes: [...st.writes],
    });
  }
  const top = out.reduce<WsdbStatementKind>((m, x) => (RANK[x.kind] > RANK[m] ? x.kind : m), "read");
  return { statements: out, kind: top, destructive: out.some((x) => x.destructive) };
}

function walkObjectNames(obj: unknown, base: number, st: WalkState) {
  const names = isObj(obj) && isObj(obj.List) ? namesOf((obj.List as Node).items) : [];
  if (names.length > base) checkSchemaRef(names[0]!, "bảng", st);
  const t = names[names.length - base];
  if (t) st.writes.add(t.toLowerCase());
}

/** Kiểm lệnh bên trong EXPLAIN. */
async function checkInner(q: Node | undefined, schema: string): Promise<{ kind: WsdbStatementKind; destructive: boolean; reads: string[] }> {
  if (!q) return { kind: "read", destructive: false, reads: [] };
  const node = Object.keys(q)[0] ?? "";
  if (!["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"].includes(node)) {
    throw new WsdbGuardError("EXPLAIN chỉ dùng với SELECT / INSERT / UPDATE / DELETE / MERGE");
  }
  const st: WalkState = { schema: schema.toLowerCase(), reads: new Set(), writes: new Set(), hasDmlCte: false, ctes: new Set<string>() };
  walk(q, st);
  const body = (q[node] ?? {}) as Node;
  const kind: WsdbStatementKind = node === "SelectStmt" && !st.hasDmlCte ? "read" : "write";
  const destructive = (node === "UpdateStmt" || node === "DeleteStmt") && !body.whereClause;
  return { kind, destructive, reads: [...st.reads] };
}

/** Bảng được nhắc tới trong một câu SQL (để hiện "Dùng bởi"); lỗi cú pháp → rỗng. */
export async function wsdbTablesOf(sqlText: string, schema: string): Promise<{ reads: string[]; writes: string[] } | null> {
  try {
    const r = await checkWsdbSql(sqlText, schema);
    const reads = new Set<string>();
    const writes = new Set<string>();
    for (const s of r.statements) {
      s.reads.forEach((x) => reads.add(x));
      s.writes.forEach((x) => writes.add(x));
    }
    for (const w of writes) reads.delete(w);
    return { reads: [...reads], writes: [...writes] };
  } catch {
    return null;
  }
}
