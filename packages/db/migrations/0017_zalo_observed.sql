-- 0017: Danh sách quan sát Zalo Personal bền vững qua restart.
-- Ai/nhóm nhắn tới tài khoản được ghi vào DB (chỉ metadata: tên, id, số tin,
-- KHÔNG lưu nội dung) để admin xem danh sách chờ duyệt và chỉ định demo,
-- kể cả sau khi server khởi động lại.

CREATE TABLE zalo_observed_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  chat_key text NOT NULL,           -- "group:<id>" | "direct:<id>"
  thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  name text NOT NULL,               -- tên hiển thị (người hoặc tên nhóm)
  last_sender_id text NOT NULL,
  last_sender_name text NOT NULL,
  message_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zalo_observed_uq ON zalo_observed_peers(channel_id, chat_key);
CREATE INDEX zalo_observed_seen_idx ON zalo_observed_peers(channel_id, last_seen_at DESC);

-- RLS fail-closed + GRANT theo đúng pattern 0002
ALTER TABLE zalo_observed_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_observed_peers FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON zalo_observed_peers
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON zalo_observed_peers TO penai_app;
