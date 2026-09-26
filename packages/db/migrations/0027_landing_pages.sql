-- 0027: Landing page do agent tao/sua, xem cong khai tren domain PenAI.
-- HTML chay trong CSP sandbox o route public; DB la nguon chuan de backup/restore.

CREATE TABLE landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  html text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX landing_pages_ws_updated_idx ON landing_pages(workspace_id, updated_at DESC);

ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON landing_pages
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages TO penai_app;

-- Route public khong co workspace context. UUID cong khai trong URL la dinh danh,
-- khong phai credential; trang nao da publish thi ai co link deu xem duoc.
CREATE FUNCTION get_public_landing_page(p_id uuid)
RETURNS TABLE (
  id uuid, workspace_id uuid, slug text, title text, html text,
  version integer, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp AS $$
  SELECT lp.id, lp.workspace_id, lp.slug, lp.title, lp.html, lp.version, lp.updated_at
  FROM landing_pages lp WHERE lp.id = p_id
$$;
REVOKE ALL ON FUNCTION get_public_landing_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_public_landing_page(uuid) TO penai_app;
