# Inbox — phân công hội thoại cho từng nhân viên

Từ bản **1.22.0**. Dùng khi doanh nghiệp muốn mỗi nhân viên chỉ thấy và trả lời **khách / nhóm chat được giao cho mình**, thay vì thấy toàn bộ hội thoại của kênh. Áp dụng cho mọi kênh có Inbox: Zalo cá nhân, WhatsApp cá nhân, Fanpage Facebook, Instagram.

**Không cần thì không phải làm gì**: mặc định mọi người vẫn thấy tất cả hội thoại của kênh mình được trực, y như các bản trước.

## 1. Ai thấy gì

| Người dùng | Thấy trong Inbox |
|---|---|
| Quản trị, Vận hành | Mọi hội thoại của mọi kênh. Là người phân công. |
| Thành viên — phạm vi **Tất cả hội thoại** (mặc định) | Mọi hội thoại của kênh được gán |
| Thành viên — phạm vi **Chỉ hội thoại được giao** | Chỉ các khách / nhóm được giao. Hội thoại khác không hiện, không tìm ra, không đọc, không trả lời được |
| Chỉ xem | Không vào Inbox |

Phạm vi đặt **riêng cho từng nhân viên trên từng kênh**: cùng một kênh Zalo có thể có trưởng nhóm thấy hết và nhân viên chỉ thấy phần mình.

## 2. Bật cho một nhân viên

Dashboard → **Người dùng** → **Sửa** nhân viên (vai trò Thành viên) → tick kênh ở mục "Kênh được trực trong Inbox" → ô bên cạnh chọn **Chỉ hội thoại được giao** → Lưu.

Nhân viên đang mở Inbox sẽ tự nhận quyền mới sau vài giây, không cần đăng nhập lại.

## 3. Giao hội thoại (làm tay — mặc định)

Người có quyền Quản trị hoặc Vận hành:

- **Một hội thoại**: Inbox → mở hội thoại → nút **👥 Phân công** ở góc trên → tick nhân viên → Lưu. Không tick ai = bỏ phân công.
- **Nhiều hội thoại một lúc**: Inbox → nút **👥 Phân công** trên thanh công cụ → tick các hội thoại → **Giao cho…** → chọn nhân viên, chọn "Giao thêm" hoặc "Thay toàn bộ người phụ trách".
- **Tìm hội thoại chưa ai phụ trách**: ô lọc cạnh ô tìm kiếm → **Chưa phân công**.

Một hội thoại giao được cho nhiều người (vd hai nhân viên cùng chăm một nhóm khách). Tên người phụ trách hiện ngay trong danh sách hội thoại (chỉ Quản trị / Vận hành thấy).

Nhóm chat cũng giao như khách lẻ. Với Fanpage / Instagram, hội thoại bình luận bài viết cũng giao được.

## 4. Chia tự động khách mới (xoay vòng) — mặc định TẮT

Inbox → chọn kênh → **⚙️ Cài đặt** → tick **Tự chia khách mới cho nhân viên (xoay vòng)** (chỉ Quản trị).

Khi bật:

- Khách **nhắn riêng** tới kênh mà **chưa ai phụ trách** → hệ thống giao cho một nhân viên, lần lượt từng người (ai lâu nhất chưa được chia thì nhận).
- Chỉ chia cho nhân viên đang ở phạm vi **Chỉ hội thoại được giao** của kênh đó và tài khoản còn hoạt động. Kênh chưa có ai như vậy thì không chia.
- Khách cũ chưa được giao, lần tới nhắn lại cũng được chia.
- **Nhóm chat và bình luận bài viết không tự chia** — giao tay.
- Hội thoại đã có người phụ trách thì giữ nguyên. Muốn đổi người: giao tay như mục 3.

Tắt công tắc thì các phân công đã có vẫn giữ, chỉ không tự chia thêm.

## 5. Điều nên biết

- **AI vẫn trả lời như cấu hình kênh**, không phụ thuộc phân công. Nhân viên được giao tự tắt/bật AI cho hội thoại của mình được.
- Nhân viên ở phạm vi "Chỉ hội thoại được giao": không dùng nút **Nhắn tin mới** cho người chưa được giao, không tra số điện thoại, và **không dùng kênh đó qua MCP** (Claude/ChatGPT kết nối ngoài) — vì MCP đọc và gửi trên cả kênh.
- Số tin **chưa đọc** tính chung cho hội thoại, không tính riêng từng người.
- Gỡ kênh khỏi một nhân viên (hoặc gỡ nhân viên khỏi workspace) thì phân công của người đó hết hiệu lực; hội thoại trở về "chưa phân công".
- Từ bản này, Thành viên chỉ tải được file / ảnh gắn với tin nhắn của kênh mình trực (trước đây đường tải file của Inbox không kiểm theo tin nhắn).
- Mọi lần phân công tay đều ghi nhật ký (`inbox.assign`).

## 6. API (khóa `psk_` vai trò Vận hành trở lên)

```bash
# Nhân viên của kênh + số hội thoại đang giữ
curl -H "Authorization: Bearer $KEY" https://<tên-miền>/v1/inbox/<channelId>/staff

# Giao hội thoại (mode: set = thay người phụ trách, add = giao thêm; userIds rỗng + set = bỏ phân công)
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  https://<tên-miền>/v1/inbox/<channelId>/assign \
  -d '{"threadIds":["<uid-hoặc-id-nhóm>"],"userIds":["<userId>"],"mode":"set"}'

# Lọc: hội thoại chưa phân công / giao cho tôi
curl -H "Authorization: Bearer $KEY" "https://<tên-miền>/v1/inbox/<channelId>/threads?assign=none"
```

Mỗi hội thoại trong kết quả `/threads` có thêm `assignees: [{ userId, name }]`. Bật/tắt chia tự động: `PUT /v1/inbox/<channelId>/settings` với `{"autoAssign": true}` (Quản trị).
