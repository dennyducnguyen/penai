-- 0033: Hồ sơ trình duyệt cho tool `browser` của agent (Dashboard → Trình duyệt).
--
-- Mỗi hồ sơ = một bộ cookie (đăng nhập sẵn các trang như Shopee) + User-Agent,
-- ngôn ngữ, múi giờ. Cookie là thông tin đăng nhập nên lưu MÃ HÓA
-- (AES-256-GCM bằng PENAI_MASTER_KEY) — Dashboard chỉ hiện tên/tên miền/hạn,
-- agent chỉ dùng chứ không đọc được giá trị.
-- Chỉ THÊM bảng + cột cho phép NULL (bản cũ đang chạy trong lúc migration không bị ảnh hưởng).

CREATE TABLE browser_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',          -- trống = User-Agent Chrome mặc định của hệ thống
  locale text NOT NULL DEFAULT 'vi-VN',
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  cookies_encrypted text,                        -- JSON danh sách cookie (định dạng Playwright), đã mã hóa
  cookie_count integer NOT NULL DEFAULT 0,
  cookies_updated_at timestamptz,
  auto_save boolean NOT NULL DEFAULT true,       -- đóng phiên thì lưu lại cookie mới (trang web hay đổi cookie)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

ALTER TABLE browser_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON browser_profiles
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON browser_profiles TO penai_app;

-- Hồ sơ trình duyệt agent dùng. NULL = trình duyệt trống (không cookie).
ALTER TABLE agents ADD COLUMN browser_profile_id uuid REFERENCES browser_profiles(id) ON DELETE SET NULL;
