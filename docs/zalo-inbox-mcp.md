# Inbox Zalo cá nhân + Kết nối AI bên ngoài (MCP)

Có từ PenAI **1.3.0**. Hai tính năng dùng chung một kênh `zalo_personal` (Zalo cá nhân đăng nhập bằng QR — xem [zalo-personal.md](zalo-personal.md)):

1. **Inbox Zalo** — nhiều người dùng PenAI cùng xem hội thoại Zalo và trả lời khách ngay trong Dashboard.
2. **PenAI MCP server** — cho Claude, ChatGPT, Cursor… (và chính PenAI) gửi tin nhắn + ảnh Zalo, tra danh bạ, tìm người theo số điện thoại. MCP (Model Context Protocol) là chuẩn để ứng dụng AI gọi công cụ bên ngoài.

> Zalo cá nhân dùng API không chính thức (zca-js). Zalo có thể giới hạn/khóa tài khoản gửi quá nhiều — không dùng để gửi tin hàng loạt cho người lạ.

## 1. Inbox Zalo

**Mở:** Dashboard → **📥 Inbox Zalo** (hiện khi workspace có kênh Zalo cá nhân).

- Cột trái: hội thoại (cá nhân 👤 / nhóm 👥), số tin chưa đọc, tìm theo tên / uid / SĐT (tìm cả danh bạ chưa từng chat). Lọc Cá nhân / Nhóm / Chưa đọc.
- Cột phải: tin nhắn realtime (không cần tải lại trang). Nhãn nguồn tin gửi đi: 🤖 AI · 👤 tên nhân viên · 📱 gửi từ điện thoại · 🔌 ứng dụng AI qua MCP.
- Gửi text, **gửi ảnh** (nút 🖼️ hoặc dán ảnh thẳng vào ô nhập), Enter để gửi, Shift+Enter xuống dòng.
- **＋ Nhắn tin mới**: gửi cho số điện thoại (tự tra Zalo), uid cá nhân hoặc ID nhóm.
- **🔄 Đồng bộ danh bạ** (Vận hành trở lên): kéo bạn bè + nhóm về. Tự chạy mỗi lần kết nối QR / khởi động lại.
- **⚙️ Cài đặt** (Quản trị): bật/tắt lưu nội dung, số phút AI tạm im sau khi nhân viên trả lời.

**Lưu gì:** mặc định **lưu mọi tin nhắn** đến/đi của tài khoản Zalo đã kết nối (kể cả tin riêng tư) vào database, kể từ lúc kết nối — Zalo không cho lấy lịch sử cũ. Ảnh/file khách gửi chỉ lưu đường link CDN của Zalo; ảnh gửi đi lưu trong `/var/lib/<bản-cài>/data/<workspace>/zalo-inbox/`. Tắt lưu: Inbox → ⚙️ Cài đặt → bỏ tick.

**Tắt hẳn agent trên kênh (từ 1.5.0):** Channels → Sửa kênh → bỏ tick **"Agent tự trả lời"** (ô trên cùng, mặc định có tick). Kênh vẫn kết nối, Inbox vẫn lưu và hiện tin, nhân viên vẫn chat tay, MCP vẫn chạy — chỉ AI không trả lời. Lịch hẹn agent đã đặt vẫn gửi bình thường. Áp dụng cho mọi loại kênh (Telegram, Teams…).

**Cảm xúc (reaction, từ 1.5.0):**

- **Thả tay trong Inbox**: rê chuột vào tin của khách → thanh ❤️ 👍 😆 😮 😢 😡; bấm lại icon đang chọn để gỡ. Cảm xúc của cả hai phía (khách thả vào tin của mình, mình thả vào tin của khách) hiện dưới bong bóng, cập nhật tức thì.
- **Tự thả khi khách nhắn**: Inbox → ⚙️ Cài đặt → "Tự thả cảm xúc khi khách nhắn" = Tắt (mặc định) / ❤️ / 👍. Áp dụng cả tin riêng và nhóm, thả vào tin cuối của mỗi đợt nhắn sau 1–4 giây, cả kênh tối đa ~1 lần/giây. Chạy độc lập với "Agent tự trả lời". Nhóm đông người nhắn nhiều → tài khoản thả rất nhiều, Zalo có thể giới hạn tài khoản.
- Chỉ thả được vào tin lưu từ bản 1.5.0 trở đi (cần thêm mã tin mà bản cũ chưa lưu).

**AI và nhân viên cùng trực:**

- AI chỉ tự trả lời ở những hội thoại kênh cho phép (thread được "Chỉ định demo", hoặc mọi tin riêng nếu kênh tắt "Yêu cầu pairing") — y như trước.
- Nhân viên trả lời (từ Inbox **hoặc** từ app Zalo trên điện thoại) → AI **tự im 30 phút** trong hội thoại đó để không chen ngang. Đổi số phút ở ⚙️ Cài đặt (0 = không tạm dừng). Bấm **Cho AI trả lời lại** để bỏ tạm dừng ngay.
- Ô **AI trả lời** trên đầu hội thoại: "Tắt cho hội thoại này" → AI không bao giờ trả lời người/nhóm này.

