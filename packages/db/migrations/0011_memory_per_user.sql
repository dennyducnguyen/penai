-- 0011: Memory theo từng người dùng kênh + siêu dữ liệu vòng đời
--
-- Trước đây memory chỉ gắn agent_id → mọi người dùng chat cùng 1 bot Telegram
-- dùng CHUNG bộ nhớ (người này hỏi lại thì thấy thông tin người kia).
-- user_key NULL = ghi nhớ dùng chung cho cả agent (do admin đặt / kiến thức chung).

ALTER TABLE memories ADD COLUMN user_key text;
ALTER TABLE memories ADD COLUMN pinned boolean NOT NULL DEFAULT false;
ALTER TABLE memories ADD COLUMN access_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_accessed timestamptz;
-- khóa chống trùng lặp nội dung (hash) — dùng cho dedup khi tự động ghi nhớ
ALTER TABLE memories ADD COLUMN content_hash text;

CREATE INDEX memories_user_idx ON memories(agent_id, user_key);
CREATE UNIQUE INDEX memories_dedup_uq
  ON memories(workspace_id, agent_id, coalesce(user_key, ''), content_hash)
  WHERE content_hash IS NOT NULL;
