-- 0022: Kho tri thức theo Collection, ACL agent x audience và hybrid RAG.
-- Embedding được tạo bên ngoài VPS; PostgreSQL chỉ lưu/search vector 768D.

CREATE EXTENSION IF NOT EXISTS vector;

-- Danh tính chuẩn trong workspace. Một principal có thể có nhiều contact/channel identity.
CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL DEFAULT 'contact' CHECK (kind IN ('member', 'contact', 'service')),
  display_name text NOT NULL,
  workspace_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'disabled')),
  merged_into_id uuid REFERENCES principals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX principals_workspace_user_uq
  ON principals(workspace_id, workspace_user_id) WHERE workspace_user_id IS NOT NULL;
CREATE INDEX principals_workspace_name_idx ON principals(workspace_id, lower(display_name));

-- Mỗi workspace member có một principal ổn định để API/dashboard dùng cùng ACL với channel.
INSERT INTO principals (workspace_id, kind, display_name, workspace_user_id)
SELECT wm.workspace_id, 'member', u.name, wm.user_id
FROM workspace_members wm
JOIN users u ON u.id = wm.user_id
ON CONFLICT (workspace_id, workspace_user_id) WHERE workspace_user_id IS NOT NULL DO NOTHING;

-- contacts trở thành channel identity. Giữ channel_id nullable để tương thích dữ liệu cũ.
ALTER TABLE contacts ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN principal_id uuid REFERENCES principals(id) ON DELETE SET NULL;

-- Backfill principal cho contact cũ. Dùng cùng UUID giúp truy vết/migration rõ ràng.
INSERT INTO principals (id, workspace_id, kind, display_name, status, created_at, updated_at)
SELECT c.id, c.workspace_id, 'contact', COALESCE(NULLIF(c.display_name, ''), c.channel_kind || ':' || c.external_id),
       'active', c.first_seen, c.last_seen
FROM contacts c
ON CONFLICT (id) DO NOTHING;
UPDATE contacts SET principal_id = id WHERE principal_id IS NULL;

DROP INDEX contacts_uq;
CREATE UNIQUE INDEX contacts_channel_uq
  ON contacts(workspace_id, channel_id, external_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX contacts_legacy_uq
  ON contacts(workspace_id, channel_kind, external_id) WHERE channel_id IS NULL;
CREATE INDEX contacts_principal_idx ON contacts(workspace_id, principal_id);

-- Conversation là DM/group/thread trên đúng một channel instance; session vẫn là lịch sử agent.
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_chat_id text NOT NULL,
  peer_kind text NOT NULL DEFAULT 'direct' CHECK (peer_kind IN ('direct', 'group', 'thread')),
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id, external_chat_id)
);
CREATE INDEX conversations_workspace_idx ON conversations(workspace_id, updated_at DESC);

CREATE TABLE vault_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_tokens integer NOT NULL DEFAULT 800 CHECK (chunk_tokens BETWEEN 100 AND 4000),
  chunk_overlap_tokens integer NOT NULL DEFAULT 100 CHECK (chunk_overlap_tokens BETWEEN 0 AND 1000),
  context_tokens integer NOT NULL DEFAULT 6000 CHECK (context_tokens BETWEEN 500 AND 32000),
  retrieval_limit integer NOT NULL DEFAULT 8 CHECK (retrieval_limit BETWEEN 1 AND 30),
  auto_retrieve boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (chunk_overlap_tokens < chunk_tokens)
);
INSERT INTO vault_settings (workspace_id) SELECT id FROM workspaces ON CONFLICT DO NOTHING;

CREATE TABLE vault_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);
CREATE UNIQUE INDEX vault_collections_default_uq
  ON vault_collections(workspace_id) WHERE is_default;

INSERT INTO vault_collections (workspace_id, slug, name, description, is_default)
SELECT id, 'kho-dung-chung', 'Kho dùng chung', 'Collection mặc định, dùng tương thích cho tài liệu Vault hiện có.', true
FROM workspaces
ON CONFLICT (workspace_id, slug) DO NOTHING;

