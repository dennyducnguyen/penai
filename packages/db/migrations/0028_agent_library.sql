-- 0028: Thư viện file của agent (26/09/2026).
-- File thư viện nằm trên đĩa (<dataDir>/thu-vien/<workspace>/<agent>/), DB chỉ giữ
-- quyền ghi của agent vào thư viện của chính nó. Mặc định CHỈ ĐỌC.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS library_writable boolean NOT NULL DEFAULT false;
