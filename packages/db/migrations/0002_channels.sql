-- 0002: Channels (kênh nhắn tin), pairing, contacts, ánh xạ chat→session
-- Tất cả workspace-scoped + RLS như 0001.

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,               -- telegram | discord | slack | whatsapp | ...
  name text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),  -- agent mặc định xử lý tin
  token_encrypted text,             -- bot token/credential mã hóa AES-256-GCM
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  -- true: chỉ user đã pair mới chat được; false: mọi user đều được
  require_pairing boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_ws_idx ON channels(workspace_id);

CREATE TABLE channel_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  code text NOT NULL,               -- mã 8 ký tự người dùng nhập để duyệt
  external_user_id text,            -- user id trên nền tảng (điền khi dùng mã)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX channel_pairings_code_uq ON channel_pairings(channel_id, code);
CREATE INDEX channel_pairings_ext_idx ON channel_pairings(channel_id, external_user_id);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_kind text NOT NULL,
  external_id text NOT NULL,        -- user id trên nền tảng
  display_name text,
  approved boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_uq ON contacts(workspace_id, channel_kind, external_id);

-- Ánh xạ 1 hội thoại của kênh (vd 1 chat Telegram) → 1 session đang chạy
CREATE TABLE channel_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  chat_key text NOT NULL,           -- chat_id (+ thread) trên nền tảng
  session_id uuid NOT NULL REFERENCES sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_sessions_uq ON channel_sessions(channel_id, chat_key);

-- RLS fail-closed cho các bảng mới
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channels', 'channel_pairings', 'contacts', 'channel_sessions'
  ] LOOP
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

-- Lookup channel để khởi động (không có workspace context lúc boot):
-- trả về mọi channel enabled kèm workspace_id để adapter tự SET context.
CREATE OR REPLACE FUNCTION list_enabled_channels()
RETURNS TABLE (
  id uuid, workspace_id uuid, kind text, name text, agent_id uuid,
  token_encrypted text, config jsonb, require_pairing boolean
)
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT id, workspace_id, kind, name, agent_id, token_encrypted, config, require_pairing
  FROM channels WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_channels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_channels() TO penai_app;
