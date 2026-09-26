-- 0008: Tracing (traces) + Usage caps + Hooks (lifecycle) + Agent webhooks (inbound)

CREATE TABLE traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid REFERENCES agents(id),
  session_id uuid REFERENCES sessions(id),
  kind text NOT NULL DEFAULT 'chat',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  iterations integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX traces_ws_idx ON traces(workspace_id, created_at DESC);

CREATE TABLE usage_caps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) UNIQUE,
  monthly_token_limit bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  event text NOT NULL,               -- pre_tool_use | post_tool_use | stop | session_start
  matcher text NOT NULL DEFAULT '.*', -- regex khớp tên tool / nội dung
  url text NOT NULL,                 -- HTTP endpoint gọi khi khớp
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hooks_ws_event_idx ON hooks(workspace_id, event) WHERE enabled = true;

CREATE TABLE agent_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  secret_encrypted text NOT NULL,    -- HMAC secret mã hóa
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES agent_webhooks(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webhook_nonces_uq ON webhook_nonces(webhook_id, nonce);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['traces','usage_caps','hooks','agent_webhooks'] LOOP
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
GRANT SELECT, INSERT, DELETE ON webhook_nonces TO penai_app;

-- Tổng token đã dùng trong tháng hiện tại của workspace (dùng cho usage cap).
CREATE OR REPLACE FUNCTION workspace_month_tokens(p_ws uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint
  FROM traces
  WHERE workspace_id = p_ws AND created_at >= date_trunc('month', now())
$$;
REVOKE ALL ON FUNCTION workspace_month_tokens(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_month_tokens(uuid) TO penai_app;

-- Lookup webhook (không có ws context lúc nhận request).
CREATE OR REPLACE FUNCTION lookup_agent_webhook(p_id uuid)
RETURNS TABLE (id uuid, workspace_id uuid, agent_id uuid, secret_encrypted text, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id, workspace_id, agent_id, secret_encrypted, enabled FROM agent_webhooks WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION lookup_agent_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_agent_webhook(uuid) TO penai_app;

-- Cap check (không có ws context ở runtime channel/cron).
CREATE OR REPLACE FUNCTION workspace_cap(p_ws uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT monthly_token_limit FROM usage_caps WHERE workspace_id = p_ws
$$;
REVOKE ALL ON FUNCTION workspace_cap(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_cap(uuid) TO penai_app;
