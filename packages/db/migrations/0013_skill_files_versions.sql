-- 0013: Skill nhiều file (scripts/, references/) + phiên bản skill
--       (DB là nguồn chuẩn,
--        materialize ra đĩa .data/<ws>/skills/<slug>/ cho agent đọc/chạy)

ALTER TABLE skills ADD COLUMN version integer NOT NULL DEFAULT 1;

-- File đi kèm skill (ngoài SKILL.md). path tương đối trong thư mục skill,
-- vd "scripts/tao_bao_cao.py", "references/mau-hop-dong.md".
-- Nội dung base64 để chứa được cả file nhị phân nhỏ (ảnh mẫu, template office).
CREATE TABLE skill_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path text NOT NULL,
  content_b64 text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, skill_id, path)
);
CREATE INDEX skill_files_skill_idx ON skill_files(skill_id);

-- Snapshot mỗi lần nội dung/file đổi — xem lại + khôi phục.
CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  content text NOT NULL,
  -- [{path, contentB64}] — file kèm theo tại thời điểm snapshot
  files jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, skill_id, version)
);
CREATE INDEX skill_versions_skill_idx ON skill_versions(skill_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skill_files', 'skill_versions'] LOOP
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

-- Boot: metadata skill enabled (SKILL.md) để materialize ra đĩa
CREATE OR REPLACE FUNCTION list_enabled_skills_for_sync()
RETURNS TABLE (workspace_id uuid, slug text, content text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT workspace_id, slug, content FROM skills WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_skills_for_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_skills_for_sync() TO penai_app;

-- Boot: materialize file skill ra đĩa cho MỌI workspace (không có ws context)
CREATE OR REPLACE FUNCTION list_all_skill_files()
RETURNS TABLE (workspace_id uuid, slug text, path text, content_b64 text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.workspace_id, s.slug, f.path, f.content_b64
  FROM skill_files f JOIN skills s ON s.id = f.skill_id
  WHERE s.enabled = true
$$;
REVOKE ALL ON FUNCTION list_all_skill_files() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_all_skill_files() TO penai_app;
