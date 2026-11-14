-- 0040: Inbox — phân công hội thoại cho từng nhân viên (tùy chọn, mặc định KHÔNG giới hạn).
--
-- Chỉ THÊM: một cột có giá trị mặc định + một bảng mới. Dữ liệu cũ giữ nguyên, bản cũ vẫn chạy
-- (bản cũ ghi inbox_channel_members không có cột scope → nhận mặc định 'all' = thấy mọi hội thoại như trước).

-- Phạm vi của nhân viên (member) trên một kênh:
--   all      = thấy mọi hội thoại của kênh (như trước nay)
--   assigned = chỉ thấy và trả lời các hội thoại được giao (bảng inbox_thread_members)
ALTER TABLE inbox_channel_members
  ADD COLUMN scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'assigned'));

-- Hội thoại nào giao cho nhân viên nào (một hội thoại giao được cho nhiều người).
CREATE TABLE inbox_thread_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid,                          -- NULL = hệ thống tự chia (xoay vòng)
  auto boolean NOT NULL DEFAULT false,       -- true = do chia tự động xoay vòng
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, thread_id, user_id)
);
CREATE INDEX inbox_thread_members_user_idx ON inbox_thread_members(channel_id, user_id);

ALTER TABLE inbox_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_thread_members FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON inbox_thread_members
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_thread_members TO penai_app;
