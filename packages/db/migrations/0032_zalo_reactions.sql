-- 0032: Cảm xúc (reaction) trên tin nhắn Zalo cá nhân — hiện trong Inbox.
-- Mỗi người chỉ có 1 cảm xúc trên 1 tin (thả lại = đổi, gỡ = xóa dòng). Chỉ THÊM bảng mới.

CREATE TABLE zalo_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  msg_id text NOT NULL,                 -- tin được thả cảm xúc (zalo_messages.msg_id)
  reactor_id text NOT NULL,             -- uid người thả (chủ tài khoản = uid tài khoản đang kết nối)
  reactor_name text NOT NULL DEFAULT '',
  icon text NOT NULL,                   -- mã icon Zalo: "/-heart", "/-strong"…
  -- zalo = khách/thành viên nhóm · app = chủ tài khoản trên điện thoại
  -- web = nhân viên thả trong Inbox · auto = tự thả khi khách nhắn · mcp = ứng dụng AI bên ngoài
  source text NOT NULL DEFAULT 'zalo',
  web_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, msg_id, reactor_id)
);
CREATE INDEX zalo_reactions_thread_idx ON zalo_reactions(channel_id, thread_id);

ALTER TABLE zalo_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON zalo_reactions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON zalo_reactions TO penai_app;
