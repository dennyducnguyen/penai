-- 0025: API công khai OpenAI-compatible (specs/spec-public-api-gateway.md)
--
-- Không sửa bảng api_keys: nó được đọc qua hàm SECURITY DEFINER
-- auth_lookup_api_key() khi CHƯA có workspace context; thêm cột ở đó là phải
-- sửa cả hàm. Chính sách để ở bảng phụ, tra SAU khi đã có context → RLS thường.

-- ===== Chính sách theo API key =====
CREATE TABLE api_key_policies (
  api_key_id uuid PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  -- NULL = theo api.defaultModels trong config; mảng = allowlist tường minh
  models jsonb,
  agents jsonb,
  rpm integer,
  max_concurrent integer,
  monthly_tokens bigint,
  paused boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_key_policies_ws_idx ON api_key_policies(workspace_id);

ALTER TABLE api_key_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON api_key_policies
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_policies TO penai_app;

-- ===== Usage theo key theo ngày =====
-- Thiếu bảng này thì khi một app lỗi vòng lặp gọi hàng nghìn request sẽ không
-- biết thủ phạm là ai.
CREATE TABLE api_usage_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day date NOT NULL,
  model text NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  images integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  queued_ms bigint NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day, model)
);
CREATE INDEX api_usage_daily_ws_day_idx ON api_usage_daily(workspace_id, day DESC);

ALTER TABLE api_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON api_usage_daily
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_usage_daily TO penai_app;

-- ===== Neo hội thoại API → session agent =====
CREATE TABLE api_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_conversations_uq
  ON api_conversations(api_key_id, conversation_id, agent_id);
CREATE INDEX api_conversations_ws_idx ON api_conversations(workspace_id);

ALTER TABLE api_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON api_conversations
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_conversations TO penai_app;

-- ===== Idempotency =====
CREATE TABLE api_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',   -- running | succeeded | failed
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_idempotency_uq ON api_idempotency(api_key_id, idem_key);
CREATE INDEX api_idempotency_created_idx ON api_idempotency(created_at);

ALTER TABLE api_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON api_idempotency
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_idempotency TO penai_app;

-- ===== Trạng thái route (cooldown) — bền qua restart =====
CREATE TABLE llm_route_state (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  modality text NOT NULL DEFAULT 'chat',     -- chat | images
  cooldown_until timestamptz,
  cooldown_streak integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider, model, modality)
);

ALTER TABLE llm_route_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_route_state FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON llm_route_state
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_route_state TO penai_app;

-- Trace từ API: thêm cột nguồn để tách lưu lượng app khỏi kênh chat.
-- (traces.kind vẫn giữ 'chat' cho tương thích; source mới là trục thứ hai.)
ALTER TABLE traces ADD COLUMN source text NOT NULL DEFAULT 'web';
ALTER TABLE traces ADD COLUMN api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE traces ADD COLUMN model text NOT NULL DEFAULT '';
ALTER TABLE traces ADD COLUMN provider text NOT NULL DEFAULT '';
CREATE INDEX traces_source_idx ON traces(workspace_id, source, created_at DESC);

-- Auth API key phải trả thêm id: chính sách/usage/idempotency đều khóa theo
-- api_key_id. Thay hàm bằng tên MỚI (đổi kiểu trả về của hàm cũ sẽ lỗi
-- "cannot change return type"), giữ hàm cũ cho tương thích.
CREATE OR REPLACE FUNCTION auth_lookup_api_key_v2(p_hash text)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  workspace_id uuid,
  role text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT k.id, k.user_id, k.workspace_id, k.role, k.expires_at, k.revoked_at
  FROM api_keys k
  WHERE k.key_hash = p_hash
$$;
REVOKE ALL ON FUNCTION auth_lookup_api_key_v2(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_api_key_v2(text) TO penai_app;
