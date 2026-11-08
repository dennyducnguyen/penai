/**
 * API CSDL của workspace (/v1/db/*) — trang 🗃️ Dữ liệu, ứng dụng ngoài (khóa API psk_),
 * Claude Code… Quyền: viewer chỉ đọc; operator trở lên đọc, ghi, tạo/sửa/xóa bảng.
 * Lệnh phá dữ liệu (DROP, TRUNCATE, DELETE/UPDATE không WHERE, xóa cột) cần confirm=true.
 * Xem docs/co-so-du-lieu.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasRole } from "@penai/shared";
import {
  wsdbAuditList,
  wsdbInsertRows,
  wsdbListSnapshots,
  wsdbRestoreTable,
  wsdbTakeSnapshot,
  WsdbError,
  type WsdbActor,
} from "@penai/db";
import { buildAddColumn, buildCreateTable, buildDbQuery, DbFormError, quoteIdent, suggestColumns, type DbForm } from "@penai/core";
import { allowForRole, type WsdbService } from "./wsdb-service.js";

const QueryBody = z.object({
  sql: z.string().min(1).max(200_000),
  params: z.array(z.unknown()).max(1000).optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

const ColumnSpec = z.object({
  name: z.string().min(1).max(63),
  type: z.string().min(1).max(60),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  notNull: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  comment: z.string().max(500).optional(),
});

const TableBody = z.object({
  name: z.string().min(1).max(63),
  comment: z.string().max(1000).optional(),
  columns: z.array(ColumnSpec).max(200),
  autoId: z.boolean().optional(),
  timestamps: z.boolean().optional(),
  preview: z.boolean().optional(),
});

/** CSV → mảng dòng (RFC 4180: dấu ngoặc kép, xuống dòng trong ô, "" = "). Tự nhận dấu phân cách , ; tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1]);
  const sep = counts[0]![1] > 1 ? counts[0]![0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

function toCsv(fields: string[], rows: Array<Record<string, unknown>>): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [fields.map(esc).join(","), ...rows.map((r) => fields.map((f) => esc(r[f])).join(","))].join("\r\n");
}

export function registerWsdbRoutes(app: FastifyInstance, deps: { svc: WsdbService }): void {
  const { svc } = deps;

  const caller = (req: FastifyRequest, reply: FastifyReply, min: "read" | "write") => {
    const allow = allowForRole(req.authCtx.role);
    if (!allow || (min === "write" && allow === "read")) {
      void reply.code(403).send({ error: min === "write" ? "Cần quyền operator trở lên để ghi / sửa cấu trúc" : "Không có quyền xem CSDL" });
      return null;
    }
    const actor: WsdbActor = { via: req.authInfo?.kind === "apikey" ? "api" : "dashboard", userId: req.authCtx.userId };
    return { ctx: req.authCtx, allow, actor };
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof WsdbError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof DbFormError) return reply.code(400).send({ error: err.message });
    const st = (err as { status?: number }).status;
    if (st) return reply.code(st).send({ error: (err as Error).message });
    throw err;
  };
  const tableOf = (req: FastifyRequest) => decodeURIComponent((req.params as { table: string }).table);

  // ---------------- cấu trúc ----------------
  app.get("/v1/db/schema", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    try {
      const info = await svc.schema(c.ctx);
      const q = req.query as { format?: string };
      if (q.format === "text") return { text: await svc.schemaText(c.ctx) };
      return { ...info, usage: await svc.usage(c.ctx).catch(() => ({})), canWrite: c.allow !== "read", enabled: svc.cfg.enabled };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------------- chạy SQL ----------------
  app.post("/v1/db/query", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    const p = QueryBody.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    try {
      return await svc.query(c, p.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Dựng SQL từ form (nút "Xem SQL" của bước db). */
  app.post("/v1/db/build", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    try {
      const b = buildDbQuery((req.body ?? {}) as DbForm);
      return b;
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Gợi ý cột từ dữ liệu mẫu (tạo bảng từ kết quả bước trước). */
  app.post("/v1/db/suggest-columns", async (req) => {
    return { columns: suggestColumns((req.body as { sample?: unknown } | undefined)?.sample) };
  });

  // ---------------- dòng ----------------
  app.get("/v1/db/tables/:table/rows", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    const q = req.query as { limit?: string; offset?: string; order?: string; q?: string; col?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const table = tableOf(req);
    try {
      const where = q.q && q.col ? [{ col: q.col, op: "contains" as const, value: q.q }] : [];
      const info = (await svc.schema(c.ctx)).tables.find((t) => t.name === table);
      if (!info) return reply.code(404).send({ error: `Không có bảng "${table}"` });
      const built = buildDbQuery({ op: "find", table, where, ...(q.order ? { orderBy: q.order } : {}), limit, offset });
      // Bảng không có khóa chính: kèm ctid (vị trí dòng) để sửa/xóa đúng dòng trên Dashboard
      const sqlText = info.kind === "table" && !info.primaryKey.length ? built.sql.replace(/^SELECT \* FROM /, 'SELECT ctid::text AS "_ctid", * FROM ') : built.sql;
      const rows = await svc.query({ ...c, allow: "read" }, { sql: sqlText, params: built.params });
      const cnt = await svc.queryForm({ ...c, allow: "read" }, { op: "count", table, where });
      return { rows: rows.rows, fields: rows.fields, total: Number(cnt.row?.count ?? 0), limit, offset };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/db/tables/:table/rows", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const b = (req.body ?? {}) as { values?: Record<string, unknown> };
    try {
      const r = await svc.queryForm(c, { op: "insert", table: tableOf(req), values: b.values ?? {} });
      return { row: r.row };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Sửa/xóa một dòng theo khóa: { key: { cột_khóa: giá trị } } hoặc { ctid } khi bảng không có khóa chính. */
  const keyWhere = (b: { key?: Record<string, unknown>; ctid?: string }) => {
    if (b.key && Object.keys(b.key).length) return Object.entries(b.key).map(([col, value]) => ({ col, op: "eq" as const, value }));
    throw new WsdbError("Thiếu key (giá trị khóa chính của dòng)");
  };
  app.patch("/v1/db/tables/:table/rows", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const b = (req.body ?? {}) as { key?: Record<string, unknown>; ctid?: string; values?: Record<string, unknown> };
    try {
      if (b.ctid) {
        const cols = Object.keys(b.values ?? {});
        if (!cols.length) throw new WsdbError("Chưa có giá trị để sửa");
        const params = cols.map((k) => {
          const v = (b.values ?? {})[k];
          return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        });
        const r = await svc.query(c, {
          sql: `UPDATE ${quoteIdent(tableOf(req))} SET ${cols.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(", ")} WHERE ctid = $${cols.length + 1}::tid RETURNING *`,
          params: [...params, b.ctid],
        });
        return { row: r.row };
      }
      const r = await svc.queryForm(c, { op: "update", table: tableOf(req), values: b.values ?? {}, where: keyWhere(b) });
      if (!r.count) return reply.code(404).send({ error: "Không tìm thấy dòng (có thể đã bị sửa/xóa)" });
      return { row: r.row };
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.delete("/v1/db/tables/:table/rows", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const b = (req.body ?? {}) as { key?: Record<string, unknown>; ctid?: string };
    try {
      if (b.ctid) {
        const r = await svc.query(c, { sql: `DELETE FROM ${quoteIdent(tableOf(req))} WHERE ctid = $1::tid`, params: [b.ctid] });
        return { deleted: r.count };
      }
      const r = await svc.queryForm(c, { op: "delete", table: tableOf(req), where: keyWhere(b), returning: false });
      return { deleted: r.count };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------------- bảng + cột ----------------
  app.post("/v1/db/tables", async (req, reply) => {
    const p = TableBody.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    try {
      const sqlText = buildCreateTable(p.data);
      if (p.data.preview) return { sql: sqlText };
      const c = caller(req, reply, "write");
      if (!c) return;
      await svc.query(c, { sql: sqlText });
      return { ok: true, sql: sqlText };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/db/tables/:table/columns", async (req, reply) => {
    const p = ColumnSpec.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const c = caller(req, reply, "write");
    if (!c) return;
    try {
      const sqlText = buildAddColumn(tableOf(req), p.data);
      await svc.query(c, { sql: sqlText });
      return { ok: true, sql: sqlText };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/v1/db/tables/:table/columns/:column", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const column = decodeURIComponent((req.params as { column: string }).column);
    const b = (req.body ?? {}) as { name?: string; comment?: string };
    const t = quoteIdent(tableOf(req));
    const stmts: string[] = [];
    try {
      if (b.comment !== undefined) stmts.push(`COMMENT ON COLUMN ${t}.${quoteIdent(column)} IS '${String(b.comment).replace(/'/g, "''")}'`);
      if (b.name && b.name !== column) {
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(b.name)) throw new WsdbError("Tên cột chỉ gồm chữ thường không dấu, số, dấu _");
        stmts.push(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(column)} TO ${quoteIdent(b.name)}`);
      }
      if (!stmts.length) return { ok: true };
      await svc.query(c, { sql: stmts.join(";\n") });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/v1/db/tables/:table/columns/:column", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const column = decodeURIComponent((req.params as { column: string }).column);
    try {
      await svc.query(c, { sql: `ALTER TABLE ${quoteIdent(tableOf(req))} DROP COLUMN ${quoteIdent(column)}`, confirm: (req.query as { confirm?: string }).confirm === "1" });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/v1/db/tables/:table", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const b = (req.body ?? {}) as { name?: string; comment?: string };
    const t = quoteIdent(tableOf(req));
    const stmts: string[] = [];
    try {
      if (b.comment !== undefined) stmts.push(`COMMENT ON TABLE ${t} IS '${String(b.comment).replace(/'/g, "''")}'`);
      if (b.name && b.name !== tableOf(req)) {
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(b.name)) throw new WsdbError("Tên bảng chỉ gồm chữ thường không dấu, số, dấu _");
        stmts.push(`ALTER TABLE ${t} RENAME TO ${quoteIdent(b.name)}`);
      }
      if (!stmts.length) return { ok: true };
      await svc.query(c, { sql: stmts.join(";\n") });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/v1/db/tables/:table", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    try {
      await svc.query(c, { sql: `DROP TABLE ${quoteIdent(tableOf(req))}`, confirm: (req.query as { confirm?: string }).confirm === "1" });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------------- CSV ----------------
  app.get("/v1/db/tables/:table/export.csv", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    const table = tableOf(req);
    try {
      const r = await svc.query({ ...c, allow: "read" }, { sql: `SELECT * FROM ${quoteIdent(table)}` }).catch(async (e) => {
        throw e;
      });
      const csv = toCsv(r.fields, r.rows);
      void reply.header("content-type", "text/csv; charset=utf-8");
      void reply.header("content-disposition", `attachment; filename="${encodeURIComponent(table)}.csv"`);
      return reply.send(csv);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/db/tables/:table/import", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    const b = (req.body ?? {}) as { csv?: string; replace?: boolean; confirm?: boolean };
    if (!b.csv) return reply.code(400).send({ error: "Thiếu nội dung CSV" });
    const rows = parseCsv(b.csv);
    if (rows.length < 2) return reply.code(400).send({ error: "CSV cần dòng tiêu đề (tên cột) và ít nhất một dòng dữ liệu" });
    if (rows.length > 100_001) return reply.code(400).send({ error: "Tối đa 100.000 dòng mỗi lần nhập" });
    if (b.replace && !b.confirm) return reply.code(409).send({ error: "Thay toàn bộ dữ liệu cũ — cần xác nhận (confirm)" });
    const header = rows[0]!.map((h) => h.trim());
    try {
      const r = await wsdbInsertRows(svc.rawDb, c.ctx, {
        table: tableOf(req),
        columns: header,
        rows: rows.slice(1),
        replace: b.replace === true,
        actor: c.actor,
        limits: svc.limits(),
      });
      return r;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------------- nhật ký + bản chụp ----------------
  app.get("/v1/db/audit", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    const limit = Number((req.query as { limit?: string }).limit ?? 100) || 100;
    return { entries: await wsdbAuditList(svc.rawDb, c.ctx, limit) };
  });

  app.get("/v1/db/snapshots", async (req, reply) => {
    const c = caller(req, reply, "read");
    if (!c) return;
    return { snapshots: await wsdbListSnapshots(svc.rawDb, c.ctx), keep: svc.cfg.snapshotKeep, maxMb: svc.cfg.snapshotMaxMb };
  });

  app.post("/v1/db/snapshots", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    try {
      return await wsdbTakeSnapshot(svc.rawDb, c.ctx, { manual: true, keep: svc.cfg.snapshotKeep, maxBytes: svc.cfg.snapshotMaxMb * 1024 * 1024 });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/db/snapshots/:id/restore", async (req, reply) => {
    const c = caller(req, reply, "write");
    if (!c) return;
    if (!hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền operator" });
    const b = (req.body ?? {}) as { table?: string; confirm?: boolean };
    if (!b.table) return reply.code(400).send({ error: "Thiếu tên bảng cần khôi phục" });
    if (!b.confirm) return reply.code(409).send({ error: "Khôi phục sẽ THAY toàn bộ dữ liệu hiện tại của bảng bằng dữ liệu trong bản chụp — cần xác nhận (confirm)" });
    try {
      return await wsdbRestoreTable(svc.rawDb, c.ctx, (req.params as { id: string }).id, b.table, c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
