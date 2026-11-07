-- 0036: Quy trình tự động (workflow) — chạy việc không cần AI (gọi API, chạy mã,
-- rẽ nhánh, lặp, gửi tin, gọi tool/MCP) theo lịch, webhook hoặc bấm tay; AI chỉ
-- là một bước tùy chọn (bước "agent"). Xem docs/quy-trinh.md.
--
-- Chỉ THÊM bảng mới (bản cũ đang chạy trong lúc migration không bị ảnh hưởng).

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,  -- lần chạy mang quyền người này
  definition jsonb NOT NULL,                                     -- bản đang dùng
  version integer NOT NULL DEFAULT 1,
  webhook_token_encrypted text,                                  -- token trong link webhook (mã hóa)
  webhook_secret_encrypted text,                                 -- khóa ký HMAC (auth = "hmac")
  next_run_at timestamptz,                                       -- lần chạy theo lịch kế tiếp (NULL = không có lịch)
  last_run_at timestamptz,
  last_run_status text,
  created_via text NOT NULL DEFAULT 'dashboard',                 -- dashboard | api | agent | mcp | import | template
  last_change_via text,                                          -- nguồn của lần sửa gần nhất (dải "🤖 Agent vừa sửa")
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX workflows_next_run_idx ON workflows(next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  changed_by_user_id uuid,
  changed_by_agent_id uuid,
  change_via text NOT NULL DEFAULT 'dashboard',
  change_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  trigger_type text NOT NULL,                                    -- schedule | webhook | manual | agent | api | mcp | subworkflow | test
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running',                        -- running | success | failed | stopped | timeout | cancelled
  is_test boolean NOT NULL DEFAULT false,
  dry_run boolean NOT NULL DEFAULT false,
  parent_run_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  error text,
  output jsonb,
  response jsonb,
  step_count integer NOT NULL DEFAULT 0
);
CREATE INDEX workflow_runs_wf_idx ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX workflow_runs_running_idx ON workflow_runs(status) WHERE status = 'running';

CREATE TABLE workflow_run_steps (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  step_id text NOT NULL,
  type text NOT NULL,
  path text NOT NULL,
  iteration integer,
  status text NOT NULL,
  input jsonb,
  output jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0
);
CREATE INDEX workflow_run_steps_run_idx ON workflow_run_steps(run_id, seq);

-- Khóa bí mật của workspace (API key của hệ thống ngoài…) — dùng trong quy trình
-- qua {{ secrets.TEN }}; mã hóa AES-256-GCM bằng PENAI_MASTER_KEY, API không bao giờ trả giá trị.
CREATE TABLE workspace_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  value_encrypted text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- Chống gửi lại (replay) webhook ký HMAC
CREATE TABLE workflow_webhook_nonces (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, nonce)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows', 'workflow_versions', 'workflow_runs', 'workflow_run_steps', 'workspace_secrets', 'workflow_webhook_nonces']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) ' ||
      'WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE workflow_run_steps_id_seq TO penai_app;

-- Lấy các quy trình tới lịch (mọi workspace). Đẩy next_run_at lên 1 phút ngay lúc
-- lấy để lượt kiểm tra kế tiếp không lấy trùng; bộ chạy tính lại lịch thật ngay sau đó.
CREATE OR REPLACE FUNCTION claim_due_workflows(p_now timestamptz, p_limit int)
RETURNS TABLE (id uuid, workspace_id uuid, due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT w.id, w.next_run_at FROM workflows w
    WHERE w.enabled = true AND w.next_run_at IS NOT NULL AND w.next_run_at <= p_now
    ORDER BY w.next_run_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE workflows w SET next_run_at = p_now + interval '1 minute'
  FROM due WHERE w.id = due.id
  RETURNING w.id, w.workspace_id, due.next_run_at;
END $$;
REVOKE ALL ON FUNCTION claim_due_workflows(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_workflows(timestamptz, int) TO penai_app;

-- Quy trình có lịch nhưng chưa tính lần chạy kế (vd máy chủ tắt giữa chừng) — sửa lúc khởi động.
CREATE OR REPLACE FUNCTION list_workflows_needing_schedule()
RETURNS TABLE (id uuid, workspace_id uuid)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT w.id, w.workspace_id FROM workflows w
  WHERE w.enabled = true AND w.next_run_at IS NULL
    AND w.definition->'triggers' @> '[{"type":"schedule"}]'::jsonb
$$;
REVOKE ALL ON FUNCTION list_workflows_needing_schedule() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_workflows_needing_schedule() TO penai_app;

-- Webhook công khai: tìm quy trình theo id (chưa biết workspace) để kiểm token.
CREATE OR REPLACE FUNCTION lookup_workflow_webhook(p_id uuid)
RETURNS TABLE (id uuid, workspace_id uuid, enabled boolean, webhook_token_encrypted text, webhook_secret_encrypted text, definition jsonb)
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT w.id, w.workspace_id, w.enabled, w.webhook_token_encrypted, w.webhook_secret_encrypted, w.definition
  FROM workflows w WHERE w.id = p_id
$$;
REVOKE ALL ON FUNCTION lookup_workflow_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_workflow_webhook(uuid) TO penai_app;

-- Lần chạy còn "running" khi máy chủ khởi động lại = đã bị cắt giữa chừng.
CREATE OR REPLACE FUNCTION fail_interrupted_workflow_runs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE n integer;
BEGIN
  UPDATE workflow_runs SET status = 'failed', finished_at = now(),
    error = 'Máy chủ khởi động lại trong lúc đang chạy'
  WHERE status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION fail_interrupted_workflow_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_interrupted_workflow_runs() TO penai_app;

-- Dọn dẹp hằng ngày: giữ p_keep lần chạy gần nhất mỗi quy trình, 50 phiên bản gần nhất, nonce > 1 ngày.
CREATE OR REPLACE FUNCTION prune_workflow_data(p_keep int)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM workflow_runs r USING (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY workflow_id ORDER BY started_at DESC) AS rn FROM workflow_runs
    ) x WHERE x.rn > p_keep
  ) old WHERE r.id = old.id AND r.status <> 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM workflow_versions v USING (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY workflow_id ORDER BY version DESC) AS rn FROM workflow_versions
    ) x WHERE x.rn > 50
  ) old WHERE v.id = old.id;
  DELETE FROM workflow_webhook_nonces WHERE created_at < now() - interval '1 day';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION prune_workflow_data(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_workflow_data(int) TO penai_app;
