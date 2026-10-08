-- 0034: Inbox dùng chung cho nhiều loại kênh (Zalo cá nhân, WhatsApp cá nhân, sau này Zalo OA…).
--
-- Các bảng Inbox vốn mang tên zalo_* nhưng cột đã trung tính theo kênh → đổi tên thành inbox_*.
-- Dữ liệu KHÔNG di chuyển, không sao chép: chỉ đổi tên bảng.
--
-- Bản cũ (≤ 1.8.x) vẫn đọc/ghi bằng tên zalo_* trong lúc cập nhật và khi quay về bản trước
-- (`penai rollback`) → để lại KHUNG NHÌN (view) mang tên cũ trỏ vào bảng mới. View tự cập nhật được
-- (INSERT/UPDATE/DELETE/ON CONFLICT đi thẳng xuống bảng thật). View chạy bằng quyền chủ database
-- nên tự lọc theo workspace đúng như chính sách RLS của bảng gốc (điều kiện WHERE + CHECK OPTION).
-- Các view này sẽ được gỡ ở một bản LỚN về sau.

ALTER TABLE zalo_threads RENAME TO inbox_threads;
ALTER TABLE zalo_messages RENAME TO inbox_messages;
ALTER TABLE zalo_reactions RENAME TO inbox_reactions;
ALTER TABLE zalo_channel_members RENAME TO inbox_channel_members;
ALTER TABLE zalo_observed_peers RENAME TO inbox_observed_peers;
ALTER SEQUENCE IF EXISTS zalo_messages_id_seq RENAME TO inbox_messages_id_seq;

-- Ràng buộc + chỉ mục: zalo_* → inbox_* (đổi tên ràng buộc khóa chính/duy nhất kéo theo chỉ mục của nó)
DO $$
DECLARE
  r record;
  tbls regclass[] := ARRAY['inbox_threads', 'inbox_messages', 'inbox_reactions', 'inbox_channel_members', 'inbox_observed_peers']::regclass[];
BEGIN
  FOR r IN SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
           WHERE conrelid = ANY (tbls) AND conname LIKE 'zalo\_%' LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, 'inbox_' || substr(r.conname, 6));
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE i.indrelid = ANY (tbls) AND c.relname LIKE 'zalo\_%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, 'inbox_' || substr(r.relname, 6));
  END LOOP;
END $$;

-- Tin đến từ người ngoài: giá trị mặc định cũ là 'zalo' — nay dùng chung là 'peer'.
-- (Dữ liệu cũ giữ 'zalo'; mã mới coi 'zalo' và 'peer' như nhau.)
ALTER TABLE inbox_messages ALTER COLUMN source SET DEFAULT 'peer';
ALTER TABLE inbox_reactions ALTER COLUMN source SET DEFAULT 'peer';

-- View tương thích cho bản cũ
DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['zalo_threads', 'inbox_threads'],
    ['zalo_messages', 'inbox_messages'],
    ['zalo_reactions', 'inbox_reactions'],
    ['zalo_channel_members', 'inbox_channel_members'],
    ['zalo_observed_peers', 'inbox_observed_peers']
  ] LOOP
    EXECUTE format(
      'CREATE VIEW %I AS SELECT * FROM %I
         WHERE workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid
         WITH CASCADED CHECK OPTION',
      pair[1], pair[2]);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO penai_app', pair[1]);
  END LOOP;
END $$;
