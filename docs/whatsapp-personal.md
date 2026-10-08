# WhatsApp cá nhân

Kênh `whatsapp_personal` nối một tài khoản WhatsApp (bản thường hoặc WhatsApp Business trên điện thoại) vào PenAI.
PenAI đóng vai một **thiết bị đã liên kết** của tài khoản — giống WhatsApp Web: quét mã một lần, điện thoại vẫn
dùng WhatsApp bình thường. Có từ bản **1.9.0**.

Đây là kết nối **không chính thức** (thư viện Baileys), không phải WhatsApp Cloud API của Meta. Được: không mất phí,
không bị giới hạn "khung 24 giờ", có nhóm chat. Mất: WhatsApp có thể giới hạn hoặc khóa số — nhất là số mới tạo hoặc
gửi dồn cho người lạ. Nên dùng số dành riêng, đừng dùng để gửi hàng loạt.

| Tính năng | Ghi chú |
|---|---|
| Kết nối bằng mã QR hoặc mã 8 ký tự | [1](#1-kết-nối) |
| Agent tự trả lời trong hội thoại được phép (chế độ an toàn) | [2](#2-chế-độ-an-toàn) |
| Inbox: nhiều người cùng xem và trả lời, AI tạm im khi người chen vào | [3](#3-inbox) |
| Nhập tin cũ khi vừa liên kết | [3](#3-inbox) |
| MCP: Claude, ChatGPT… hoặc agent của PenAI gửi tin WhatsApp | [4](#4-mcp-và-api) |

## 1. Kết nối

1. Dashboard → **Channels** → **＋ Thêm kênh** → loại `whatsapp_personal`, đặt tên, chọn agent → **Tạo kênh** (không cần token).
2. Ở dòng kênh vừa tạo bấm **Kết nối QR** → **Tạo mã QR**.
3. Trên điện thoại: WhatsApp → **Cài đặt** → **Thiết bị đã liên kết** → **Liên kết thiết bị** → quét mã. Mã tự đổi sau mỗi 20–60 giây.
4. Không quét được (camera hỏng, mở Dashboard ngay trên điện thoại…): bấm **"Không quét được? Liên kết bằng số điện thoại"**, nhập số của tài khoản WhatsApp → Dashboard hiện mã 8 ký tự → trên điện thoại chọn **Liên kết bằng số điện thoại** rồi nhập mã.

Lưu ý:

- Phiên đăng nhập nằm trong thư mục dữ liệu của PenAI (`<data>/<workspace>/channel-state/<mã kênh>/auth`). Sao lưu có kèm file (`sudo penai backup --with-data`) mới giữ được phiên; khôi phục thiếu thư mục này thì quét lại.
- WhatsApp tự hủy liên kết nếu **điện thoại không lên mạng khoảng 14 ngày**, hoặc khi bạn gỡ thiết bị trong WhatsApp → Thiết bị đã liên kết. Khi đó trang Channels báo lỗi và cần quét lại.
- Một tài khoản WhatsApp liên kết được tối đa 4 thiết bị; PenAI chiếm 1.
- Mất mạng tạm thời thì PenAI tự kết nối lại, không cần quét.

## 2. Chế độ an toàn

Giống Zalo cá nhân — tài khoản có thể là số đang dùng thật nên mặc định PenAI **chỉ quan sát**:

- Mọi tin đến/đi được lưu vào Inbox (tắt được), nhưng agent **không tự trả lời** ai.
- Agent chỉ tự trả lời trong hội thoại được chỉ định: Channels → **Kết nối QR** → mục *Danh sách chờ duyệt* → **Chỉ định demo**; hoặc **mọi tin riêng** nếu kênh bỏ tick **"Yêu cầu pairing"** (nhóm vẫn phải chỉ định).
- Trong nhóm được phép, agent chỉ trả lời khi được **@nhắc**, **trả lời vào tin của mình**, hoặc tin bắt đầu bằng `/`. Muốn trả lời mọi tin trong nhóm: `config.require_mention = false`.
- Người lạ nhắn khi pairing đang bật: agent im lặng (không tự gửi mã ghép nối); quản trị duyệt ở Channels.
- Chế độ an toàn chỉ giới hạn **agent tự trả lời**. Nhân viên gửi từ Inbox và ứng dụng AI gửi qua MCP thì gửi được cho mọi số/nhóm.

Agent nhận được: chữ, ảnh, file (≤ 10 MB). Tin nhắn thoại, video, vị trí, danh thiếp chỉ được ghi chú cho agent.

## 3. Inbox

Dashboard → **📥 Inbox** → chọn kênh WhatsApp ở ô đầu trang. Cách dùng như Inbox của Zalo cá nhân
([zalo-personal.md](zalo-personal.md) mục 3): xem hội thoại, gửi chữ/ảnh, nhắn tin mới theo số điện thoại, tắt AI theo
từng hội thoại, thả cảm xúc, tự thả cảm xúc khi khách nhắn. Thành viên chỉ thấy kênh được gán (Người dùng → Sửa).

Riêng WhatsApp:

- **Tin cũ**: ngay sau khi liên kết, WhatsApp gửi về một phần hội thoại gần đây (thường vài tuần đến vài tháng, do WhatsApp quyết định). PenAI lưu vào Inbox, không tính "chưa đọc", không chạy agent. Ảnh/file của tin cũ không được tải về.
- **Mã hội thoại**: tin riêng là số điện thoại kèm mã quốc gia (`84938583264`); nhóm có dạng `<id>@g.us`. Một số người WhatsApp không lộ số điện thoại → mã có dạng `<số>@lid`.
- **Danh bạ**: WhatsApp không cho lấy danh bạ điện thoại. Inbox chỉ có người đã từng nhắn và các nhóm đang tham gia.
- Nhắn số Việt Nam bắt đầu bằng `0` được tự đổi thành `84…`.

## 4. MCP và API

- **MCP** (`https://<tên-miền>/mcp`): kênh WhatsApp có bộ công cụ cùng khuôn với Zalo, đổi tiền tố thành `whatsapp_`:
  `whatsapp_list_channels`, `whatsapp_list_contacts`, `whatsapp_list_groups`, `whatsapp_find_user_by_phone`,
  `whatsapp_send_message` (`to` = số điện thoại kèm mã quốc gia hoặc mã nhóm), `whatsapp_send_message_by_phone`,
  `whatsapp_react_latest`, `whatsapp_react_message`, và nhóm đọc tin `whatsapp_list_conversations`,
  `whatsapp_get_messages`, `whatsapp_search_messages` (quản trị bật theo kênh ở Inbox → ⚙️ Cài đặt).
  Quyền tương ứng: `whatsapp:read`, `whatsapp:send`, `whatsapp:messages`. **Kết nối MCP tạo trước bản 1.9.0 phải kết nối lại** để được cấp các quyền này.
  Phân quyền theo kênh giống Zalo: kết nối dùng được đúng những kênh mà tài khoản PenAI đã cấp quyền được trực.
- **REST**: dùng chung địa chỉ `/v1/inbox/<mã kênh>/…` (xem [zalo-personal.md](zalo-personal.md) mục API; `/v1/zalo-inbox/…` vẫn chạy như cũ).
  Mã `threadId` có ký tự `@` phải mã hóa URL (`%40`).

## Mã nguồn

| Việc | File |
|---|---|
| Adapter WhatsApp (Baileys) | `packages/channels/src/whatsapp-personal.ts` |
| Bề mặt chung của kênh cá nhân | `packages/channels/src/personal.ts` |
| Inbox chung (lưu tin, SSE, gửi, quyền) | `apps/server/src/inbox.ts`, `packages/db/src/inbox-repo.ts` |
| Bảng `inbox_*` + view tương thích `zalo_*` | migration `0034_inbox_chung.sql` |

Bẫy đã gặp:

- **"Không thể liên kết thiết bị, hãy kiểm tra kết nối"** khi quét: số phiên bản WhatsApp Web kèm trong thư viện đã cũ. Adapter lấy số mới nhất bằng `fetchLatestWaWebVersion` mỗi lần khởi động; máy chủ không ra được internet tới `web.whatsapp.com` sẽ dùng số kèm sẵn và có thể gặp lại lỗi này.
- Tin do PenAI gửi dội lại qua sự kiện nhận tin → adapter nhớ mã tin lúc gửi để bỏ qua bản dội lại (cùng cách với Zalo).
