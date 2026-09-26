-- 0020: Link công khai cho file trong workspace (tool publish_file)
-- Token 256-bit chỉ lưu dạng SHA-256 hash — DB lộ cũng không dựng lại được URL.
-- Route public GET /f/:token tra theo hash, kiểm hạn + revoked, rồi stream file.

CREATE TABLE published_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  token_hash text NOT NULL,          -- sha256(token) hex — không lưu token gốc
  abs_path text NOT NULL,            -- đường dẫn tuyệt đối trong .data/<ws>/
  file_name text NOT NULL,           -- tên file hiển thị / download
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  created_by text NOT NULL DEFAULT '',  -- userKey kênh chat hoặc userId API
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX published_files_token_uq ON published_files(token_hash);
CREATE INDEX published_files_ws_idx ON published_files(workspace_id);

ALTER TABLE published_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_files FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON published_files
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON published_files TO penai_app;

-- Route public không có workspace context → SECURITY DEFINER tra theo token hash
CREATE FUNCTION get_published_file(p_token_hash text)
RETURNS TABLE (
  id uuid, workspace_id uuid, abs_path text, file_name text,
  content_type text, expires_at timestamptz, revoked boolean
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, abs_path, file_name, content_type, expires_at, revoked
  FROM published_files WHERE token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION get_published_file(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_published_file(text) TO penai_app;
