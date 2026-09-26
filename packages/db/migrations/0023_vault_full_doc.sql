-- 0023: Vault document-first — "tìm trúng tài liệu thì đưa toàn văn cho AI"
--       + upload file văn phòng (lưu tên file gốc).
--
-- retrieval_mode theo TỪNG Collection (khớp mô hình quản trị collection-first):
--   'auto'        = tìm hybrid; tài liệu nổi bật nhất được nạp TOÀN VĂN nếu vừa ngân sách
--   'always_full' = mọi tài liệu ready trong collection nạp vào MỌI lượt chat
--                   (vẫn qua ACL grant — chỉ agent/người được cấp mới thấy)
--   'search_only' = chỉ trả chunk, không bao giờ nạp toàn văn (kho tham khảo lớn)

ALTER TABLE vault_collections ADD COLUMN retrieval_mode text NOT NULL DEFAULT 'auto'
  CHECK (retrieval_mode IN ('auto', 'always_full', 'search_only'));

-- Ngưỡng token tối đa để MỘT tài liệu được nạp nguyên văn (chế độ auto)
ALTER TABLE vault_settings ADD COLUMN full_doc_tokens integer NOT NULL DEFAULT 16000;

-- Ngân sách context cũ (6.000) quá nhỏ cho triết lý full-doc — nâng mặc định
-- và nâng luôn các workspace còn để giá trị mặc định cũ (giá trị tùy chỉnh giữ nguyên).
ALTER TABLE vault_settings ALTER COLUMN context_tokens SET DEFAULT 24000;
UPDATE vault_settings SET context_tokens = 24000 WHERE context_tokens = 6000;

-- Tên file gốc khi tài liệu được upload (hiển thị trong dashboard)
ALTER TABLE vault_documents ADD COLUMN source_file text;

-- Trạng thái job mới 'stale': job hoàn thành SAU khi nội dung đã bị lượt lưu
-- mới hơn thay đổi — kết quả bị bỏ, không ghi đè index (chống race).
ALTER TABLE vault_ingestion_jobs DROP CONSTRAINT vault_ingestion_jobs_status_check;
ALTER TABLE vault_ingestion_jobs ADD CONSTRAINT vault_ingestion_jobs_status_check
  CHECK (status IN ('pending', 'running', 'complete', 'error', 'stale'));