ALTER TABLE vault_documents ADD COLUMN collection_id uuid REFERENCES vault_collections(id) ON DELETE RESTRICT;
ALTER TABLE vault_documents ADD COLUMN content_hash text NOT NULL DEFAULT '';
ALTER TABLE vault_documents ADD COLUMN index_status text NOT NULL DEFAULT 'pending'
  CHECK (index_status IN ('pending', 'indexing', 'ready', 'error'));
ALTER TABLE vault_documents ADD COLUMN index_error text;
ALTER TABLE vault_documents ADD COLUMN token_count integer NOT NULL DEFAULT 0;
ALTER TABLE vault_documents ADD COLUMN chunk_count integer NOT NULL DEFAULT 0;
ALTER TABLE vault_documents ADD COLUMN index_version integer NOT NULL DEFAULT 1;

UPDATE vault_documents d
SET collection_id = c.id,
    content_hash = md5(d.content),
    token_count = greatest(1, ceil(length(d.content)::numeric / 4)::integer)
FROM vault_collections c
WHERE c.workspace_id = d.workspace_id AND c.is_default AND d.collection_id IS NULL;
ALTER TABLE vault_documents ALTER COLUMN collection_id SET NOT NULL;
CREATE INDEX vault_documents_collection_idx ON vault_documents(collection_id, updated_at DESC);

CREATE TABLE vault_collection_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  collection_id uuid NOT NULL REFERENCES vault_collections(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  audience_type text NOT NULL CHECK (audience_type IN ('all', 'principal', 'conversation', 'role')),
  principal_id uuid REFERENCES principals(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  role text CHECK (role IN ('ws_admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (audience_type = 'all' AND principal_id IS NULL AND conversation_id IS NULL AND role IS NULL) OR
    (audience_type = 'principal' AND principal_id IS NOT NULL AND conversation_id IS NULL AND role IS NULL) OR
    (audience_type = 'conversation' AND principal_id IS NULL AND conversation_id IS NOT NULL AND role IS NULL) OR
    (audience_type = 'role' AND principal_id IS NULL AND conversation_id IS NULL AND role IS NOT NULL)
  )
);
CREATE UNIQUE INDEX vault_collection_grants_uq
  ON vault_collection_grants(collection_id, agent_id, audience_type, principal_id, conversation_id, role)
  NULLS NOT DISTINCT;
CREATE INDEX vault_collection_grants_lookup_idx
  ON vault_collection_grants(workspace_id, collection_id, agent_id, audience_type);

-- Mặc định tương thích: mọi agent × mọi người đã được phép gọi agent.
INSERT INTO vault_collection_grants (workspace_id, collection_id, audience_type)
SELECT workspace_id, id, 'all' FROM vault_collections WHERE is_default
ON CONFLICT DO NOTHING;

CREATE TABLE vault_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  collection_id uuid NOT NULL REFERENCES vault_collections(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  heading_path text NOT NULL DEFAULT '',
  content text NOT NULL,
  search_text text NOT NULL,
  token_count integer NOT NULL,
  embedding vector(768),
  embedding_model text,
  index_version integer NOT NULL DEFAULT 1,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, ordinal)
);
CREATE INDEX vault_chunks_workspace_doc_idx ON vault_chunks(workspace_id, document_id, ordinal);
CREATE INDEX vault_chunks_tsv_idx ON vault_chunks USING gin(tsv);
CREATE INDEX vault_chunks_embedding_hnsw_idx ON vault_chunks
  USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE vault_ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  document_id uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'error')),
  provider_name text,
  embedding_model text,
  chunk_tokens integer NOT NULL,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_ingestion_jobs_doc_idx ON vault_ingestion_jobs(document_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'principals', 'conversations', 'vault_settings', 'vault_collections',
    'vault_collection_grants', 'vault_chunks', 'vault_ingestion_jobs'
  ] LOOP
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

