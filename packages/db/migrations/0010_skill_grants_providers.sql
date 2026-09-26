-- 0010: Skill grants per-agent (skill_agent_grants)
--       + agents.thinking_level (reasoning effort)
--       + bảng llm_providers (provider cấu hình runtime, API key mã hóa)

-- Reasoning effort per-agent (gpt-5.x qua Codex): off | minimal | low | medium | high
ALTER TABLE agents ADD COLUMN thinking_level text NOT NULL DEFAULT 'off';

-- Skill visibility + grant per-agent.
-- visibility: 'workspace' = mọi agent trong workspace thấy (mặc định, tương thích cũ)
--             'granted'   = chỉ agent được grant mới thấy
ALTER TABLE skills ADD COLUMN visibility text NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('workspace', 'granted'));

CREATE TABLE skill_agent_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  can_manage boolean NOT NULL DEFAULT false,
  granted_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, skill_id, agent_id)
);
CREATE INDEX skill_agent_grants_agent_idx ON skill_agent_grants(agent_id);

-- Providers cấu hình runtime (bổ sung cho providers trong config file).
-- kind: openai-compat | anthropic | dashscope (Qwen)
CREATE TABLE llm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('openai-compat', 'anthropic', 'dashscope')),
  base_url text,
  api_key_encrypted text,
  default_model text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX llm_providers_name_uq ON llm_providers(workspace_id, name);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skill_agent_grants', 'llm_providers'] LOOP
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

-- Boot: nạp mọi provider enabled (không có workspace context — như channels)
CREATE OR REPLACE FUNCTION list_enabled_llm_providers()
RETURNS TABLE (
  id uuid, workspace_id uuid, name text, kind text,
  base_url text, api_key_encrypted text, default_model text
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, name, kind, base_url, api_key_encrypted, default_model
  FROM llm_providers WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_llm_providers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_llm_providers() TO penai_app;
