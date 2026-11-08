import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  checkWsdbSql,
  createDb,
  releaseRunLocks,
  releaseWorkflowLock,
  SecretNotWritableError,
  tryAcquireWorkflowLock,
  upsertWorkspaceSecret,
  workflowWriteSecret,
  wsdbAuditList,
  wsdbQuery,
  wsdbRestoreTable,
  wsdbSchema,
  wsdbSchemaName,
  wsdbTakeSnapshot,
  type DbHandle,
  type WsdbActor,
} from "../src/index.js";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

// CSDL riêng của workspace (0037): cách ly giữa workspace, bộ kiểm SQL, quyền, chạy thử,
// nhật ký, bản chụp + khôi phục; khóa bí mật quy trình tự ghi + khóa chờ lượt.

let fx: TestFixtures;
let dbh: DbHandle;
const actor: WsdbActor = { via: "api" };
const ctx = (workspaceId: string): WorkspaceContext => ({ workspaceId, userId: fx.userId, role: "operator" });
const q = (ws: string, sql: string, extra: Partial<Parameters<typeof wsdbQuery>[2]> = {}) =>
  wsdbQuery(dbh.db, ctx(ws), { sql, allow: "ddl", actor, ...extra });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});

afterAll(async () => {
  await dbh.close();
});

