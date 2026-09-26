# Hướng dẫn tạo Bot Microsoft Teams kết nối PenAI

> Dành cho người triển khai. Kết quả cuối: một bot AI trong Microsoft Teams của tổ chức bạn — chat 1-1 (có streaming chữ chạy dần, gửi được file/ảnh) và chat trong nhóm/kênh (@mention), trả lời bằng agent + kho tri thức trên nền tảng PenAI.
>
> Thời gian thực hiện: ~30 phút. Cần quyền: **Microsoft Entra admin center** (đăng ký App) + **Azure Portal** (tạo Azure Bot) và **quản trị viên Microsoft Teams** của tổ chức (để phát hành app).

## Kiến trúc tóm tắt

```
Người dùng Teams ──> Microsoft Bot Framework ──> https://<domain-penai>/webhooks/teams
                                                        │ (verify chữ ký JWT)
                                                  PenAI Agent (AI + kho tri thức)
                                                        │
Người dùng Teams <── Bot Framework <── trả lời (stream từng phần trong chat 1-1)
```

Mỗi tổ chức đăng ký **bot riêng trong tenant của mình** (bot Single Tenant chỉ dùng được trong đúng tenant đó), rồi trỏ về server PenAI. Một server PenAI phục vụ được nhiều bot/tổ chức cùng lúc.

---

## Bước 1 — Đăng ký App trên Microsoft Entra ID

