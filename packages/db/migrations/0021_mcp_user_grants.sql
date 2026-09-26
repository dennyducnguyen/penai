-- 0021: Phân quyền MCP theo NGƯỜI DÙNG CUỐI trên kênh chat
--       (bảng mcp_user_grants). user_key = "<channel_kind>-<sender_id>"
--       (trùng userKey trong channels-runtime, nối được về contacts).
--
-- user_policy trên mcp_servers:
--   'all'     = mọi người dùng đã pair dùng được (mặc định, tương thích cũ);
--               grant per-user nếu có chỉ dùng để VETO / thu hẹp tool.
--   'granted' = chỉ người dùng có grant enabled mới thấy tool của server.
--
-- Ngữ nghĩa tool_allow/tool_deny (deny luôn thắng):
--   allow [] = mọi tool; allow không rỗng = chỉ các tool đó;
--   deny chứa tool nào thì tool đó bị chặn kể cả khi nằm trong allow.
-- Quyền cuối = giao của (grant agent) và (grant user).
-- Đường chạy không có userKey (dashboard/cron/webhook = operator) bỏ qua lớp user.

ALTER TABLE mcp_servers ADD COLUMN user_policy text NOT NULL DEFAULT 'all'
  CHECK (user_policy IN ('all', 'granted'));

CREATE TABLE mcp_user_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_key text NOT NULL,            -- "<channel_kind>-<sender_id>"
  enabled boolean NOT NULL DEFAULT true,  -- false = veto (chặn server với user này)
  tool_allow jsonb NOT NULL DEFAULT '[]',
  tool_deny jsonb NOT NULL DEFAULT '[]',
  granted_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, mcp_server_id, user_key)
);
CREATE INDEX mcp_user_grants_user_idx ON mcp_user_grants(user_key);

ALTER TABLE mcp_user_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_user_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON mcp_user_grants
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_user_grants TO penai_app;
