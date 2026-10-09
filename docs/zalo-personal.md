# Zalo cá nhân trong PenAI

Tài liệu đầy đủ về kênh **Zalo cá nhân** (`zalo_personal`) — cập nhật tới bản **1.6.0**.

Một tài khoản Zalo cá nhân đăng nhập bằng QR trở thành một kênh của PenAI. Trên kênh đó có:

| Tính năng | Có từ | Mục |
|---|---|---|
| Kết nối QR, agent tự trả lời trong thread được phép (chế độ an toàn) | 1.0 | [1](#1-kết-nối-và-chế-độ-an-toàn), [2](#2-agent-tự-trả-lời) |
| Công tắc "Agent tự trả lời" theo kênh | 1.5.0 | [2](#2-agent-tự-trả-lời) |
| Inbox Zalo — nhiều người cùng xem và trả lời khách | 1.3.0 | [3](#3-inbox-zalo) |
| Thả cảm xúc (reaction): thả tay, tự thả khi khách nhắn | 1.5.0 | [4](#4-cảm-xúc-reaction) |
| Contacts ghi mọi người/nhóm nhắn tới, UID, xuất Excel | 1.6.0 | [5](#5-contacts-uid-và-xuất-excel) |
| MCP server — Claude/ChatGPT… tra danh bạ, gửi tin + ảnh, đọc hội thoại, thả cảm xúc | 1.3.0 → 1.5.0 | [6](#6-kết-nối-ai-bên-ngoài-mcp) |

> **Lưu ý quan trọng.** Zalo cá nhân dùng thư viện không chính thức `zca-js` (mô phỏng Zalo Web). Zalo có thể giới hạn hoặc khóa tài khoản — nhất là khi gửi/thả cảm xúc hàng loạt cho người lạ. Mỗi tài khoản chỉ nên có **một** nơi đăng nhập Zalo Web: mở Zalo Web trên trình duyệt bằng cùng tài khoản có thể làm PenAI mất kết nối.

---

## 1. Kết nối và chế độ an toàn

### Thiết lập

1. Dashboard → **Channels** → **＋ Thêm kênh** → loại `zalo_personal`, đặt tên, chọn agent.
2. Bấm **Kết nối QR** → **Tạo mã QR** → mở Zalo trên điện thoại, quét và xác nhận.
3. Xong. Phiên đăng nhập được mã hóa bằng `PENAI_MASTER_KEY` và tự khôi phục sau khi khởi động lại — không phải quét lại.
4. Sau mỗi lần kết nối, danh bạ (bạn bè + nhóm đang tham gia) tự kéo về cho Inbox, Contacts và MCP.

### Chế độ an toàn (luôn bật)

Kênh được thiết kế để đăng nhập được cả **tài khoản Zalo đang dùng thật** mà agent không tự nhắn lung tung:

- Agent **chỉ tự trả lời** trong các hội thoại được cho phép:
  - Hội thoại được **"Chỉ định demo"** (Channels → Kết nối QR → danh sách ai/nhóm đã nhắn tới → bấm Chỉ định demo; lưu ở `config.demo_threads`, dạng `group:<id>` / `direct:<id>`).
  - **Mọi tin riêng** nếu kênh **bỏ tick "Yêu cầu pairing"**. Nhóm vẫn phải chỉ định demo. ⚠️ Chỉ bỏ tick khi tài khoản dành riêng cho bot — tài khoản thật mà mở tin riêng là agent trả lời cả bạn bè/người thân.
- Trong nhóm được phép, agent mặc định chỉ trả lời khi được **@nhắc tên**, **trả lời vào tin của bot**, hoặc lệnh `/...`. Muốn trả lời mọi tin trong nhóm: đặt `config.require_mention = false`.
- Pairing bật mà người gửi chưa được duyệt → agent **im lặng** (không gửi mã ghép nối như các kênh khác); mã vẫn được cấp, quản trị duyệt ở Channels → Yêu cầu chờ duyệt.
- Chế độ an toàn chỉ giới hạn **agent tự trả lời**. Người trực gửi tay từ Inbox, ứng dụng AI gửi qua MCP thì gửi được cho mọi người/nhóm.

### Agent nhận được gì

- Chữ; ảnh và file từ CDN Zalo (tối đa 10 MB, lưu vào thư mục riêng của người gửi). Tin nhắn thoại, video, sticker chỉ được ghi chú cho agent.
- Chỉ gửi file mà không kèm chữ → lưu file, báo "📎 Đã lưu", chờ lệnh ở tin sau (không chạy AI).
- Agent trả lời: hiệu ứng "đang soạn", câu dài tự chia ≤ 2.000 ký tự, gửi được file/ảnh agent tạo.

---

## 2. Agent tự trả lời

Channels → **Sửa** kênh → ô **"Agent tự trả lời"** (trên cùng, mặc định có tick).

- **Bỏ tick**: agent không trả lời trên kênh này, nhưng kênh **vẫn kết nối**, Inbox vẫn lưu và hiện tin, nhân viên vẫn chat tay, MCP vẫn chạy, Contacts vẫn ghi người nhắn. **Lịch hẹn** agent đã đặt vẫn gửi bình thường.
- Bật lại: danh sách thread demo giữ nguyên, không phải chọn lại.
- Dùng được cho mọi loại kênh (Telegram, Teams…), không riêng Zalo. Khóa cấu hình: `config.agent_reply` (thiếu = bật).

Tắt AI **cho một người/nhóm** thay vì cả kênh: Inbox → mở hội thoại → ô "AI trả lời" → "Tắt cho hội thoại này".

---

## 3. Inbox Zalo

Từ 1.11.0, danh sách chờ duyệt cũng ưu tiên tên danh bạ giống Inbox. Khi khách gửi ảnh không có yêu cầu, Zalo mặc định chỉ xác nhận **“Đã nhận hình ạ.”** ở ảnh đầu; ảnh tiếp theo của cùng người trong cùng hội thoại cách ảnh trước dưới 30 giây không được xác nhận lặp. Yêu cầu bằng chữ bắt đầu lượt mới. Trong **Inbox → Cài đặt → Khi khách chỉ gửi ảnh**, có thể chọn **Im lặng, chỉ lưu ảnh**. Cài đặt áp dụng ngay và không vượt qua chế độ an toàn, pairing hoặc công tắc AI của kênh. File tài liệu vẫn có xác nhận riêng. Tín hiệu kết thúc cuộc gọi không chạy AI hoặc tự thả cảm xúc.

Ảnh JPG/PNG/WebP được AI chọn trong cùng lượt trả lời sẽ gửi thành bộ (tối đa 20 ảnh mỗi bộ, tùy giới hạn tài khoản); GIF/video/tài liệu tách riêng. AI vẫn có thể gọi `send_file` cho từng ảnh: PenAI gom danh sách trước khi giao cho Zalo. Các ảnh được điều tiết gửi theo tài khoản với khoảng cách tối thiểu 0,5 giây. Nếu bộ ảnh gửi lỗi giữa chừng, PenAI ghi nhận từng ảnh đã xác nhận và dừng lượt giao, không tự gửi lại cả bộ. Đây là gửi bộ ảnh, không phải một yêu cầu mạng duy nhất và không bảo đảm tránh được giới hạn tài khoản của Zalo.

Từ 1.10.0, Inbox ưu tiên **tên bạn tự lưu trong danh bạ Zalo** và hiện tên Zalo gốc bên dưới khi khác nhau. Có thể tìm kiếm bằng cả hai tên. Tên danh bạ lưu riêng nên tin nhắn mới không ghi đè; bấm **Đồng bộ danh bạ** để nhận tên vừa đổi hoặc xóa trên Zalo. Nếu tải tên bị lỗi, PenAI giữ tên đã lưu cho tới lượt đồng bộ thành công.

Dashboard → **📥 Inbox Zalo**.

- **Danh sách hội thoại** (trái): cá nhân 👤 / nhóm 👥, số tin chưa đọc, tìm theo tên / uid / SĐT (tìm cả danh bạ chưa từng chat), lọc Cá nhân / Nhóm / Chưa đọc. Biểu tượng ⏸️ = AI đang tạm dừng, 🚫 = AI đã tắt cho hội thoại.
- **Tin nhắn** (phải): cập nhật tức thì, không cần tải lại trang. Nhãn tin gửi đi: 🤖 AI · 👤 tên nhân viên · 📱 gửi từ điện thoại · 🔌 ứng dụng AI qua MCP.
- **Gửi**: chữ, ảnh (nút 🖼️ hoặc dán ảnh vào ô nhập). Enter gửi, Shift+Enter xuống dòng.
- **＋ Nhắn tin mới**: theo số điện thoại (tự tra Zalo), uid cá nhân hoặc ID nhóm.
- **🔄 Đồng bộ danh bạ** (Vận hành trở lên): kéo lại bạn bè + nhóm.
- **⚙️ Cài đặt** (Quản trị), theo từng kênh:

| Cài đặt | Mặc định | Ý nghĩa |
|---|---|---|
| Lưu nội dung tin nhắn | Bật | Tắt thì tin mới không lưu/hiện trong Inbox (tin cũ giữ nguyên) |
| AI tạm im sau khi nhân viên trả lời | 30 phút | 0 = không tạm dừng |
| Tự thả cảm xúc khi khách nhắn | Tắt | Xem mục 4 |
| Cho ứng dụng AI bên ngoài (MCP) đọc hội thoại và nội dung tin nhắn | Tắt | Xem mục 6 |

**AI và nhân viên cùng trực:** nhân viên trả lời (từ Inbox **hoặc** từ điện thoại) → AI tự im trong hội thoại đó theo số phút ở Cài đặt. Nút **"Cho AI trả lời lại"** bỏ tạm dừng ngay.

**Lưu gì:** mọi tin đến/đi của tài khoản (kể cả tin riêng) kể từ lúc kết nối — Zalo không cho lấy lịch sử cũ. Ảnh/file khách gửi chỉ lưu link CDN Zalo; ảnh gửi đi lưu tại `/var/lib/<bản-cài>/data/<workspace>/zalo-inbox/`.

**Ai được vào Inbox:**

| Vai trò | Quyền |
|---|---|
| Quản trị, Vận hành | Mọi kênh Zalo của workspace |
| Thành viên | Chỉ kênh được gán: Người dùng → Sửa → tick **"Kênh Zalo được trực"** |
| Chỉ xem | Không |

---

## 4. Cảm xúc (reaction)

- **Thả tay trong Inbox**: rê chuột vào tin của khách → ❤️ 👍 😆 😮 😢 😡; bấm lại icon đang chọn để gỡ. Cảm xúc của khách và của mình hiện dưới tin, cập nhật tức thì.
- **Tự thả khi khách nhắn**: Inbox → ⚙️ Cài đặt → Tắt (mặc định) / ❤️ / 👍.
  - Áp dụng **cả tin riêng và nhóm**, độc lập với "Agent tự trả lời".
  - Thả vào **tin cuối** của mỗi đợt khách nhắn, sau 1–4 giây; cả kênh tối đa ~1 lần/giây.
  - Nhóm đông người nhắn nhiều → tài khoản thả rất nhiều, Zalo có thể giới hạn tài khoản.
- Chỉ thả được vào tin lưu **từ bản 1.5.0** trở đi (thả cảm xúc cần hai mã của tin mà bản cũ chưa lưu).

---

## 5. Contacts, UID và xuất Excel

- Mỗi khi có người nhắn tới — **tin riêng**, **người gửi trong nhóm** — và **cả nhóm** đó, hệ thống ghi ngay vào Dashboard → **Contacts** (chỉ tên + UID). Không phụ thuộc thread demo hay công tắc agent. Người/nhóm nhắn trước bản 1.6.0 sẽ vào ở lần nhắn kế tiếp.
- Trang Contacts: lọc theo **từng kênh**, cột **Loại** (👤 Cá nhân / 👥 Nhóm), cột **UID / ID** có nút 📋 sao chép (dùng để gửi tin lại qua Inbox → Nhắn tin mới hoặc MCP `zalo_send_message`), SĐT Zalo nếu tài khoản thấy được. Bấm vào một người để đặt hồ sơ, nhãn, chỉ dẫn riêng cho AI ([ho-so-contact.md](ho-so-contact.md)).
- **⬇ Xuất Excel** (Vận hành trở lên): chọn kênh (hoặc Mọi kênh) → tải file `.xlsx`:
  - Sheet **Contacts**: kênh, loại, UID, tên, tên hồ sơ, xưng hô, SĐT, email, vai trò, ngôn ngữ, nhãn, trường tùy chỉnh, chỉ dẫn cho AI, trạng thái duyệt, lần đầu / gần nhất nhắn.
  - Sheet **Danh bạ Zalo** (mỗi kênh Zalo cá nhân một sheet): toàn bộ bạn bè + nhóm đã đồng bộ — loại, UID, tên, SĐT, bạn bè/đang trong nhóm, số thành viên, tin gần nhất, chưa đọc.
  - UID dài và SĐT có số 0 đầu được giữ nguyên dạng chữ (Excel không làm tròn).

---

## 6. Kết nối AI bên ngoài (MCP)

MCP (Model Context Protocol) là chuẩn để ứng dụng AI gọi công cụ bên ngoài. Địa chỉ: `https://<tên-miền-PenAI>/mcp` — xem và sao chép ở Dashboard → **🔗 Kết nối AI bên ngoài** (trang này còn liệt kê kết nối đã cấp quyền, nút Thu hồi, lượt gửi gần đây và kênh nào đang cho đọc tin).

### Kết nối

- **Claude** (claude.ai / Claude Desktop): Settings → Connectors → *Add custom connector* → dán địa chỉ → Connect.
- **ChatGPT**: Settings → Apps & Connectors → Advanced → bật *Developer mode* → Create → dán địa chỉ, chọn OAuth.
- **Chính PenAI** (cho agent dùng): Dashboard → MCP → Tạo mới → transport `http`, URL là địa chỉ trên → Đăng nhập OAuth. Nên để phạm vi `granted` rồi gán cho đúng agent cần dùng.
- Công cụ khác có MCP từ xa + OAuth (Cursor, Claude Code…): thêm địa chỉ trên; callback `http://localhost:<cổng>` được chấp nhận.

Trình duyệt mở **trang cấp quyền của PenAI**: đăng nhập bằng email + mật khẩu Dashboard (đang đăng nhập sẵn thì chỉ cần bấm), tick quyền → **Cấp quyền**. Mật khẩu không chuyển cho ứng dụng AI.

| Quyền | Cho phép |
|---|---|
| `zalo:read` | Danh sách người liên hệ, nhóm; tra người theo SĐT |
| `zalo:send` | Gửi tin + ảnh; thả cảm xúc |
| `zalo:messages` | Danh sách hội thoại + toàn bộ nội dung tin nhắn — **chỉ ở kênh quản trị đã bật** (Inbox → ⚙️ Cài đặt; mặc định tắt, khi tắt ứng dụng AI không thấy các công cụ này) |

Quyền tính theo tài khoản đã cấp, ở thời điểm **hiện tại**: Vận hành trở lên dùng mọi kênh Zalo; Thành viên chỉ kênh được gán; Chỉ xem không gửi được. Đổi mật khẩu, khóa tài khoản hoặc gỡ khỏi workspace → mọi kết nối của tài khoản đó mất hiệu lực. Kết nối tạo trước 1.4.0 chưa có `zalo:messages` → kết nối lại để dùng công cụ đọc tin.

### Công cụ

| Tool | Quyền | Tham số → kết quả |
|---|---|---|
| `zalo_list_channels` | read | — → kênh, trạng thái kết nối |
| `zalo_list_contacts` | read | `query?`, `limit?` (≤100), `cursor?`, `channel_id?` → `uid`, tên, SĐT, `is_friend` |
| `zalo_list_groups` | read | như trên → `group_id`, tên, số thành viên |
| `zalo_find_user_by_phone` | read | `phone` → `uid`, tên |
| `zalo_send_message` | send | `to` (uid / group_id), `thread_type?`, `message?`, `image_url?`, `request_id?`, `channel_id?` — cũng dùng để **trả lời vào hội thoại** (`to` = `thread_id`) |
| `zalo_send_message_by_phone` | send | `phone`, `message?`, `image_url?`, `request_id?`, `channel_id?` |
| `zalo_react_latest` | send | `thread_id`, `reaction?` (heart mặc định / like / haha / wow / cry / angry / none), `count?` (≤5) → thả vào tin mới nhất của khách, không cần quyền đọc tin |
| `zalo_react_message` | send | `thread_id`, `message_id` (từ `zalo_get_messages` / `zalo_search_messages`), `reaction` |
| `zalo_list_conversations` | messages | `query?`, `type?`, `unread_only?`, `limit?` (≤200), `cursor?` → `thread_id`, tên, tin cuối, chưa đọc |
| `zalo_get_messages` | messages | `thread_id`, `limit?` (mặc định 500, ≤2000), `before?` → lịch sử cũ → mới (người gửi, nguồn, ảnh/file, cảm xúc); `has_more` + `next_before` để lấy tiếp tới hết |
| `zalo_search_messages` | messages | `query`, `thread_id?`, `since?` (ISO), `limit?` (≤200) → tin khớp từ khóa kèm hội thoại |

- `channel_id` chỉ cần khi workspace có nhiều kênh Zalo.
- Ảnh: `image_url` là URL http(s) công khai hoặc `data:image/...;base64,...`; PNG/JPEG/GIF/WEBP ≤ 10 MB. URL trỏ vào mạng nội bộ bị từ chối.
- **Gửi tuần tự** mỗi kênh 1 tin / 2 giây (dồn → `RATE_LIMITED` kèm `retry_after_seconds`).
- **Chống gửi trùng**: truyền `request_id` (UUID) mỗi tin; thử lại cùng tin thì giữ nguyên `request_id` + tham số.
- Zalo **không cho gửi vào chính uid** của tài khoản đang kết nối.

| Mã lỗi | Ý nghĩa |
|---|---|
| `NOT_CONNECTED` | Kênh mất kết nối — quét QR lại |
| `USER_NOT_FOUND` | SĐT chưa dùng Zalo hoặc chặn tìm kiếm |
| `RATE_LIMITED` / `SEND_IN_PROGRESS` | Chờ rồi thử lại cùng `request_id` |
| `ZALO_REJECTED` | Zalo trả lỗi, tin **chưa** gửi (sai uid/loại, gửi cho chính tài khoản…) |
| `SEND_OUTCOME_UNKNOWN` | Có thể đã gửi — kiểm tra Inbox, không tự gửi lại bằng mã mới |
| `IDEMPOTENCY_CONFLICT` | `request_id` đã dùng cho tin khác |
| `IMAGE_INVALID` | Ảnh sai định dạng / quá lớn / URL nội bộ |
| `CHANNEL_REQUIRED` / `CHANNEL_NOT_ALLOWED` / `NO_CHANNEL` | Chọn đúng kênh / tài khoản chưa được trực kênh nào |
| `INSUFFICIENT_SCOPE` | Kết nối chưa có quyền đó — kết nối lại, tick quyền |
| `MESSAGES_DISABLED` | Kênh chưa bật cho ứng dụng AI đọc tin |
| `THREAD_NOT_FOUND` | Không có hội thoại / chưa có tin được lưu |
| `CANNOT_REACT` / `NO_MESSAGE` | Tin lưu trước 1.5.0 / hội thoại chưa có tin của khách để thả |

---

## 7. API (tích hợp)

Gọi bằng khóa `psk_…` (Dashboard → Khóa API) hoặc phiên Dashboard.

**Quản trị kênh** (`ws_admin`):

- `GET /v1/channels/:id/zalo-personal/status` · `POST …/login` · `GET …/login/:loginId` · `POST …/logout`
- `GET …/targets` (bạn bè/nhóm) · `GET …/resolve-phone?phone=` · `POST …/test-message` (chỉ vào thread demo)
- `GET …/observed` (ai/nhóm đã nhắn tới) · `PUT …/demo-threads`
- `PATCH /v1/channels/:id` với `{ "config": { "agent_reply": false } }` — tắt agent tự trả lời.

**Inbox** (người trực kênh):

- Từ 1.9.0 địa chỉ chung là `/v1/inbox/…` (dùng cho cả WhatsApp cá nhân); `/v1/zalo-inbox/…` dưới đây vẫn chạy y như cũ.
- `GET /v1/zalo-inbox/channels` · `GET /v1/zalo-inbox/events` (SSE realtime)
- `GET /v1/zalo-inbox/:channelId/threads?q=&kind=&unread=1` · `GET …/threads/:threadId/messages?before=&limit=`
- `POST …/threads/:threadId/send` `{ text?, image? }` · `POST …/new` `{ to? | phone?, peerKind?, text?, image? }`
- `POST …/threads/:threadId/read` · `PUT …/threads/:threadId/ai` `{ mode?: "auto"|"off", resume?: true }`
- `POST …/threads/:threadId/messages/:messageId/react` `{ reaction: "heart"|"like"|"haha"|"wow"|"cry"|"angry"|"none" }`
- `GET …/find-phone?phone=` · `POST …/sync-contacts` (Vận hành+) · `PUT …/settings` (Quản trị) `{ enabled?, pauseMinutes?, mcpReadMessages?, autoReaction?: "off"|"heart"|"like" }`

**Contacts**: `GET /v1/contacts` · `GET /v1/contacts/export.xlsx?channelId=` (Vận hành+).

QR và thông tin đăng nhập Zalo không bao giờ được ghi log hay trả qua API.

---

## 8. Kỹ thuật (cho người sửa mã)

| Thành phần | File |
|---|---|
| Adapter Zalo (QR, listener, gửi, danh bạ, cảm xúc, ghi Inbox) | `packages/channels/src/zalo-personal.ts` |
| Inbox: lưu tin, SSE, gửi, ảnh, Contacts, cảm xúc, route | `apps/server/src/inbox.ts` |
| MCP server + OAuth | `apps/server/src/mcp-server.ts` |
| Chặn agent (demo thread, AI tắt/tạm dừng, `agent_reply`) | `apps/server/src/channels-runtime.ts` (`makeInboundHandler`) |
| Xuất Excel | `apps/server/src/xlsx.ts` (tạo .xlsx bằng adm-zip) + route trong `app.ts` |
| DB | `packages/db/src/inbox-repo.ts`, `mcp-oauth-repo.ts`; migration `0017` (quan sát), `0031` (Inbox, MCP OAuth), `0032` (cảm xúc), `0034` (đổi tên bảng `zalo_*` → `inbox_*`, dùng chung với WhatsApp) |

Cấu hình kênh (`channels.config`): `demo_threads`, `require_mention`, `agent_reply`, `inbox`, `inbox_pause_minutes`, `mcp_read_messages`, `auto_reaction`. Biến môi trường: `PENAI_PUBLIC_URL` (bắt buộc cho MCP — bản cài có sẵn), `PENAI_MCP_ALLOWED_ORIGINS` (thêm Origin được gọi `/mcp`).

Những điểm dễ làm hỏng:

- **Tin dội lại.** Tin do PenAI gửi (agent/web/MCP) quay lại qua listener với `isSelf`. Adapter nhớ `msgId` lúc gửi để bỏ qua bản dội lại; bản dội lại có thể tới **trước** khi lệnh gửi trả kết quả nên listener chờ 1,5 giây rồi kiểm tra lại. Bỏ bước chờ → tin bị lưu trùng thành "gửi từ điện thoại" và AI tự tạm dừng sau chính câu trả lời của mình.
- **Thả cảm xúc cần `msgId` + `cliMsgId`.** `cliMsgId` lưu trong `inbox_messages.meta`; tin PenAI gửi lấy `cliMsgId` từ bản dội lại (kết quả gửi của zca-js không có).
- **zca-js**: `imageMetadataGetter` bắt buộc (trả `{ width, height, size }`); đường dẫn file phải dùng `/`; nhóm tra tên theo lô 10 ID; listener phải bắt sự kiện `error`/`closed` để không làm sập tiến trình.
- **Media đến** chỉ tải từ CDN Zalo tin cậy (`*.zalo.me`, `*.zaloapp.com`, `*.zadn.vn`, `*.zdn.vn`, qua https). Log chẩn đoán: `zalo.media:` / `zalo.media_skip:` / `zalo.media_fail:`.
- **OAuth MCP**: issuer = origin của `PENAI_PUBLIC_URL` (không có `/` cuối); PKCE S256 bắt buộc; access token 1 giờ, refresh 30 ngày xoay vòng (dùng lại refresh cũ sau 60 giây → thu hồi kết nối); token/code/secret chỉ lưu sha256.

Tham khảo: [zca-js](https://github.com/RFS-ADRENO/zca-js).
