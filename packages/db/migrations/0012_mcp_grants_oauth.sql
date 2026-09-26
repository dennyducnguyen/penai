-- 0012: MCP phân quyền theo agent (tương tự skill_agent_grants)
--       + OAuth cho MCP server http/sse (token mã hóa, lưu theo server)

-- visibility: 'workspace' = mọi agent trong workspace dùng được (mặc định, tương thích cũ)
--             'granted'   = chỉ agent được grant mới thấy tool của server này
ALTER TABLE mcp_servers ADD COLUMN visibility text NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('workspace', 'granted'));

-- OAuth session (JSON mã hóa AES-256-GCM: client đã đăng ký DCR, tokens, PKCE verifier)
ALTER TABLE mcp_servers ADD COLUMN oauth_encrypted text;

CREATE TABLE mcp_agent_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Danh sách tool được phép ([] = mọi tool của server)
  tool_allow jsonb NOT NULL DEFAULT '[]',
  granted_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, mcp_server_id, agent_id)
);
CREATE INDEX mcp_agent_grants_agent_idx ON mcp_agent_grants(agent_id);

ALTER TABLE mcp_agent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_agent_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON mcp_agent_grants
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_agent_grants TO penai_app;

-- Đổi return type → phải DROP rồi tạo lại (CREATE OR REPLACE không đổi được OUT params)
DROP FUNCTION IF EXISTS list_enabled_mcp_servers();
CREATE FUNCTION list_enabled_mcp_servers()
RETURNS TABLE (
  id uuid, workspace_id uuid, name text, transport text,
  command text, args jsonb, url text, env_encrypted text,
  visibility text, oauth_encrypted text
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, name, transport, command, args, url, env_encrypted,
         visibility, oauth_encrypted
  FROM mcp_servers WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_mcp_servers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_mcp_servers() TO penai_app;
