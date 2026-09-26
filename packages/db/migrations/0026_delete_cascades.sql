-- 0026: Xóa agent / xóa kênh trong Dashboard bị 500 vì FK (phát hiện 15/09/2026).
--
-- Kênh: contacts.channel_id có ON DELETE SET NULL, nhưng contacts_legacy_uq (partial, WHERE channel_id IS NULL)
-- đã có sẵn dòng legacy cùng (workspace, kind, external_id) → set NULL trùng khóa → xóa kênh thất bại.
-- Contact gắn kênh là danh tính người dùng TRONG kênh đó, kênh mất thì contact theo → CASCADE
-- (principal của người đó vẫn còn; dòng legacy không đụng).
ALTER TABLE contacts DROP CONSTRAINT contacts_channel_id_fkey;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

-- Agent: các bảng dữ liệu THUỘC agent (ghi nhớ, phiên chat, cron, webhook) chưa khai ON DELETE
-- → mặc định RESTRICT → không xóa được agent nào từng chat. Dữ liệu này vô nghĩa khi agent mất → CASCADE.
-- traces giữ lại để thống kê (agent_id/session_id về NULL); team_tasks.claimed_by về NULL.
-- channels.agent_id CỐ Ý giữ RESTRICT: kênh phải có agent trả lời — route trả 409 kèm tên kênh.
ALTER TABLE memories DROP CONSTRAINT memories_agent_id_fkey;
ALTER TABLE memories
  ADD CONSTRAINT memories_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE memories DROP CONSTRAINT memories_source_session_id_fkey;
ALTER TABLE memories
  ADD CONSTRAINT memories_source_session_id_fkey
  FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE memory_documents DROP CONSTRAINT memory_documents_agent_id_fkey;
ALTER TABLE memory_documents
  ADD CONSTRAINT memory_documents_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE sessions DROP CONSTRAINT sessions_agent_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE messages DROP CONSTRAINT messages_session_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE channel_sessions DROP CONSTRAINT channel_sessions_session_id_fkey;
ALTER TABLE channel_sessions
  ADD CONSTRAINT channel_sessions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE traces DROP CONSTRAINT traces_agent_id_fkey;
ALTER TABLE traces
  ADD CONSTRAINT traces_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE traces DROP CONSTRAINT traces_session_id_fkey;
ALTER TABLE traces
  ADD CONSTRAINT traces_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE cron_jobs DROP CONSTRAINT cron_jobs_agent_id_fkey;
ALTER TABLE cron_jobs
  ADD CONSTRAINT cron_jobs_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE agent_webhooks DROP CONSTRAINT agent_webhooks_agent_id_fkey;
ALTER TABLE agent_webhooks
  ADD CONSTRAINT agent_webhooks_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE team_tasks DROP CONSTRAINT team_tasks_claimed_by_fkey;
ALTER TABLE team_tasks
  ADD CONSTRAINT team_tasks_claimed_by_fkey
  FOREIGN KEY (claimed_by) REFERENCES agents(id) ON DELETE SET NULL;
