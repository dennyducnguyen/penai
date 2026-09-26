-- 0005: Skills (SKILL.md trong DB) + custom tools (shell template) + MCP servers

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  content text NOT NULL,               -- nội dung hướng dẫn (markdown)
  enabled boolean NOT NULL DEFAULT true,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', name || ' ' || description || ' ' || content)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX skills_slug_uq ON skills(workspace_id, slug);
CREATE INDEX skills_tsv_idx ON skills USING gin(tsv);

CREATE TABLE custom_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,                  -- tên tool (a-z0-9_)
  description text NOT NULL,
  command_template text NOT NULL,      -- vd: "curl -s {{url}}"
  params_schema jsonb NOT NULL DEFAULT '{}',  -- JSON Schema tham số
  env_encrypted text,                  -- biến môi trường mã hóa (KEY=val;...)
  requires_approval boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_tools_name_uq ON custom_tools(workspace_id, name);

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('stdio','sse','http')),
  command text,                        -- stdio: lệnh chạy server
  args jsonb NOT NULL DEFAULT '[]',
  url text,                            -- sse/http: endpoint
  env_encrypted text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_servers_name_uq ON mcp_servers(workspace_id, name);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skills', 'custom_tools', 'mcp_servers'] LOOP
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

-- Boot: list custom_tools + mcp_servers enabled (không có workspace context)
CREATE OR REPLACE FUNCTION list_enabled_custom_tools()
RETURNS TABLE (
  id uuid, workspace_id uuid, name text, description text,
  command_template text, params_schema jsonb, env_encrypted text, requires_approval boolean
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, name, description, command_template, params_schema,
         env_encrypted, requires_approval
  FROM custom_tools WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_custom_tools() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_custom_tools() TO penai_app;

CREATE OR REPLACE FUNCTION list_enabled_mcp_servers()
RETURNS TABLE (
  id uuid, workspace_id uuid, name text, transport text,
  command text, args jsonb, url text, env_encrypted text
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, name, transport, command, args, url, env_encrypted
  FROM mcp_servers WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_mcp_servers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_mcp_servers() TO penai_app;
