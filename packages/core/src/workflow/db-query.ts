/**
 * Dựng câu SQL (có tham số $1, $2…) từ form "Chọn" của bước 🗃️ Cơ sở dữ liệu và
 * của trang Dữ liệu (thêm/sửa/xóa dòng, tạo bảng). Thuần logic — dùng chung cho
 * bộ chạy quy trình, API và Dashboard (nút "Xem SQL").
 *
 * Tên bảng/cột luôn được đặt trong "…" (không bao giờ ghép giá trị người dùng vào
 * câu lệnh); giá trị luôn đi bằng tham số.
 */

export type DbOp = "insert" | "upsert" | "update" | "delete" | "find" | "count" | "aggregate";
export const DB_OPS: DbOp[] = ["insert", "upsert", "update", "delete", "find", "count", "aggregate"];

export type DbWhereOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts"
  | "in"
  | "null"
  | "notnull"
  | "sameday";
export const DB_WHERE_OPS: Record<DbWhereOp, string> = {
  eq: "=",
  ne: "khác",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "chứa",
  starts: "bắt đầu bằng",
  in: "thuộc danh sách",
  null: "trống",
  notnull: "không trống",
  sameday: "cùng ngày với",
};

export interface DbWhere {
  col: string;
  op?: DbWhereOp;
  value?: unknown;
}

export interface DbForm {
  op: DbOp;
  table: string;
  /** insert / upsert / update: { cột: giá trị } — giá trị { "$inc": n } = cộng thêm. */
  values?: Record<string, unknown>;
  /** upsert: cột khóa để nhận ra dòng đã có (khóa chính hoặc cột duy nhất). */
  match?: string[];
  /** upsert: trùng khóa thì cập nhật (mặc định) hay bỏ qua. */
  onConflict?: "update" | "ignore";
  where?: DbWhere[];
  /** find: các cột lấy về (mặc định *). */
  columns?: string[];
  /** aggregate: phép tính. */
  agg?: Array<{ fn: "count" | "sum" | "avg" | "min" | "max"; col?: string; as?: string }>;
  groupBy?: string[];
  /** [{ col, dir }] hoặc chuỗi "-diem,ten" (dấu - = giảm dần). */
  orderBy?: Array<{ col: string; dir?: "asc" | "desc" }> | string;
  limit?: number;
  offset?: number;
  /** insert/upsert/update/delete: trả các dòng bị ảnh hưởng (mặc định true). */
  returning?: boolean;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  kind: "read" | "write";
  /** DELETE/UPDATE không điều kiện. */
  destructive: boolean;
}

export class DbFormError extends Error {}

/** "tên" → "\"tên\"" (an toàn cho mọi ký tự). */
export function quoteIdent(name: unknown): string {
  const s = String(name ?? "").trim();
  if (!s) throw new DbFormError("Thiếu tên bảng/cột");
  if (s.length > 63) throw new DbFormError(`Tên "${s.slice(0, 20)}…" dài quá 63 ký tự`);
  if (s.includes("\u0000")) throw new DbFormError("Tên có ký tự không hợp lệ");
  return `"${s.replace(/"/g, '""')}"`;
}

