-- 0029: Hồ sơ contact, nhãn và chỉ dẫn cho AI theo từng người (26/09/2026).
--
-- Hồ sơ gắn PRINCIPAL (danh tính gốc của một người) chứ không gắn contact (danh
-- tính trên một kênh) → khi gộp nhiều kênh của một người về một principal thì
-- dùng chung hồ sơ. Chỉ THÊM bảng, không sửa bảng cũ (luật phát hành).
--
-- Mức tin cậy khi đưa vào ngữ cảnh AI:
--   ai_instructions (người) + contact_tags.ai_instructions (nhãn) = CHỈ THỊ của
--   quản trị viên — chỉ ws_admin/operator sửa, AI không có tool nào ghi vào đây.
--   Các trường còn lại = DỮ LIỆU mô tả người đang chat.

CREATE TABLE principal_profiles (
  principal_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  display_name text,                                   -- tên admin đặt (NULL = tên từ kênh)
  address_as text,                                     -- AI gọi người này là gì ("anh Đức")
  self_address text,                                   -- AI xưng là gì ("em")
  role_title text,                                     -- vai trò / chức danh / công ty
  language text,                                       -- ngôn ngữ trả lời ưu tiên
  phone text,
  email text,
  share_contact_info boolean NOT NULL DEFAULT false,   -- cho AI biết SĐT/email
  custom_fields jsonb NOT NULL DEFAULT '{}',           -- {"Tên trường": "giá trị"}, AI thấy
  ai_instructions text NOT NULL DEFAULT '',            -- chỉ dẫn của quản trị viên
  use_in_groups boolean NOT NULL DEFAULT false,        -- đưa đủ hồ sơ + chỉ dẫn cả trong nhóm chat
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX principal_profiles_workspace_idx ON principal_profiles(workspace_id);

CREATE TABLE contact_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  color text NOT NULL DEFAULT '',
  ai_instructions text NOT NULL DEFAULT '',            -- chỉ dẫn chung cho mọi người mang nhãn
  use_in_groups boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contact_tags_name_uq ON contact_tags(workspace_id, lower(name));

CREATE TABLE principal_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES contact_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, tag_id)
);
CREATE INDEX principal_tags_tag_idx ON principal_tags(tag_id);

-- RLS fail-closed theo workspace như mọi bảng khác
ALTER TABLE principal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON principal_profiles
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON contact_tags
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE principal_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON principal_tags
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON principal_profiles, contact_tags, principal_tags TO penai_app;
