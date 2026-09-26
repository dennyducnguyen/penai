-- 0003: Cron jobs + heartbeat (agent chạy theo lịch)

CREATE TABLE cron_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'cron' CHECK (kind IN ('cron','heartbeat')),
  schedule text NOT NULL,           -- "every 5m" | "at ..." | cron expr
  prompt text NOT NULL,             -- nội dung gửi cho agent mỗi lần chạy
  enabled boolean NOT NULL DEFAULT true,
  next_run timestamptz NOT NULL,
  last_run timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cron_jobs_due_idx ON cron_jobs(next_run) WHERE enabled = true;

CREATE TABLE cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  cron_job_id uuid NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,             -- ok | error
  output text
);
CREATE INDEX cron_runs_job_idx ON cron_runs(cron_job_id, run_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cron_jobs', 'cron_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I '
      || 'USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', t);
  END LOOP;
END $$;

-- Lấy các job tới hạn trên toàn hệ (không cần workspace context — dùng ở runner).
-- Atomic claim: cập nhật next_run tạm để 2 runner không chạy trùng (SKIP LOCKED).
CREATE OR REPLACE FUNCTION claim_due_cron_jobs(p_now timestamptz, p_limit int)
RETURNS TABLE (
  id uuid, workspace_id uuid, agent_id uuid, name text, kind text,
  schedule text, prompt text
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT c.id FROM cron_jobs c
    WHERE c.enabled = true AND c.next_run <= p_now
    ORDER BY c.next_run
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE cron_jobs c SET last_run = p_now
  FROM due WHERE c.id = due.id
  RETURNING c.id, c.workspace_id, c.agent_id, c.name, c.kind, c.schedule, c.prompt;
END $$;
REVOKE ALL ON FUNCTION claim_due_cron_jobs(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_cron_jobs(timestamptz, int) TO penai_app;

-- Cập nhật next_run sau khi chạy xong (hoặc disable nếu one-shot đã hết).
CREATE OR REPLACE FUNCTION update_cron_next_run(p_id uuid, p_next timestamptz, p_disable boolean)
RETURNS void
LANGUAGE sql SECURITY DEFINER
AS $$
  UPDATE cron_jobs
  SET next_run = COALESCE(p_next, next_run),
      enabled = CASE WHEN p_disable THEN false ELSE enabled END
  WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION update_cron_next_run(uuid, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_cron_next_run(uuid, timestamptz, boolean) TO penai_app;