export function quoteLiteral(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Giá trị → tham số: object/array lưu dạng JSON (cột jsonb), chuỗi rỗng giữ nguyên. */
function paramValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

const isIncr = (v: unknown): v is { $inc: unknown } => !!v && typeof v === "object" && !Array.isArray(v) && "$inc" in (v as object);

export function buildDbQuery(form: DbForm): BuiltQuery {
  if (!form || typeof form !== "object") throw new DbFormError("Thiếu cấu hình bước");
  const op = form.op;
  if (!DB_OPS.includes(op)) throw new DbFormError(`Thao tác "${String(op)}" không có — dùng: ${DB_OPS.join(", ")}`);
  const t = quoteIdent(form.table);
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(paramValue(v));
    return `$${params.length}`;
  };

  const where = (): string => {
    const parts: string[] = [];
    for (const w of form.where ?? []) {
      if (!w || !w.col) continue;
      const c = quoteIdent(w.col);
      const o = (w.op ?? "eq") as DbWhereOp;
      switch (o) {
        case "eq":
          parts.push(w.value === null ? `${c} IS NULL` : `${c} = ${p(w.value)}`);
          break;
        case "ne":
          parts.push(w.value === null ? `${c} IS NOT NULL` : `${c} IS DISTINCT FROM ${p(w.value)}`);
          break;
        case "gt":
          parts.push(`${c} > ${p(w.value)}`);
          break;
        case "gte":
          parts.push(`${c} >= ${p(w.value)}`);
          break;
        case "lt":
          parts.push(`${c} < ${p(w.value)}`);
          break;
        case "lte":
          parts.push(`${c} <= ${p(w.value)}`);
          break;
        case "contains":
          parts.push(`${c}::text ILIKE '%' || ${p(String(w.value ?? ""))} || '%'`);
          break;
        case "starts":
          parts.push(`${c}::text ILIKE ${p(String(w.value ?? ""))} || '%'`);
          break;
        case "in": {
          const arr = Array.isArray(w.value) ? w.value : String(w.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          if (!arr.length) parts.push("FALSE");
          else parts.push(`${c}::text = ANY(${p(arr.map(String))}::text[])`);
          // mảng → tham số mảng (không JSON hóa)
          params[params.length - 1] = arr.map(String);
          break;
        }
        case "null":
          parts.push(`${c} IS NULL`);
          break;
        case "notnull":
          parts.push(`${c} IS NOT NULL`);
          break;
        case "sameday":
          parts.push(`(${c})::date = (${p(w.value)})::date`);
          break;
        default:
          throw new DbFormError(`Phép so "${String(o)}" không có — dùng: ${Object.keys(DB_WHERE_OPS).join(", ")}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  };

  const order = (): string => {
    let list: Array<{ col: string; dir?: string }> = [];
    if (typeof form.orderBy === "string") {
      list = form.orderBy
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (x.startsWith("-") ? { col: x.slice(1), dir: "desc" } : { col: x, dir: "asc" }));
    } else if (Array.isArray(form.orderBy)) list = form.orderBy.filter((x) => x && x.col);
    return list.length ? ` ORDER BY ${list.map((o) => `${quoteIdent(o.col)} ${o.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}` : "";
  };

  const limitOffset = (): string => {
    let s = "";
    if (form.limit !== undefined && form.limit !== null && String(form.limit) !== "") {
      const n = Math.floor(Number(form.limit));
      if (!Number.isFinite(n) || n < 0) throw new DbFormError("limit phải là số ≥ 0");
      s += ` LIMIT ${n}`;
    }
    if (form.offset) {
      const n = Math.floor(Number(form.offset));
      if (!Number.isFinite(n) || n < 0) throw new DbFormError("offset phải là số ≥ 0");
      s += ` OFFSET ${n}`;
    }
    return s;
  };

  const values = form.values && typeof form.values === "object" ? form.values : {};
  const cols = Object.keys(values);
  const returning = form.returning === false ? "" : " RETURNING *";

  switch (op) {
    case "find": {
      const sel = form.columns?.length ? form.columns.map(quoteIdent).join(", ") : "*";
      const w = where();
      return { sql: `SELECT ${sel} FROM ${t}${w}${order()}${limitOffset()}`, params, kind: "read", destructive: false };
    }
    case "count": {
      const w = where();
      return { sql: `SELECT count(*)::bigint AS count FROM ${t}${w}`, params, kind: "read", destructive: false };
    }
    case "aggregate": {
      const aggs = (form.agg ?? []).filter((a) => a && a.fn);
      if (!aggs.length) throw new DbFormError("Chọn ít nhất một phép tính (đếm, tổng…)");
      const gb = (form.groupBy ?? []).filter(Boolean);
      const sel = [
        ...gb.map(quoteIdent),
        ...aggs.map((a) => {
          if (!["count", "sum", "avg", "min", "max"].includes(a.fn)) throw new DbFormError(`Phép tính "${a.fn}" không có`);
          const expr = a.fn === "count" && !a.col ? "count(*)" : `${a.fn}(${quoteIdent(a.col)})`;
          const alias = a.as || (a.col ? `${a.fn}_${a.col}` : a.fn);
          return `${expr} AS ${quoteIdent(alias)}`;
        }),
      ];
      const w = where();
      return {
        sql: `SELECT ${sel.join(", ")} FROM ${t}${w}${gb.length ? ` GROUP BY ${gb.map(quoteIdent).join(", ")}` : ""}${order()}${limitOffset()}`,
        params,
        kind: "read",
        destructive: false,
      };
    }
    case "insert":
    case "upsert": {
      if (!cols.length) throw new DbFormError("Chưa có giá trị cột nào để thêm");
      const vals = cols.map((c) => p(isIncr(values[c]) ? values[c].$inc : values[c]));
      let sql = `INSERT INTO ${t} (${cols.map(quoteIdent).join(", ")}) VALUES (${vals.join(", ")})`;
      if (op === "upsert") {
        const match = (form.match ?? []).filter(Boolean);
        if (!match.length) throw new DbFormError("Thêm hoặc cập nhật cần chọn cột khóa (match) — khóa chính hoặc cột duy nhất");
        if (form.onConflict === "ignore") sql += ` ON CONFLICT (${match.map(quoteIdent).join(", ")}) DO NOTHING`;
        else {
          const upd = cols.filter((c) => !match.includes(c));
          if (!upd.length) sql += ` ON CONFLICT (${match.map(quoteIdent).join(", ")}) DO NOTHING`;
          else
            sql += ` ON CONFLICT (${match.map(quoteIdent).join(", ")}) DO UPDATE SET ${upd
              .map((c) => (isIncr(values[c]) ? `${quoteIdent(c)} = COALESCE(${t}.${quoteIdent(c)}, 0) + EXCLUDED.${quoteIdent(c)}` : `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`))
              .join(", ")}`;
        }
      }
      return { sql: sql + returning, params, kind: "write", destructive: false };
    }
    case "update": {
      if (!cols.length) throw new DbFormError("Chưa có cột nào để sửa");
      const sets = cols.map((c) => (isIncr(values[c]) ? `${quoteIdent(c)} = COALESCE(${quoteIdent(c)}, 0) + ${p(values[c].$inc)}` : `${quoteIdent(c)} = ${p(values[c])}`));
      const w = where();
      return { sql: `UPDATE ${t} SET ${sets.join(", ")}${w}${returning}`, params, kind: "write", destructive: !w };
    }
    case "delete": {
      const w = where();
      return { sql: `DELETE FROM ${t}${w}${returning}`, params, kind: "write", destructive: !w };
    }
  }
  throw new DbFormError(`Thao tác "${String(op)}" không có`);
}

// ---------------- tạo bảng ----------------

/** Kiểu cột dễ hiểu → kiểu PostgreSQL. */
export const DB_COLUMN_TYPES: Record<string, { label: string; pg: string }> = {
  text: { label: "Chữ", pg: "text" },
  integer: { label: "Số nguyên", pg: "bigint" },
  number: { label: "Số thập phân", pg: "numeric" },
  money: { label: "Tiền (số)", pg: "numeric(18,2)" },
  date: { label: "Ngày", pg: "date" },
  datetime: { label: "Ngày giờ", pg: "timestamptz" },
  boolean: { label: "Đúng/sai", pg: "boolean" },
  json: { label: "JSON", pg: "jsonb" },
};

export interface DbColumnSpec {
  name: string;
  /** Khóa trong DB_COLUMN_TYPES hoặc kiểu PostgreSQL bất kỳ (vd varchar(20)). */
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  notNull?: boolean;
  /** "now" (lúc tạo), "today", "true", "false", số, hoặc chuỗi. */
  default?: string | number | boolean | null;
  comment?: string;
  /** suggestColumns: tên trường gốc trong dữ liệu mẫu. */
  source?: string;
}

export interface DbTableSpec {
  name: string;
  comment?: string;
  columns: DbColumnSpec[];
  /** Tự thêm cột id tự tăng (khi không cột nào là khóa chính) — mặc định true. */
  autoId?: boolean;
  /** Tự thêm cột tao_luc / sua_luc — mặc định true. */
  timestamps?: boolean;
}

const NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function pgTypeOf(t: string): string {
  const k = String(t ?? "").trim();
  if (DB_COLUMN_TYPES[k]) return DB_COLUMN_TYPES[k]!.pg;
  if (/^[a-z][a-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\[\])?$/i.test(k)) return k.toLowerCase();
  throw new DbFormError(`Kiểu cột "${k}" không hợp lệ — dùng: ${Object.keys(DB_COLUMN_TYPES).join(", ")}`);
}

function defaultExpr(c: DbColumnSpec, pg: string): string | null {
  const d = c.default;
  if (d === undefined || d === null || d === "") return null;
  if (d === "now") return "now()";
  if (d === "today") return "CURRENT_DATE";
  if (typeof d === "boolean" || d === "true" || d === "false") return String(d);
  if (typeof d === "number" || (/^(bigint|integer|numeric|real|double|smallint)/.test(pg) && /^-?\d+(\.\d+)?$/.test(String(d)))) {
    const n = Number(d);
    if (!Number.isFinite(n)) throw new DbFormError(`Giá trị mặc định của ${c.name} không phải số`);
    return String(n);
  }
  return quoteLiteral(String(d));
}

/** Câu lệnh CREATE TABLE (+ COMMENT) từ mô tả bảng. Tên bảng/cột: chữ thường không dấu, số, _. */
export function buildCreateTable(spec: DbTableSpec): string {
  const name = String(spec.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new DbFormError("Tên bảng chỉ gồm chữ thường không dấu, số, dấu _ (vd don_hang), không bắt đầu bằng số");
  const cols = (spec.columns ?? []).filter((c) => c && String(c.name ?? "").trim());
  const seen = new Set<string>();
  for (const c of cols) {
    c.name = String(c.name).trim();
    if (!NAME_RE.test(c.name)) throw new DbFormError(`Tên cột "${c.name}" chỉ gồm chữ thường không dấu, số, dấu _`);
    if (seen.has(c.name)) throw new DbFormError(`Cột "${c.name}" bị trùng`);
    seen.add(c.name);
  }
  const hasPk = cols.some((c) => c.primaryKey);
  const parts: string[] = [];
  if (!hasPk && spec.autoId !== false && !seen.has("id")) parts.push(`"id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`);
  for (const c of cols) {
    const pg = pgTypeOf(c.type || "text");
    let def = `${quoteIdent(c.name)} ${pg}`;
    const dv = defaultExpr(c, pg);
    if (dv) def += ` DEFAULT ${dv}`;
    if (c.notNull && !c.primaryKey) def += " NOT NULL";
    if (c.unique && !c.primaryKey) def += " UNIQUE";
    parts.push(def);
  }
  const pkCols = cols.filter((c) => c.primaryKey).map((c) => quoteIdent(c.name));
  if (pkCols.length) parts.push(`PRIMARY KEY (${pkCols.join(", ")})`);
  if (spec.timestamps !== false) {
    if (!seen.has("tao_luc")) parts.push(`"tao_luc" timestamptz NOT NULL DEFAULT now()`);
    if (!seen.has("sua_luc")) parts.push(`"sua_luc" timestamptz NOT NULL DEFAULT now()`);
  }
  if (!parts.length) throw new DbFormError("Bảng cần ít nhất một cột");
  const out = [`CREATE TABLE ${quoteIdent(name)} (\n  ${parts.join(",\n  ")}\n);`];
  if (spec.comment) out.push(`COMMENT ON TABLE ${quoteIdent(name)} IS ${quoteLiteral(spec.comment)};`);
  for (const c of cols) if (c.comment) out.push(`COMMENT ON COLUMN ${quoteIdent(name)}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`);
  return out.join("\n");
}

/** Thêm một cột vào bảng có sẵn. */
export function buildAddColumn(table: string, c: DbColumnSpec): string {
  const pg = pgTypeOf(c.type || "text");
  if (!NAME_RE.test(String(c.name ?? ""))) throw new DbFormError("Tên cột chỉ gồm chữ thường không dấu, số, dấu _");
  let def = `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(c.name)} ${pg}`;
  const dv = defaultExpr(c, pg);
  if (dv) def += ` DEFAULT ${dv}`;
  if (c.notNull) def += " NOT NULL";
  if (c.unique) def += " UNIQUE";
  const out = [def + ";"];
  if (c.comment) out.push(`COMMENT ON COLUMN ${quoteIdent(table)}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`);
  return out.join("\n");
}

/** Gợi ý cột từ một dòng dữ liệu mẫu (kết quả bước trước). */
export function suggestColumns(sample: unknown): DbColumnSpec[] {
  const row = Array.isArray(sample) ? sample[0] : sample;
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  const out: DbColumnSpec[] = [];
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    const name = k
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "c_$1")
      .slice(0, 63);
    if (!name) continue;
    let type = "text";
    if (typeof v === "boolean") type = "boolean";
    else if (typeof v === "number") type = Number.isInteger(v) ? "integer" : "number";
    else if (v && typeof v === "object") type = "json";
    else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) type = "datetime";
    else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) type = "date";
    out.push({ name, type, source: k });
  }
  return out;
}