describe("CSDL của workspace — chạy SQL", () => {
  it("tạo bảng, ghi, đọc (tham số $1) trong schema riêng", async () => {
    await q(fx.wsA, "CREATE TABLE don_hang (ma text PRIMARY KEY, khach text, tong numeric NOT NULL DEFAULT 0); COMMENT ON TABLE don_hang IS 'Đơn hàng'");
    const ins = await q(fx.wsA, "INSERT INTO don_hang (ma, khach, tong) VALUES ($1, $2, $3) RETURNING *", { params: ["A1", "Lan", 120000] });
    expect(ins.row).toMatchObject({ ma: "A1", khach: "Lan" });
    await q(fx.wsA, "INSERT INTO don_hang VALUES ('A2', 'Minh', 50000), ('A3', 'An', 70000)");
    const r = await q(fx.wsA, "SELECT count(*)::int AS n, sum(tong)::int AS s FROM don_hang");
    expect(r.row).toEqual({ n: 3, s: 240000 });
    expect(r.kind).toBe("read");
    const info = await wsdbSchema(dbh.db, ctx(fx.wsA));
    const t = info.tables.find((x) => x.name === "don_hang")!;
    expect(t.comment).toBe("Đơn hàng");
    expect(t.primaryKey).toEqual(["ma"]);
    expect(info.schema).toBe(wsdbSchemaName(fx.wsA));
  });

  it("workspace B không thấy bảng của A (kể cả ghi rõ tên schema)", async () => {
    await expect(q(fx.wsB, "SELECT * FROM don_hang")).rejects.toThrow(/không tồn tại|does not exist/);
    await expect(q(fx.wsB, `SELECT * FROM ${wsdbSchemaName(fx.wsA)}.don_hang`)).rejects.toThrow(/schema/);
    const info = await wsdbSchema(dbh.db, ctx(fx.wsB));
    expect(info.tables).toEqual([]);
  });

  it("bộ kiểm chặn thoát quyền + bảng PenAI + hàm nguy hiểm", async () => {
    const bad = [
      "RESET ROLE",
      "SET ROLE penai_app",
      "SELECT set_config('role', 'penai_app', true)",
      "SELECT current_setting('app.workspace_id')",
      "SELECT * FROM public.users",
      "SELECT * FROM pg_class",
      "SELECT query_to_xml('select * from public.users', true, true, '')",
      "DO $$ BEGIN PERFORM 1; END $$",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
      "COPY don_hang TO '/tmp/x.csv'",
      "BEGIN",
      "CREATE TEMP TABLE x (a int)",
      "SELECT 'public.users'::regclass",
      "GRANT SELECT ON don_hang TO PUBLIC",
    ];
    for (const s of bad) await expect(q(fx.wsA, s), s).rejects.toThrow();
  });

  it("lớp CSDL: role của workspace không đọc được bảng PenAI / schema workspace khác dù vượt bộ kiểm", async () => {
    await q(fx.wsB, "SELECT 1"); // tạo schema + role cho B
    const pool = (dbh.db as unknown as { $client: import("pg").Pool }).$client;
    const c = await pool.connect();
    try {
      for (const sql of ["SELECT * FROM public.users", `SELECT * FROM ${wsdbSchemaName(fx.wsA)}.don_hang`, "SELECT * FROM public.agents"]) {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${wsdbSchemaName(fx.wsB)}`);
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
        await c.query("ROLLBACK");
      }
    } finally {
      c.release();
    }
  });

  it("quyền: chỉ đọc thì không ghi; lệnh phá dữ liệu cần confirm", async () => {
    await expect(q(fx.wsA, "INSERT INTO don_hang VALUES ('X', 'x', 1)", { allow: "read" })).rejects.toMatchObject({ status: 403 });
    await expect(q(fx.wsA, "CREATE TABLE t2 (a int)", { allow: "write" })).rejects.toMatchObject({ status: 403 });
    await expect(q(fx.wsA, "DELETE FROM don_hang")).rejects.toMatchObject({ status: 409 });
    await expect(q(fx.wsA, "DROP TABLE don_hang")).rejects.toMatchObject({ status: 409 });
    const ok = await q(fx.wsA, "DELETE FROM don_hang WHERE ma = 'A3'");
    expect(ok.count).toBe(1);
  });

  it("chạy thử (dryRun): ghi thật trong giao dịch rồi hoàn tác", async () => {
    const r = await q(fx.wsA, "DELETE FROM don_hang WHERE tong > 0", { dryRun: true });
    expect(r.count).toBe(2);
    expect(r.dryRun).toBe(true);
    const n = await q(fx.wsA, "SELECT count(*)::int AS n FROM don_hang");
    expect(n.row).toEqual({ n: 2 });
  });

  it("nhiều lệnh = một giao dịch: lỗi lệnh sau thì hủy cả gói", async () => {
    await expect(q(fx.wsA, "INSERT INTO don_hang VALUES ('B1', 'x', 1); INSERT INTO don_hang VALUES ('A1', 'trùng khóa', 1)")).rejects.toThrow(/duplicate|trùng/);
    const n = await q(fx.wsA, "SELECT count(*)::int AS n FROM don_hang WHERE ma = 'B1'");
    expect(n.row).toEqual({ n: 0 });
  });

  it("cắt bớt kết quả theo maxRows", async () => {
    const r = await q(fx.wsA, "SELECT g FROM generate_series(1, 50) g", { limits: { maxRows: 10 } });
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("ghi nhật ký lệnh ghi / đổi cấu trúc", async () => {
    const a = await wsdbAuditList(dbh.db, ctx(fx.wsA));
    expect(a.some((x) => x.kind === "ddl" && /CREATE TABLE don_hang/.test(x.statement))).toBe(true);
    expect(a.some((x) => x.kind === "write" && x.rowCount === 1)).toBe(true);
    const b = await wsdbAuditList(dbh.db, ctx(fx.wsB));
    expect(b.every((x) => x.workspaceId === fx.wsB)).toBe(true);
  });

  it("bản chụp + khôi phục bảng đã xóa", async () => {
    await q(fx.wsA, "CREATE TABLE nhat_ky (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, noi_dung text)");
    await q(fx.wsA, "INSERT INTO nhat_ky (noi_dung) VALUES ('một'), ('hai')");
    const snap = await wsdbTakeSnapshot(dbh.db, ctx(fx.wsA), { manual: true });
    expect("id" in snap).toBe(true);
    await q(fx.wsA, "DROP TABLE nhat_ky", { confirm: true });
    const res = await wsdbRestoreTable(dbh.db, ctx(fx.wsA), (snap as { id: string }).id, "nhat_ky", actor);
    expect(res).toEqual({ rows: 2, recreated: true });
    // Bộ đếm tự tăng chạy tiếp sau giá trị lớn nhất
    const ins = await q(fx.wsA, "INSERT INTO nhat_ky (noi_dung) VALUES ('ba') RETURNING id");
    expect(Number(ins.row?.id)).toBe(3);
    // Workspace B không khôi phục được bản chụp của A
    await expect(wsdbRestoreTable(dbh.db, ctx(fx.wsB), (snap as { id: string }).id, "nhat_ky", actor)).rejects.toThrow(/Không có bản chụp/);
  });

  it("bộ kiểm phân loại read/write/ddl + phá dữ liệu", async () => {
    const s = wsdbSchemaName(fx.wsA);
    expect((await checkWsdbSql("SELECT * FROM a JOIN b ON a.id = b.id", s)).kind).toBe("read");
    expect((await checkWsdbSql("UPDATE a SET x = 1 WHERE id = 2", s)).destructive).toBe(false);
    expect((await checkWsdbSql("UPDATE a SET x = 1", s)).destructive).toBe(true);
    expect((await checkWsdbSql("ALTER TABLE a DROP COLUMN x", s)).destructive).toBe(true);
    expect((await checkWsdbSql("WITH d AS (DELETE FROM a WHERE id = 1 RETURNING *) SELECT * FROM d", s)).kind).toBe("write");
  });
});

describe("Khóa bí mật — quy trình tự ghi + khóa chờ lượt", () => {
  it("khóa nhập tay không cho quy trình ghi; khóa quy trình tạo thì ghi được", async () => {
    await upsertWorkspaceSecret(dbh.db, ctx(fx.wsA), { name: "MANUAL_KEY", valueEncrypted: "enc1" });
    await expect(workflowWriteSecret(dbh.db, ctx(fx.wsA), { name: "MANUAL_KEY", valueEncrypted: "enc2", expiresAt: null, workflowId: randomUUID() })).rejects.toBeInstanceOf(SecretNotWritableError);
    const wf = randomUUID();
    const a = await workflowWriteSecret(dbh.db, ctx(fx.wsA), { name: "SHOP_TOKEN", valueEncrypted: "e1", expiresAt: new Date(Date.now() + 3600_000), workflowId: wf });
    expect(a.workflowWritable).toBe(true);
    const b = await workflowWriteSecret(dbh.db, ctx(fx.wsA), { name: "SHOP_TOKEN", valueEncrypted: "e2", expiresAt: null, workflowId: wf });
    expect(b.version).toBe(2);
    expect(b.updatedVia).toBe("workflow");
    await upsertWorkspaceSecret(dbh.db, ctx(fx.wsA), { name: "MANUAL_KEY", workflowWritable: true });
    const c = await workflowWriteSecret(dbh.db, ctx(fx.wsA), { name: "MANUAL_KEY", valueEncrypted: "enc3", expiresAt: null, workflowId: wf });
    expect(c.version).toBe(2);
  });

  it("một lần chạy giữ khóa — lần chạy khác phải chờ; nhả khi xong", async () => {
    const r1 = randomUUID();
    const r2 = randomUUID();
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsA), "SHOP_TOKEN", r1, 60_000)).toBe(true);
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsA), "SHOP_TOKEN", r2, 60_000)).toBe(false);
    // workspace khác cùng tên khóa không bị ảnh hưởng
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsB), "SHOP_TOKEN", r2, 60_000)).toBe(true);
    expect(await releaseWorkflowLock(dbh.db, ctx(fx.wsA), "SHOP_TOKEN", r2)).toBe(false);
    await releaseRunLocks(dbh.db, r1);
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsA), "SHOP_TOKEN", r2, 60_000)).toBe(true);
    // khóa quá hạn coi như đã nhả
    const r3 = randomUUID();
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsA), "OLD", r3, 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await tryAcquireWorkflowLock(dbh.db, ctx(fx.wsA), "OLD", randomUUID(), 60_000)).toBe(true);
  });
});
