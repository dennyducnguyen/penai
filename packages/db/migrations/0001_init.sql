-- 0001: Schema nền + role app + RLS fail-closed
-- Chạy bằng role admin (postgres). App kết nối bằng penai_app (KHÔNG BYPASSRLS).

-- ===== Role ứng dụng =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'penai_app') THEN
    CREATE ROLE penai_app LOGIN PASSWORD 'penai_app';
  END IF;
END $$;

-- ===== Company-level =====
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  company_role text NOT NULL DEFAULT 'member'
    CHECK (company_role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Workspace-scoped =====
CREATE TABLE workspace_members (
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL CHECK (role IN ('ws_admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL CHECK (role IN ('ws_admin', 'operator', 'viewer')),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  key text NOT NULL,
  name text NOT NULL,
  system_prompt text NOT NULL DEFAULT '',
  provider text NOT NULL,
  model text NOT NULL,
  max_iterations integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_ws_key_uq ON agents(workspace_id, key);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_ws_idx ON sessions(workspace_id, updated_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content jsonb NOT NULL,
  seq bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_session_seq_uq ON messages(session_id, seq);
CREATE INDEX messages_ws_idx ON messages(workspace_id);

-- ===== RLS: fail-closed =====
-- current_setting('app.workspace_id', true) trả NULL khi chưa từng SET,
-- nhưng trả '' (chuỗi rỗng) nếu GUC từng được SET LOCAL trước đó trên cùng
-- connection → NULLIF(..., '') chuẩn hóa cả hai về NULL.
-- So sánh với NULL không match dòng nào → không có context = không có dữ liệu.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_members', 'api_keys', 'agents', 'sessions', 'messages'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I '
      || 'USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- ===== Quyền cho role app =====
GRANT SELECT, INSERT, UPDATE, DELETE ON users, workspaces TO penai_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_members, api_keys, agents, sessions, messages TO penai_app;

-- ===== Hàm auth: lookup API key TRƯỚC khi có workspace context =====
-- SECURITY DEFINER (chạy quyền owner=postgres, vượt RLS) — lối vào duy nhất
-- được phép đọc api_keys không cần context, chỉ theo hash chính xác.
CREATE OR REPLACE FUNCTION auth_lookup_api_key(p_hash text)
RETURNS TABLE (
  user_id uuid,
  workspace_id uuid,
  role text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT k.user_id, k.workspace_id, k.role, k.expires_at, k.revoked_at
  FROM api_keys k
  WHERE k.key_hash = p_hash
$$;
REVOKE ALL ON FUNCTION auth_lookup_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_api_key(text) TO penai_app;
