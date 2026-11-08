-- 0038: App Meta riêng của người dùng (Facebook Fanpage / Instagram không qua hub)
-- + kiểu kết nối MCP "internal" (agent dùng chính MCP server của PenAI, chạy trong tiến trình).
--
-- Chỉ THÊM bảng; ràng buộc transport của mcp_servers được NỚI (thêm 'internal') — bản cũ đọc
-- được dòng 'internal' nhưng không kết nối được (báo lỗi trong trang MCP), không hỏng gì khác.

CREATE TABLE meta_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  app_id text NOT NULL,
  app_secret_encrypted text NOT NULL,          -- App Secret, mã hóa AES-256-GCM
  verify_token text NOT NULL,                  -- mã xác minh webhook (Meta gửi kèm khi kiểm địa chỉ)
  login_config_id text NOT NULL DEFAULT '',    -- Facebook Login for Business: configuration id (trống = dùng scope)
  user_token_encrypted text,                   -- token người dùng dài hạn (~60 ngày), mã hóa
  user_token_expires_at timestamptz,
  fb_user_id text NOT NULL DEFAULT '',
  fb_user_name text NOT NULL DEFAULT '',
  granted_scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, app_id)
);

ALTER TABLE meta_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON meta_apps
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_apps TO penai_app;

-- Webhook của Meta tới không có ngữ cảnh workspace → tra app theo id.
CREATE OR REPLACE FUNCTION lookup_meta_app(p_id uuid)
RETURNS TABLE (id uuid, workspace_id uuid, app_id text, app_secret_encrypted text, verify_token text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id, workspace_id, app_id, app_secret_encrypted, verify_token FROM meta_apps WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION lookup_meta_app(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_meta_app(uuid) TO penai_app;

-- MCP server kiểu "internal": bộ công cụ của chính PenAI (PenAI Kênh…) cho agent dùng.
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_transport_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_transport_check CHECK (transport IN ('stdio', 'sse', 'http', 'internal'));
