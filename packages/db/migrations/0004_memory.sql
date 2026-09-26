-- 0004: Memory 3 tầng (episodic + semantic) với full-text search
-- (pgvector chưa có trên PG portable → dùng tsvector; cột embedding để dành
--  cho tương lai khi deploy với image pgvector.)

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  tier text NOT NULL CHECK (tier IN ('episodic','semantic')),
  content text NOT NULL,
  -- semantic: fact bền vững; episodic: tóm tắt 1 session
  source_session_id uuid REFERENCES sessions(id),
  importance real NOT NULL DEFAULT 0.5,   -- 0..1, semantic quan trọng auto-inject (L0)
  embedding jsonb,                         -- để dành pgvector
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_tsv_idx ON memories USING gin(tsv);
CREATE INDEX memories_scope_idx ON memories(workspace_id, agent_id, tier, importance DESC);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON memories
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO penai_app;