1. Vào **Microsoft Entra admin center** https://entra.microsoft.com → menu trái **Entra ID → App registrations** → **New registration**.
   *(Có thể vào thẳng: https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade. 
2. Điền:
   - **Name**: ví dụ `PenAI Bot`.
   - **Supported account types**: chọn **Accounts in this organizational directory only** (Single tenant).
   - Redirect URI: bỏ trống.
   - ⚠️ **Kiểm tra đúng tenant**: app sẽ được tạo trong tenant bạn đang đăng nhập (xem góc trên phải). Bot Single Tenant chỉ chạy trong đúng tenant này — muốn bot cho tổ chức nào thì phải đăng nhập bằng tài khoản admin của tổ chức đó.
3. Bấm **Register**. Ở trang Overview, **ghi lại 2 giá trị**:
   - **Application (client) ID** — gọi tắt là `APP_ID`
   - **Directory (tenant) ID** — gọi tắt là `TENANT_ID`
4. Menu trái → **Certificates & secrets** → **New client secret** → đặt tên (vd `PenAI VPS`), hạn 12-24 tháng → **Add**.
5. **Copy ngay cột "Value"** (chỉ hiện một lần!) — gọi là `CLIENT_SECRET`. ⚠️ Đây là mật khẩu của bot: chỉ gửi qua kênh an toàn, không dán vào chat/email thường, và xóa file tạm sau khi nhập vào hệ thống.

## Bước 2 — Tạo Azure Bot

1. Azure Portal https://portal.azure.com/ → **Create a resource** → tìm **Azure Bot** → **Create**.
2. Điền:
   - **Bot handle**: vd `penai-bot` (định danh nội bộ, không hiện với người dùng).
   - Subscription/Resource group: theo chuẩn của tổ chức.
   - **Pricing tier**: F0 (Free) là đủ.
   - **Type of App**: **Single Tenant**.
   - **Creation type**: **Use existing app registration** → dán `APP_ID` (+ `TENANT_ID` nếu được hỏi).
3. Tạo xong, mở resource bot → **Settings → Configuration**:
   - **Messaging endpoint**: `https://ai.example.com/webhooks/teams`
     *(thay bằng domain PenAI của môi trường bạn dùng — hỏi đội vận hành PenAI nếu không chắc)*
   - Kiểm tra **Bot Type = Single Tenant**, **Microsoft App ID** khớp `APP_ID`, **App Tenant ID** khớp `TENANT_ID` → **Apply**.
4. **Settings → Channels** → chọn/bật **Microsoft Teams** → đồng ý điều khoản → Apply. Trạng thái phải là **Healthy**.

## Bước 3 — Tạo kênh trong PenAI Dashboard

*(Người có quyền ws_admin trên PenAI thực hiện.)*

1. Vào Dashboard PenAI (vd https://ai.example.com) → **Channels** → **＋ Thêm kênh**.
2. Điền:
   - **Loại kênh**: `msteams`
   - **Tên kênh**: vd `Teams công ty`
   - **Agent trả lời**: chọn agent phù hợp (lưu ý: agent chạy provider codex/OpenAI thì chat 1-1 sẽ **stream chữ chạy dần**; agent chạy claude-code trả lời nguyên khối)
   - **Token / credential**: dán `CLIENT_SECRET` (được mã hóa AES-256 trong DB)
   - **Microsoft App ID**: `APP_ID`
   - **Tenant ID**: `TENANT_ID`
   - **Yêu cầu pairing**: bật (khuyến nghị) — người mới nhắn lần đầu phải được admin duyệt. Nhóm nội bộ tin cậy có thể tắt.
3. Bấm **Tạo kênh** — áp dụng ngay, không cần restart server.

## Bước 4 — Đóng gói Teams App (manifest)

Teams yêu cầu bot được phát hành dưới dạng **ứng dụng Teams** (file zip gồm `manifest.json` + 2 icon). Dùng mẫu có sẵn trong thư mục [`docs/teams-app/`](teams-app/) của repo (`manifest.json` + `color.png` 192×192 + `outline.png` 32×32):

1. Chép cả thư mục ra chỗ khác, mở `manifest.json`, sửa các trường sau:

| Trường | Sửa thành |
|---|---|
| `id` | `APP_ID` **của bạn** |
| `bots[0].botId` | `APP_ID` **của bạn** (bắt buộc trùng `id`) |
| `name.short` / `name.full` | Tên bot muốn hiển thị, vd `PenAI` |
| `description` | Mô tả của tổ chức bạn |
| `developer` | Tên/website tổ chức bạn |

   Giữ nguyên: `bots[0].supportsFiles: true` (cho phép đính kèm file trong chat 1-1), `scopes: ["personal","team","groupChat"]`.
2. Thay 2 icon nếu muốn: `color.png` (192×192) và `outline.png` (32×32, nền trong suốt).
3. Nén lại thành zip: chọn **3 file** (manifest.json, color.png, outline.png) → nén — lưu ý nén trực tiếp 3 file, **không** nén cả thư mục bọc ngoài.

## Bước 5 — Phát hành app trong Teams

**Cách chuẩn cho tổ chức** (cần quản trị viên Teams):
1. Vào **Trung tâm quản trị Teams** https://admin.teams.microsoft.com → **Teams apps → Manage apps → Upload new app** → chọn file zip.
2. Mở app vừa upload → cấu hình **Users and groups / Available to** = mọi người hoặc nhóm được dùng.
3. Chờ vài phút để app xuất hiện trong Teams client (có thể phải thoát hẳn Teams mở lại).

**Cách nhanh cho cá nhân thử nghiệm** (nếu tổ chức cho phép sideload): Teams → **Apps → Manage your apps → Upload an app → Upload a custom app** → chọn zip.

**Cập nhật phiên bản sau này**: Trung tâm quản trị → Manage apps → mở app → "Phiên bản mới: Tải lên Tệp" (nhớ tăng `version` trong manifest, vd 1.0.1 → 1.0.2).

## Bước 6 — Bắt đầu dùng

**Chat 1-1**: Teams → **Apps** → tìm tên bot → **Add/Mở** → nhắn tin.
- Tin đầu tiên bot trả về **mã ghép nối (pairing)** → admin PenAI vào Dashboard → Channels → mục "Yêu cầu chờ duyệt" → bấm **Duyệt**. Sau đó chat bình thường.
- Câu trả lời dài hiển thị **chữ chạy dần** (streaming) rồi chốt bản hoàn chỉnh.
- **Gửi file/ảnh**: đính kèm bằng nút 📎 hoặc dán ảnh (Ctrl+V) — file được lưu vào không gian làm việc riêng của từng người; sau đó nhắn "tóm tắt file này", "dựa vào bảng giá viết bài đăng"... (tối đa 10MB/file).

**Nhóm chat**: Apps → bot → mũi tên ▼ cạnh nút Mở → **Thêm vào cuộc trò chuyện** → chọn nhóm. Nhắn phải **@tên-bot** (Teams chỉ chuyển tin cho bot khi được tag). Trả lời hiển thị phẳng trong chat.

**Kênh trong Team**: Apps → bot → ▼ → **Thêm vào nhóm** → chọn team. Nhắn `@tên-bot ...` trong kênh; bot trả lời vào **chuỗi hội thoại (thread)** của tin đó — đây là hành vi chuẩn của Teams channel.

**Lệnh hữu ích** (gõ trong chat): `/stop` hủy câu trả lời đang chạy · `/new` bắt đầu hội thoại mới · `/help` xem giới thiệu.

## Giới hạn hiện tại

- **File trong nhóm/kênh**: Teams chuyển file nhóm qua SharePoint — bot chưa đọc được (cần Graph API, thuộc lộ trình sau). Gửi file cho bot qua **chat 1-1**.
- **Streaming** chỉ có ở chat 1-1 (giới hạn của Teams); trong nhóm bot hiện "đang soạn..." rồi gửi trọn câu trả lời.
- Bot **Single Tenant** chỉ dùng được trong tenant đã đăng ký — tổ chức khác muốn dùng phải tự đăng ký bộ App + Bot của mình (lặp lại từ Bước 1) và tạo thêm một kênh msteams trong PenAI; một server PenAI phục vụ nhiều bot song song.

## Xử lý sự cố nhanh

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Nhắn bot không phản hồi gì | Messaging endpoint sai/chưa Apply; kênh msteams trong PenAI chưa tạo hoặc App ID không khớp; xem log server `journalctl -u penai.service` |
| Bot báo lỗi 401 trong log server | `TENANT_ID` khai trong PenAI không khớp tenant thật của app |
| Không gửi được tin ra (log "Teams token lỗi") | `CLIENT_SECRET` sai/hết hạn — tạo secret mới ở Bước 1.4 rồi Sửa kênh dán lại |
| "Bạn không có quyền sử dụng ứng dụng này" | App chưa phát hành trong tenant — làm Bước 5 |
| Không thấy nút đính kèm file trong chat bot | Manifest thiếu `supportsFiles: true` — cập nhật app phiên bản mới |
| Bot không trả lời trong nhóm | Quên @tag bot |
| Người dùng bị "chờ duyệt" mãi | Admin PenAI chưa duyệt mã pairing trong Dashboard → Channels |
