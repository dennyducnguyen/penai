-- 0009: Model fallback per-agent + Activity/audit log + tool toggle per-agent

ALTER TABLE agents ADD COLUMN provider_fallback jsonb NOT NULL DEFAULT '[]';
-- Danh sách tool bị TẮT cho agent (mặc định [] = bật hết)
ALTER TABLE agents ADD COLUMN disabled_tools jsonb NOT NULL DEFAULT '[]';

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor text NOT NULL,              -- user id / "system" / "webhook"
  action text NOT NULL,             -- vd agent.create, key.revoke, channel.delete
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_ws_idx ON audit_log(workspace_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON audit_log
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON audit_log TO penai_app;
