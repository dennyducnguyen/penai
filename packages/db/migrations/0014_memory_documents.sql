-- 0014: Memory dạng FILE (MEMORY.md, memory/*.md) + worker consolidation
--
-- Agent ghi file MEMORY.md / memory/YYYY-MM-DD.md bằng write_file như file
-- thường (nằm trên đĩa trong thư mục làm việc), đồng thời fs-tools báo về
-- runtime để lưu bản sao vào bảng này — có tsvector để memory_search tìm lại
-- và memory_get đọc theo dòng. user_key NULL = ghi nhớ chung của agent.

CREATE TABLE memory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  user_key text,
  path text NOT NULL,          -- 'MEMORY.md', 'memory/2026-08-05.md'
  content text NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_documents_uq
  ON memory_documents(workspace_id, agent_id, coalesce(user_key, ''), path);
CREATE INDEX memory_documents_tsv_idx ON memory_documents USING gin(tsv);

ALTER TABLE memory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON memory_documents
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_documents TO penai_app;

-- Worker consolidation chạy nền không có workspace context → SECURITY DEFINER
-- (mẫu như claim_due_cron_jobs). Trả các session "đã nguội" (idle đủ lâu,
-- đủ nội dung) mà CHƯA có memory episodic mới hơn tin nhắn cuối.
CREATE OR REPLACE FUNCTION list_sessions_needing_consolidation(
  p_idle_minutes int,
  p_min_messages int,
  p_max_age_days int,
  p_limit int
) RETURNS TABLE (
  session_id uuid,
  workspace_id uuid,
  agent_id uuid,
  last_msg timestamptz,
  msg_count bigint
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.workspace_id, s.agent_id,
         max(m.created_at) AS last_msg,
         count(*) AS msg_count
  FROM sessions s
  JOIN messages m ON m.session_id = s.id AND m.role IN ('user', 'assistant')
  GROUP BY s.id, s.workspace_id, s.agent_id
  HAVING max(m.created_at) < now() - make_interval(mins => p_idle_minutes)
     AND max(m.created_at) > now() - make_interval(days => p_max_age_days)
     AND count(*) >= p_min_messages
     AND NOT EXISTS (
       SELECT 1 FROM memories mem
       WHERE mem.source_session_id = s.id
         AND mem.created_at > max(m.created_at)
     )
  ORDER BY max(m.created_at) ASC
  LIMIT p_limit
$$;
GRANT EXECUTE ON FUNCTION list_sessions_needing_consolidation(int, int, int, int) TO penai_app;
