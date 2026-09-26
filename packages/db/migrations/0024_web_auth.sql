-- 0024: Đăng nhập Dashboard bằng tài khoản (email + mật khẩu) + role `member`
--       + gán agent theo người dùng + chủ sở hữu phiên chat.
--
-- Mô hình:
--   * API key (psk_) giữ nguyên — chỉ dành cho máy gọi máy (Live Studio, script).
--   * Người dùng đăng nhập web → web_sessions (cookie httpOnly) → cùng authCtx
--     {userId, workspaceId, role} như API key → mọi route cũ không đổi.
--   * Role mới `member`: CHỈ được chat với agent có dòng trong agent_user_grants,
--     chỉ thấy phiên chat của chính mình (sessions.owner_user_id).
--   * Tạm thời 1 user thuộc đúng 1 workspace (workspace_members vẫn cho phép nhiều;
--     đăng nhập chọn membership đầu tiên).

-- ===== users: mật khẩu + trạng thái =====
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- ===== role `member` =====
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('ws_admin', 'operator', 'viewer', 'member'));

-- ===== web_sessions (company-level, không RLS — tra cứu trước khi có context) =====
CREATE TABLE web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,       -- sha256 của token trong cookie
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  user_agent text,
  ip text
);
CREATE INDEX web_sessions_user_idx ON web_sessions(user_id);
CREATE INDEX web_sessions_expires_idx ON web_sessions(expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON web_sessions TO penai_app;

-- ===== agent_user_grants: member được chat với agent nào =====
CREATE TABLE agent_user_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, agent_id, user_id)
);
CREATE INDEX agent_user_grants_user_idx ON agent_user_grants(workspace_id, user_id);
ALTER TABLE agent_user_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_user_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_user_grants
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_user_grants TO penai_app;

-- ===== sessions: chủ sở hữu (NULL = phiên cũ / tạo qua API key / kênh chat) =====
ALTER TABLE sessions ADD COLUMN owner_user_id uuid REFERENCES users(id);
CREATE INDEX sessions_owner_idx ON sessions(workspace_id, owner_user_id);

-- ===== Hàm auth SECURITY DEFINER (lối vào duy nhất trước khi có context) =====
-- Tra phiên web theo hash token; role đọc SỐNG từ workspace_members nên đổi
-- quyền có hiệu lực ngay ở request kế tiếp.
CREATE OR REPLACE FUNCTION auth_lookup_web_session(p_hash text)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  workspace_id uuid,
  role text,
  expires_at timestamptz,
  revoked_at timestamptz,
  user_active boolean,
  must_change_password boolean
)
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT s.id, s.user_id, s.workspace_id, m.role, s.expires_at, s.revoked_at,
         u.is_active, u.must_change_password
  FROM web_sessions s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
  WHERE s.token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION auth_lookup_web_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_web_session(text) TO penai_app;

-- Danh sách workspace của 1 user (dùng lúc đăng nhập, chưa có context)
CREATE OR REPLACE FUNCTION auth_lookup_memberships(p_user_id uuid)
RETURNS TABLE (workspace_id uuid, role text, slug text, name text)
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT m.workspace_id, m.role, w.slug, w.name
  FROM workspace_members m
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at ASC
$$;
REVOKE ALL ON FUNCTION auth_lookup_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_memberships(uuid) TO penai_app;
