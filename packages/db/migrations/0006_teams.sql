-- 0006: Teams + task board (atomic claim) + delegation links

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_ws_idx ON teams(workspace_id);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, agent_id)
);

CREATE TABLE team_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','claimed','done','failed')),
  claimed_by uuid REFERENCES agents(id),
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_tasks_board_idx ON team_tasks(team_id, status, created_at);

-- Liên kết ủy quyền giữa agent (from được phép delegate cho to)
CREATE TABLE agent_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  from_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'sync' CHECK (mode IN ('sync','async')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_links_uq ON agent_links(from_agent_id, to_agent_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams','team_members','team_tasks','agent_links'] LOOP
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

-- Claim 1 task todo (atomic, SKIP LOCKED) → chuyển sang claimed bởi agent.
CREATE OR REPLACE FUNCTION claim_team_task(p_team_id uuid, p_agent_id uuid)
RETURNS TABLE (id uuid, title text, description text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT tt.id FROM team_tasks tt
    WHERE tt.team_id = p_team_id AND tt.status = 'todo'
    ORDER BY tt.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE team_tasks tt
  SET status = 'claimed', claimed_by = p_agent_id, updated_at = now()
  FROM picked WHERE tt.id = picked.id
  RETURNING tt.id, tt.title, tt.description;
END $$;