**Ai được vào:**

| Vai trò | Inbox |
|---|---|
| Quản trị, Vận hành | Mọi kênh Zalo của workspace |
| Thành viên | Chỉ kênh được gán: Người dùng → Sửa → tick **Kênh Zalo được trực** |
| Chỉ xem | Không |

## 2. PenAI MCP server

**Địa chỉ:** `https://<tên-miền-PenAI>/mcp` — xem ở Dashboard → **🔗 Kết nối AI bên ngoài** (có nút sao chép).

### Kết nối

- **Claude** (claude.ai hoặc Claude Desktop): Settings → Connectors → *Add custom connector* → dán địa chỉ → Connect.
- **ChatGPT**: Settings → Apps & Connectors → Advanced → bật *Developer mode* → Create → dán địa chỉ, xác thực OAuth.
- **Chính PenAI** (để agent trong PenAI gửi Zalo): Dashboard → MCP → Thêm → transport `http`, URL là địa chỉ trên → bấm Đăng nhập OAuth.
- Công cụ khác hỗ trợ MCP từ xa + OAuth (Cursor, Claude Code…): thêm địa chỉ trên; callback `http://localhost:<cổng>` của ứng dụng máy tính được chấp nhận.

Trình duyệt mở **trang cấp quyền của PenAI**: đăng nhập bằng email + mật khẩu Dashboard (đang đăng nhập Dashboard sẵn thì chỉ cần bấm), tick quyền rồi **Cấp quyền**. Mật khẩu không chuyển cho ứng dụng AI.

| Quyền | Cho phép |
|---|---|
| `zalo:read` | Xem danh sách người liên hệ, nhóm; tra người theo SĐT |
| `zalo:send` | Gửi tin nhắn + ảnh |
| `zalo:messages` | Đọc danh sách hội thoại + toàn bộ nội dung tin nhắn — **chỉ có tác dụng ở kênh quản trị đã bật** (xem dưới) |

**Đọc hội thoại (từ 1.4.0) — mặc định TẮT.** Quản trị bật riêng từng kênh: Inbox Zalo → ⚙️ Cài đặt → tick *"Cho ứng dụng AI bên ngoài (MCP) đọc hội thoại và nội dung tin nhắn"*. Khi tắt, ứng dụng AI không thấy các công cụ đọc tin. Kết nối tạo trước 1.4.0 chưa có quyền `zalo:messages` → xóa kết nối trong ứng dụng AI rồi kết nối lại và tick quyền này. Trang Kết nối AI bên ngoài hiện kênh nào đang bật. Quyền theo tài khoản đã cấp, tính theo **hiện tại**: Vận hành trở lên dùng mọi kênh Zalo, Thành viên chỉ kênh được gán. Đổi mật khẩu, khóa tài khoản hoặc gỡ khỏi workspace → kết nối mất hiệu lực. Thu hồi: Dashboard → Kết nối AI bên ngoài → Thu hồi.

### Công cụ

| Tool | Quyền | Tham số |
|---|---|---|
| `zalo_list_channels` | read | — |
| `zalo_list_contacts` | read | `query?`, `limit?` (≤100), `cursor?`, `channel_id?` → `uid`, `name`, `phone`, `is_friend` |
| `zalo_list_groups` | read | như trên → `group_id`, `name`, `member_count` |
| `zalo_find_user_by_phone` | read | `phone` |
| `zalo_list_conversations` | messages | `query?`, `type?` (user/group), `unread_only?`, `limit?` (≤200), `cursor?`, `channel_id?` → `thread_id`, tên, tin cuối, số chưa đọc |
| `zalo_get_messages` | messages | `thread_id`, `limit?` (mặc định 500, ≤2000), `before?`, `channel_id?` → lịch sử cũ → mới, người gửi, nguồn, ảnh/file (link); `has_more` + `next_before` để lấy tiếp phần cũ hơn tới hết |
| `zalo_react_latest` | send | `thread_id`, `reaction?` (heart mặc định / like / haha / wow / cry / angry / none), `count?` (≤5) → thả vào tin mới nhất của khách — không cần quyền đọc tin |
| `zalo_react_message` | send | `thread_id`, `message_id` (từ `zalo_get_messages` / `zalo_search_messages`), `reaction` |
| `zalo_search_messages` | messages | `query`, `thread_id?`, `since?` (ISO), `limit?` (≤200) → tin khớp từ khóa kèm hội thoại |
| `zalo_send_message` | send | `to` (uid/group_id), `thread_type?` (user/group), `message?`, `image_url?`, `request_id?`, `channel_id?` |
| `zalo_send_message_by_phone` | send | `phone`, `message?`, `image_url?`, `request_id?`, `channel_id?` |

