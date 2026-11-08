-- 0039: loại provider "hoiai" (cổng AI chat.hoiai.vn — một khóa cho chat, embedding, tạo ảnh).
--
-- Chỉ NỚI ràng buộc kind (thêm 'hoiai'). Bản cũ đọc được dòng 'hoiai' nhưng coi như
-- OpenAI-compatible với base URL đã lưu — vẫn chat được, chỉ thiếu phần riêng của HoiAI.

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_kind_check;
ALTER TABLE llm_providers
  ADD CONSTRAINT llm_providers_kind_check
  CHECK (kind IN ('openai', 'gemini', 'qwen', 'openai-compat', 'anthropic', 'hoiai'));
