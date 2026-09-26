# Zalo Personal trong PenAI

PenAI hỗ trợ kênh `zalo_personal` bằng `zca-js` 2.1.x để một tài khoản Zalo cá nhân làm đầu vào/đầu ra cho agent.

> Đây là API không chính thức, mô phỏng Zalo Web. Zalo có thể giới hạn hoặc khóa tài khoản; nên dùng tài khoản riêng cho bot. Mỗi tài khoản chỉ nên có một listener web, vì mở Zalo Web cùng lúc có thể làm listener PenAI bị ngắt.

## Chế độ an toàn (luôn bật)

Kênh `zalo_personal` được thiết kế để có thể đăng nhập bằng **tài khoản Zalo cá nhân đang dùng thật** mà không ảnh hưởng người đang chat với tài khoản đó:

- Sau khi quét QR, bot **chỉ quan sát**: ghi nhận ai/nhóm nào nhắn tới (tên, thread id, người gửi, số tin — **không lưu nội dung tin**), không chạy agent, không trả lời, không tự gửi bất kỳ tin nào.
- Chỉ những thread được admin **chỉ định làm thread demo** (`config.demo_threads`, dạng `group:<id>` / `direct:<id>`) mới được nhận tin vào agent và gửi tin ra. Mọi outbound — kể cả test message của admin — ngoài allowlist đều bị chặn (fail-closed).
- Danh sách chờ duyệt xem tại Channels → Kết nối QR → mục **Danh sách chờ duyệt**: ai/nhóm nhắn tới tự hiện tên Zalo + uid, nhóm được gắn nhãn «nhóm»; bấm «Chỉ định demo» trên thread muốn duyệt. Cập nhật áp dụng nóng, không cần đăng nhập lại. Từ 26/08/2026 danh sách lưu bền trong DB (bảng `zalo_observed_peers`, migration 0017) — không mất khi restart server.
- Trong nhóm (demo), bot **mặc định chỉ trả lời khi được `@mention`, reply tin của bot, hoặc lệnh `/...`** (đổi mặc định 31/08/2026). Muốn bot trả lời MỌI tin trong nhóm demo (hội thoại tự nhiên) thì đặt rõ `config.require_mention = false`. Orchestrator/interceptor vẫn thấy mọi tin bất kể cấu hình này.
- **Ngoại lệ openDirect (31/08/2026)**: nếu channel **tắt "yêu cầu pairing"** (`requirePairing = false`), mọi tin nhắn **RIÊNG (DM)** được nhận/trả lời liền — không cần chỉ định demo, không cần duyệt. **Nhóm vẫn phải chỉ định demo** (không mở nhóm tự do để bot không tự trả lời trong mọi nhóm tài khoản tham gia). Outbound tới DM bất kỳ cũng được phép ở chế độ này. Toggle checkbox pairing trong Channels sẽ rebuild channel và áp dụng ngay. ⚠️ Chỉ tắt pairing khi tài khoản đăng nhập là tài khoản DÀNH RIÊNG cho bot — tài khoản cá nhân thật mà mở DM là bot trả lời cả bạn bè/người thân nhắn tới.

## Khả năng đã hỗ trợ

