-- 0018: Workspace Semantic — kiến thức dùng chung cho nhiều agent.
--
-- Tách bảng riêng để không làm yếu invariant memories.agent_id NOT NULL.
-- Chỉ memory được ghim mới auto-inject; memory còn lại truy hồi theo tsvector.

ALTER TABLE agents
  ADD COLUMN workspace_memory_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE workspace_semantic_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  importance real NOT NULL DEFAULT 0.8 CHECK (importance >= 0 AND importance <= 1),
  pinned boolean NOT NULL DEFAULT false,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed timestamptz,
  content_hash text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workspace_semantic_memories_dedup_uq
  ON workspace_semantic_memories(workspace_id, content_hash);
CREATE INDEX workspace_semantic_memories_tsv_idx
  ON workspace_semantic_memories USING gin(tsv);
CREATE INDEX workspace_semantic_memories_rank_idx
  ON workspace_semantic_memories(workspace_id, pinned DESC, importance DESC, updated_at DESC);

ALTER TABLE workspace_semantic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_semantic_memories FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON workspace_semantic_memories
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_semantic_memories TO penai_app;
