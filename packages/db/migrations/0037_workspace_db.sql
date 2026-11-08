-- 0037: Cơ sở dữ liệu riêng của workspace (bảng PostgreSQL thật cho quy trình,
-- agent, API, MCP) + khóa bí mật mà quy trình tự ghi được (token, refresh token).
-- Xem docs/co-so-du-lieu.md.
--
-- Chỉ THÊM (bảng mới, cột có mặc định). Bản cũ đang chạy không bị ảnh hưởng.
--
-- Cách ly dữ liệu của workspace:
--   • Mỗi workspace một schema + một role riêng, cùng tên `wsdb_<uuid không gạch>`
--     (role NOLOGIN, chỉ sở hữu schema của mình). App (penai_app) chạy câu lệnh
--     của người dùng trong giao dịch có `SET LOCAL ROLE wsdb_…`.
--   • Role của workspace KHÔNG có quyền gì trên schema public (bảng của PenAI) —
--     dòng REVOKE dưới đây gỡ quyền mặc định USAGE của PUBLIC, cấp lại cho penai_app.
--   • Bộ kiểm câu lệnh (packages/db/src/wsdb-guard.ts) chặn SET/RESET ROLE,
--     set_config, hàm chạy SQL động, bảng hệ thống pg_*…

-- ---------------- khóa bí mật: quy trình tự ghi ----------------
ALTER TABLE workspace_secrets
  ADD COLUMN IF NOT EXISTS workflow_writable boolean NOT NULL DEFAULT false,   -- quy trình được ghi đè / xóa
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,                             -- hạn dùng (token), chỉ để hiển thị + kiểm tra
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,                 -- tăng mỗi lần đổi giá trị
  ADD COLUMN IF NOT EXISTS updated_via text NOT NULL DEFAULT 'dashboard',      -- dashboard | api | workflow
  ADD COLUMN IF NOT EXISTS updated_by_workflow uuid;                           -- quy trình ghi gần nhất

-- Khóa (mutex) giữa các lần chạy quy trình — vd chỉ một lần chạy được làm mới token
-- tại một thời điểm. Lần chạy kết thúc thì tự nhả; quá expires_at coi như đã nhả.
CREATE TABLE workflow_locks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  run_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, name)
);
CREATE INDEX workflow_locks_run_idx ON workflow_locks(run_id);

-- ---------------- CSDL của workspace ----------------
-- Nhật ký mọi lệnh ghi / đổi cấu trúc (ai, từ đâu, câu lệnh, số dòng).
CREATE TABLE wsdb_audit (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,                 -- write | ddl | restore | import
  via text NOT NULL,                  -- dashboard | api | agent | mcp | workflow
  actor_user_id uuid,
  actor_agent_id uuid,
  workflow_id uuid,
  statement text NOT NULL,
  row_count integer,
  destructive boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wsdb_audit_ws_idx ON wsdb_audit(workspace_id, created_at DESC);

-- Bản chụp dữ liệu hằng ngày (gzip JSON: cấu trúc + dữ liệu từng bảng) để khôi phục bảng.
CREATE TABLE wsdb_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  taken_at timestamptz NOT NULL DEFAULT now(),
  manual boolean NOT NULL DEFAULT false,
  tables jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ name, rows }]
  data bytea NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0
);
CREATE INDEX wsdb_snapshots_ws_idx ON wsdb_snapshots(workspace_id, taken_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_locks', 'wsdb_audit', 'wsdb_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) ' ||
      'WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE wsdb_audit_id_seq TO penai_app;

-- Role của workspace không được nhìn vào schema public (bảng, hàm của PenAI).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO penai_app;

-- Tạo (hoặc sửa lại sau khi khôi phục sao lưu sang cụm khác) schema + role của một workspace.
-- Trả tên schema (= tên role).
CREATE OR REPLACE FUNCTION wsdb_ensure(p_ws uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r text := 'wsdb_' || replace(p_ws::text, '-', '');
  created boolean := false;
  obj record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_ws) THEN
    RAISE EXCEPTION 'Workspace % không tồn tại', p_ws;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
    created := true;
  END IF;
  IF NOT pg_has_role('penai_app', r, 'MEMBER') THEN
    EXECUTE format('GRANT %I TO penai_app', r);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = r) THEN
    EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', r, r);
  ELSIF created OR (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = r) <> quote_ident(r) THEN
    -- Khôi phục từ bản sao lưu sang cụm mới (role chưa có) → trả quyền sở hữu cho role mới.
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r, r);
    FOR obj IN
      SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = r AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
    LOOP
      EXECUTE format('ALTER %s %I.%I OWNER TO %I',
        CASE obj.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
        r, obj.relname, r);
    END LOOP;
  END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', r);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION wsdb_ensure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wsdb_ensure(uuid) TO penai_app;

-- Các workspace đã có CSDL (cho bản chụp hằng ngày).
CREATE OR REPLACE FUNCTION wsdb_list_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT w.id FROM public.workspaces w
  WHERE EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'wsdb_' || replace(w.id::text, '-', ''))
$$;
REVOKE ALL ON FUNCTION wsdb_list_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wsdb_list_workspaces() TO penai_app;

-- Nhả mọi khóa của lần chạy (kết thúc) + dọn khóa quá hạn.
CREATE OR REPLACE FUNCTION release_workflow_locks(p_run uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.workflow_locks WHERE run_id = p_run OR expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION release_workflow_locks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_workflow_locks(uuid) TO penai_app;