- Đăng nhập QR ngay trong Dashboard → Channels; credential được mã hóa bằng `PENAI_MASTER_KEY` và tự khôi phục sau restart.
- Tin nhắn riêng và group trong thread demo; group mặc định cần `@mention`/reply/lệnh `/...` — tắt bằng `require_mention: false`.
- Pairing tùy chọn theo channel và mặc định bật. Khi bật, chỉ sau khi admin duyệt mã tại Channels → Yêu cầu chờ duyệt thì agent mới trả lời; admin có thể bỏ chọn **Yêu cầu pairing** khi muốn mở kênh.
- Typing indicator, chia câu trả lời dài tối đa 2.000 ký tự, gửi file/ảnh agent tạo ra.
- Nhận text và tải ảnh/tệp từ các CDN Zalo tin cậy, tối đa 10 MB. Voice/video/sticker chỉ được ghi chú cho agent nếu không thể xử lý như Telegram.
  - **08/09/2026**: CDN tin cậy gồm `*.zalo.me`, `*.zaloapp.com`, `*.zadn.vn`, `*.zdn.vn` (file/ảnh chat thật nằm ở `f18-zpg.zdn.vn`, `f47-photo.talk.zdn.vn` — trước đây thiếu `zdn.vn` nên file gửi lên chỉ thành ghi chú "nội dung Zalo loại " rỗng, agent báo không có file). Loại media lấy từ `msgType` của tin (`chat.file`, `chat.photo`, `chat.voice`, `chat.video.msg`, `chat.sticker`), đuôi/kích thước lấy từ `params` (`fileExt`, `fileSize`). `chat.file` luôn lưu thành document giữ nguyên tên. Log chẩn đoán: `zalo.media:` (tải OK), `zalo.media_skip:` (host không tin cậy — kèm hostname để bổ sung allowlist), `zalo.media_fail:` (tải lỗi).
  - Luồng nhận file (runtime chung mọi kênh): người dùng chỉ gửi file, không caption → lưu vào `users/<kind>-<senderId>/` (tên slug hóa, trùng → hậu tố -2), ghi `[Đã gửi N file: ...]` vào hội thoại, trả lời "📎 Đã lưu: ..." và **không chạy LLM** — đợi lệnh ở lượt sau; gửi kèm caption → lưu rồi chạy agent ngay với `[Người dùng gửi file, đã lưu tại: ...]`.
- Đổi agent, bật/tắt channel và ngắt/kết nối lại Zalo áp dụng ngay.

## Cách thiết lập

1. Vào `https://ai.example.com/#/channels`, bấm **＋ Thêm kênh**.
2. Chọn `zalo_personal`, đặt tên, chọn agent; giữ hoặc bỏ chọn **Yêu cầu pairing** tùy nhu cầu.
3. Sau khi tạo, bấm **Kết nối QR** → **Tạo mã QR**.
4. Mở Zalo trên điện thoại, quét QR và xác nhận đăng nhập.
5. Sau đăng nhập, bot ở chế độ **chỉ quan sát**. Nhắn 1 tin bất kỳ vào nhóm cần demo (bằng chính tài khoản bot cũng được — tin trong group của chính chủ vẫn được ghi nhận), bấm **Làm mới** ở mục Đã quan sát rồi bấm **Chỉ định demo** cho nhóm đó — từ lúc này bot mới nhận/gửi tin trong đúng nhóm được chỉ định.
6. Nếu pairing đang bật, người gửi trong thread demo chưa duyệt sẽ KHÔNG nhận được gì (ngoại lệ riêng zalo_personal từ 26/08/2026 — bot im lặng, không gửi mã pair như các kênh khác); mã vẫn được cấp ngầm trong DB và admin duyệt trong mục **Yêu cầu chờ duyệt**. Với nhóm demo nội bộ nên tắt pairing để hội thoại liền mạch.

## API quản trị

- `GET /v1/channels/:id/zalo-personal/status`
- `POST /v1/channels/:id/zalo-personal/login`
- `GET /v1/channels/:id/zalo-personal/login/:loginId`
- `POST /v1/channels/:id/zalo-personal/logout`
- `GET /v1/channels/:id/zalo-personal/targets` — danh sách bạn bè/nhóm cho admin kiểm tra.
- `POST /v1/channels/:id/zalo-personal/test-message` — gửi tin kiểm tra có chủ đích (chỉ vào thread demo).
- `GET /v1/channels/:id/zalo-personal/observed` — ai/nhóm nào đã nhắn tới + allowlist hiện tại.
- `PUT /v1/channels/:id/zalo-personal/demo-threads` — cập nhật allowlist thread demo (áp dụng nóng).

Các endpoint yêu cầu API key có role `ws_admin`. QR và credential không được ghi log hoặc trả trong API danh sách channel.

Tham khảo: [zca-js trên npm](https://www.npmjs.com/package/zca-js), [source zca-js](https://github.com/RFS-ADRENO/zca-js), và implementation đang hoạt động tại `D:\laragon\www\zalochat`.
