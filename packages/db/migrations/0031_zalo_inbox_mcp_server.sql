-- 0031: Zalo cá nhân — Inbox trực chat (lưu nội dung tin nhắn, nhiều người cùng xem/trả lời)
--       + PenAI MCP server (OAuth cho Claude/ChatGPT… gọi vào: tra danh bạ, gửi tin/ảnh Zalo).
--
-- Chỉ THÊM bảng mới — không đụng bảng cũ.

-- ===== Hội thoại Zalo (cá nhân + nhóm) của từng kênh zalo_personal =====
CREATE TABLE zalo_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,                  -- uid người (cá nhân) hoặc id nhóm
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  name text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  is_contact boolean NOT NULL DEFAULT false, -- có trong danh bạ (bạn bè) / nhóm đang tham gia
  member_count integer,
  last_message text NOT NULL DEFAULT '',
  last_message_at timestamptz,
  last_direction text,
  unread_count integer NOT NULL DEFAULT 0,
  ai_mode text NOT NULL DEFAULT 'auto' CHECK (ai_mode IN ('auto', 'off')),
  paused_until timestamptz,                 -- nhân viên vừa trả lời → AI tạm im tới lúc này
  synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, thread_id)
);
CREATE INDEX zalo_threads_list_idx ON zalo_threads(channel_id, last_message_at DESC NULLS LAST);

-- ===== Tin nhắn (đến + đi) =====
CREATE TABLE zalo_messages (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  msg_id text NOT NULL DEFAULT '',
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  -- zalo = khách/nhóm gửi tới · app = chủ tài khoản gửi từ điện thoại · agent = AI trả lời
  -- web = nhân viên gửi từ Inbox · mcp = ứng dụng AI bên ngoài gửi qua MCP · api = REST
  source text NOT NULL DEFAULT 'zalo',
  sender_id text NOT NULL DEFAULT '',
  sender_name text NOT NULL DEFAULT '',
  web_user_id uuid,
  content_type text NOT NULL DEFAULT 'text',
  text text NOT NULL DEFAULT '',
  media jsonb,
  meta jsonb,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zalo_messages_thread_idx ON zalo_messages(channel_id, thread_id, id DESC);
CREATE UNIQUE INDEX zalo_messages_msgid_uq ON zalo_messages(channel_id, msg_id) WHERE msg_id <> '';

-- ===== Member được trực kênh Zalo nào (operator trở lên: mọi kênh) =====
CREATE TABLE zalo_channel_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX zalo_channel_members_user_idx ON zalo_channel_members(workspace_id, user_id);

-- ===== Chống gửi trùng qua MCP (request_id) =====
CREATE TABLE mcp_server_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  principal text NOT NULL,                  -- "<userId>:<clientId>"
  request_id text NOT NULL,
  payload_hash text NOT NULL,
  tool text NOT NULL,
  channel_id uuid,
  recipient text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, principal, request_id)
);
CREATE INDEX mcp_server_sends_recent_idx ON mcp_server_sends(workspace_id, created_at DESC);

-- RLS fail-closed + GRANT theo đúng pattern 0002
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_threads', 'zalo_messages', 'zalo_channel_members', 'mcp_server_sends'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE zalo_messages_id_seq TO penai_app;

-- ===== OAuth cho PenAI MCP server (company-level như web_sessions — tra trước khi có context) =====
-- Token/code/secret chỉ lưu dạng sha256.
CREATE TABLE mcp_oauth_clients (
  id text PRIMARY KEY,                      -- client_id
  metadata jsonb NOT NULL,                  -- client_secret (nếu có) đã băm
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_oauth_pending (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  params jsonb NOT NULL,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE mcp_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  password_version text NOT NULL,           -- sha256(password_hash) lúc cấp → đổi mật khẩu = thu hồi
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX mcp_oauth_grants_user_idx ON mcp_oauth_grants(workspace_id, user_id);

CREATE TABLE mcp_oauth_codes (
  hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE mcp_oauth_tokens (
  hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX mcp_oauth_tokens_grant_idx ON mcp_oauth_tokens(grant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_oauth_clients, mcp_oauth_pending, mcp_oauth_grants,
  mcp_oauth_codes, mcp_oauth_tokens TO penai_app;
