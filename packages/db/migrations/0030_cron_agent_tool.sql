-- 0030: Agent tự đặt lịch khi chat (tool cron_create / cron_list / cron_update / cron_delete)
--
-- Chỉ THÊM cột (bản cũ đang chạy trong lúc migration vẫn đọc/ghi bình thường):
--   timezone    múi giờ IANA của lịch ("at 2026-09-28 08:00", cron "0 8 * * *").
--               NULL = job tạo trước 1.2.0 → giữ cách hiểu cũ theo giờ máy chủ.
--   created_via 'dashboard' (quản trị viên tạo) | 'agent' (agent tạo khi chat).
--   owner_key   người nhờ agent đặt lịch: "<kênh>-<id người gửi>" hoặc "web-<user id>".
--               Lượt chạy dùng đúng thư mục + quyền của người này.
--   origin      nơi tạo lịch / nơi gửi kết quả (kênh, cuộc trò chuyện, người tạo...).

ALTER TABLE cron_jobs ADD COLUMN timezone text;
ALTER TABLE cron_jobs ADD COLUMN created_via text NOT NULL DEFAULT 'dashboard'
  CHECK (created_via IN ('dashboard', 'agent'));
ALTER TABLE cron_jobs ADD COLUMN owner_key text;
ALTER TABLE cron_jobs ADD COLUMN origin jsonb;

CREATE INDEX cron_jobs_agent_owner_idx ON cron_jobs(agent_id, owner_key);
