-- 0007: Knowledge Vault (tài liệu + wikilinks) + Knowledge Graph (entity/relation)

CREATE TABLE vault_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  slug text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vault_slug_uq ON vault_documents(workspace_id, slug);
CREATE INDEX vault_tsv_idx ON vault_documents USING gin(tsv);

CREATE TABLE kg_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'entity',
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kg_entities_uq ON kg_entities(workspace_id, lower(name));

CREATE TABLE kg_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  from_entity uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_entity uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kg_relations_from_idx ON kg_relations(from_entity);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vault_documents','kg_entities','kg_relations'] LOOP
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

-- Duyệt đồ thị: từ 1 entity, lấy các entity liên quan tới độ sâu p_depth (recursive CTE).
CREATE OR REPLACE FUNCTION kg_traverse(p_start uuid, p_depth int)
RETURNS TABLE (entity_id uuid, name text, relation text, depth int)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk AS (
    SELECT r.to_entity AS entity_id, r.relation, 1 AS depth
    FROM kg_relations r WHERE r.from_entity = p_start
    UNION ALL
    SELECT r.to_entity, r.relation, w.depth + 1
    FROM kg_relations r
    JOIN walk w ON r.from_entity = w.entity_id
    WHERE w.depth < p_depth
  )
  SELECT DISTINCT w.entity_id, e.name, w.relation, w.depth
  FROM walk w JOIN kg_entities e ON e.id = w.entity_id
  ORDER BY w.depth
$$;
