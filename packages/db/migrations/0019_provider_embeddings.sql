-- 0019: first-class API-key providers + cấu hình embedding dùng chung credential.

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_kind_check;

-- Chuẩn hóa hai kind cũ nhưng vẫn giữ openai-compat/anthropic để tương thích.
UPDATE llm_providers SET kind = 'openai'
WHERE kind = 'openai-compat' AND base_url IS NULL;
UPDATE llm_providers SET kind = 'qwen' WHERE kind = 'dashscope';

ALTER TABLE llm_providers
  ADD CONSTRAINT llm_providers_kind_check
  CHECK (kind IN ('openai', 'gemini', 'qwen', 'openai-compat', 'anthropic')),
  ADD COLUMN default_embedding_model text,
  ADD COLUMN embedding_dimensions integer,
  ADD COLUMN is_default_embedding boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX llm_providers_default_embedding_uq
  ON llm_providers(workspace_id) WHERE is_default_embedding = true;

DROP FUNCTION IF EXISTS list_enabled_llm_providers();
CREATE FUNCTION list_enabled_llm_providers()
RETURNS TABLE (
  id uuid, workspace_id uuid, name text, kind text,
  base_url text, api_key_encrypted text, default_model text,
  default_embedding_model text, embedding_dimensions integer,
  is_default_embedding boolean
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, workspace_id, name, kind, base_url, api_key_encrypted, default_model,
         default_embedding_model, embedding_dimensions, is_default_embedding
  FROM llm_providers WHERE enabled = true
$$;
REVOKE ALL ON FUNCTION list_enabled_llm_providers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_enabled_llm_providers() TO penai_app;