- `channel_id` chỉ cần khi workspace có nhiều kênh Zalo.
- **Trả lời vào hội thoại** (cá nhân hoặc nhóm): `zalo_send_message` với `to` = `thread_id` lấy từ `zalo_list_conversations`.
- Lịch sử chỉ gồm tin PenAI đã lưu từ lúc kênh kết nối (Zalo không cho lấy lịch sử cũ hơn).
- Ảnh: `image_url` là URL http(s) công khai hoặc `data:image/...;base64,...`; PNG/JPEG/GIF/WEBP ≤ 10 MB. URL trỏ vào mạng nội bộ bị từ chối.
- Danh bạ lấy từ dữ liệu đã lưu (bạn bè, nhóm, người đã nhắn). Thiếu người → Inbox → Đồng bộ danh bạ.
- **Gửi tuần tự**: mỗi kênh gửi 1 tin / 2 giây. Gửi dồn → lỗi `RATE_LIMITED` kèm `retry_after_seconds`.
- **Chống gửi trùng**: truyền `request_id` (UUID) mỗi tin; thử lại cùng tin thì giữ nguyên `request_id` + tham số → không gửi lần 2.

| Mã lỗi | Ý nghĩa |
|---|---|
| `NOT_CONNECTED` | Kênh Zalo mất kết nối — quét QR lại trong Channels |
| `USER_NOT_FOUND` | SĐT chưa dùng Zalo hoặc chặn tìm kiếm |
| `RATE_LIMITED` / `SEND_IN_PROGRESS` | Chờ rồi thử lại cùng `request_id` |
| `ZALO_REJECTED` | Zalo trả lỗi, tin **chưa** gửi (sai uid/loại nhóm, gửi cho chính tài khoản đang kết nối…) |
| `SEND_OUTCOME_UNKNOWN` | Có thể đã gửi — kiểm tra Inbox, không tự gửi lại bằng mã mới |
| `IDEMPOTENCY_CONFLICT` | `request_id` đã dùng cho tin khác |
| `IMAGE_INVALID` | Ảnh sai định dạng / quá lớn / URL nội bộ |
| `CHANNEL_REQUIRED` / `CHANNEL_NOT_ALLOWED` / `NO_CHANNEL` | Chọn đúng kênh / tài khoản chưa được trực kênh nào |
| `INSUFFICIENT_SCOPE` | Kết nối chưa được cấp quyền đó — kết nối lại và tick quyền |
| `MESSAGES_DISABLED` | Kênh chưa bật cho ứng dụng AI đọc tin nhắn (Inbox → ⚙️ Cài đặt) |
| `THREAD_NOT_FOUND` | Không có hội thoại / chưa có tin nào được lưu |
| `CANNOT_REACT` / `NO_MESSAGE` | Tin lưu trước 1.5.0 không thả cảm xúc được / hội thoại chưa có tin của khách để thả |

### Kỹ thuật (cho người sửa mã)

- OAuth 2.1: discovery `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`; endpoint `/oauth/register` (đăng ký client động), `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke`. PKCE S256 bắt buộc. Access token 1 giờ, refresh token 30 ngày (xoay vòng; dùng lại refresh cũ sau 60 giây → thu hồi kết nối). Mọi token/code/secret chỉ lưu sha256.
- Issuer = `PENAI_PUBLIC_URL` trong `penai.env` (bản cài có sẵn). Thiếu biến này → MCP trả 503.
- `/mcp` chấp nhận Origin của chính PenAI, `https://claude.ai`, `https://chatgpt.com`; thêm origin khác bằng biến `PENAI_MCP_ALLOWED_ORIGINS` (phân tách dấu phẩy). Client chạy phía máy chủ (không gửi Origin) luôn được chấp nhận nếu token hợp lệ.
- Mã: `apps/server/src/mcp-server.ts` (OAuth + tool), `apps/server/src/zalo-inbox.ts` (lưu tin, SSE, gửi, ảnh), `packages/db/src/zalo-inbox-repo.ts`, `packages/db/src/mcp-oauth-repo.ts`, migration `0031_zalo_inbox_mcp_server.sql`, adapter `packages/channels/src/zalo-personal.ts` (`onMessageLog`, `sendManual`, `syncContacts`).
- Tin do PenAI gửi dội lại qua listener Zalo (`isSelf`) được bỏ qua theo `msgId`; bản dội lại có thể tới trước khi lệnh gửi trả kết quả nên listener chờ 1,5 giây rồi kiểm tra lại — đừng bỏ bước chờ này, nếu không tin AI/nhân viên bị lưu trùng thành "gửi từ điện thoại" và AI tự tạm dừng sau chính câu trả lời của mình.
