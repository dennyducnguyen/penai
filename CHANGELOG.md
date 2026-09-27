# Thay đổi qua các phiên bản

Định dạng: mỗi phiên bản một mục, mới nhất ở trên. Số phiên bản theo quy ước `LỚN.VỪA.NHỎ`
(tăng số LỚN khi có thay đổi phải làm thêm bước thủ công lúc nâng cấp; số VỪA khi thêm tính năng;
số NHỎ khi sửa lỗi).

## 1.2.0 — 2026-09-27

- **Agent tự đặt lịch ngay trong lúc chat**: người dùng nhắn *"nhắc tôi 8h sáng mai gọi anh Nam"*, *"30 phút nữa báo tôi…"*, *"sáng thứ Hai hằng tuần gửi tôi tóm tắt tin AI"* là agent tự tạo lịch (4 tool mới: `cron_create`, `cron_list`, `cron_update`, `cron_delete`). Tới giờ, agent chạy lại và **gửi kết quả về đúng cuộc trò chuyện** đó — Telegram, Zalo, Discord… (chat riêng hoặc nhóm) hoặc trang Chat trên web. Người dùng cũng hỏi được "tôi đang có lịch nào", nhờ đổi giờ, tạm dừng, hủy. Chi tiết: `docs/lich-hen.md`.
- An toàn: lịch chạy bằng đúng thư mục và quyền của người nhờ đặt lịch; lịch lặp tối thiểu 5 phút, mỗi người tối đa 20 lịch đang bật; người bị gỡ duyệt/gỡ khỏi workspace → lịch tự tắt. Không muốn agent nào tự đặt lịch: Agents → Sửa → bỏ tick `cron_create`.
- **Múi giờ**: khóa cấu hình mới `timezone` (mặc định `Asia/Ho_Chi_Minh`). Giờ trong lịch và ngày "hôm nay" của agent theo múi giờ này thay vì giờ của VPS (VPS để UTC từng lệch 7 tiếng). Lịch tạo trước bản này vẫn chạy như cũ.
- Trang **Cron & lịch hẹn** (trước là "Cron & Heartbeat"): thấy lịch nào do agent tạo, ai nhờ, gửi về đâu, múi giờ; nút Tạm dừng/Bật và Lịch sử chạy. Bật lại lịch không còn chạy bù ngay lượt đã lỡ.
- Sửa lỗi: lượt chạy theo lịch dài hơn 20 giây có thể bị chạy lặp (nhắc hai lần).
- Lịch nhận thêm cách viết `in 30m` (sau 30 phút), `at 28/09/2026 8h30`, `every 2 giờ`.

Cập nhật: `sudo penai update` (có migration `0030` thêm 4 cột vào bảng `cron_jobs`, tự chạy — không phải làm gì thêm; file cấu hình cũ không có `timezone` vẫn dùng giờ Việt Nam). Nếu sau này cần `penai rollback` về 1.1.x: xóa trước các lịch do agent tạo (cột "Tạo bởi" có 🤖) — bản cũ không biết gửi kết quả và chạy chúng như lịch của quản trị viên.

## 1.1.0 — 2026-09-26

- **Hồ sơ contact và chỉ dẫn cho AI theo từng người** (Dashboard → Contacts): mỗi người nhắn tới bot có hồ sơ riêng — tên, cách xưng hô, vai trò, ngôn ngữ, trường tùy chỉnh, nhãn (VIP, Đại lý…) và **chỉ dẫn riêng cho AI**. AI biết đang nói chuyện với ai ngay từ tin nhắn đầu tiên. Nhãn có chỉ dẫn chung cho cả nhóm người. Trong nhóm chat mặc định chỉ dùng tên và cách xưng hô. Trang hồ sơ còn cho xem/sửa file `USER.md` AI ghi về người đó, các ghi nhớ, hội thoại, file, quyền, và **xem trước ngữ cảnh** AI sẽ nhận. Chi tiết: `docs/ho-so-contact.md`.
- Danh sách Contacts có ô tìm kiếm, lọc theo kênh/nhãn và cột trạng thái duyệt.
- Sửa lỗi: agent dùng model ChatGPT họ gpt-6 với Thinking = `minimal` bị lỗi ở mọi tin nhắn — nay tự dùng mức gần nhất model nhận (`low`).
- Lượt chat bị lỗi được ghi vào **Traces** (trước đây chỉ có trong nhật ký máy chủ).
- **Audit log** ghi thêm khi sửa agent (trường nào, provider/model/Thinking mới) và khi sửa hồ sơ, nhãn, `USER.md`.
- Thứ tự lời dặn hệ thống gửi AI: prompt của agent đứng đầu, phần theo người và câu hỏi ở cuối — nhà cung cấp dùng lại được bộ nhớ đệm, chỉ dẫn riêng được ưu tiên.

Cập nhật: `sudo penai update` (có migration `0029` thêm 3 bảng, tự chạy — không phải làm gì thêm).

## 1.0.1 — 2026-09-26

- Trang **Người dùng**: ô mật khẩu khi tạo người dùng và khi đặt lại mật khẩu nay được che ký tự (có nút 👁 để xem khi cần); trình duyệt không còn tự điền mật khẩu của người đang đăng nhập vào các ô này.
- Ẩn mục **Teams** khỏi menu và trang Tổng quan (tính năng vẫn giữ ở phía máy chủ).
- Thêm `scripts/mock-dashboard.ts` để xem thử giao diện Dashboard trên máy mà không cần PostgreSQL.

Cập nhật: `sudo penai update`.

## 1.0.0 — 2026-09-26

Bản phát hành công khai đầu tiên.

- Agent đa vai trò: prompt, model, tool, skill, thư viện file, trí nhớ theo người dùng và theo workspace.
- Provider: ChatGPT (codex), Claude Code, Google Antigravity qua gói thuê bao; OpenAI, Gemini, Qwen, Anthropic và dịch vụ tương thích OpenAI qua API key. Trang Providers luôn hiện đủ ba provider thuê bao, báo rõ "chưa cài CLI / chưa đăng nhập / sẵn sàng".
- Kênh chat: Telegram, Zalo OA, Zalo cá nhân (chế độ an toàn), Microsoft Teams, Discord, Slack, WhatsApp, Feishu, trang Chat trên web.
- Kho tri thức (Vault) có tìm kiếm ngữ nghĩa, bộ sưu tập phân quyền; Knowledge Graph; skill nhiều file có phiên bản; MCP có phân quyền theo agent và người dùng; cron; landing page; thẻ duyệt; API tương thích OpenAI.
- Đăng nhập email + mật khẩu, 4 vai trò, audit log, theo dõi token.
- Thương hiệu cấu hình được (tên, khẩu hiệu, 3 bộ màu, màu riêng, logo riêng) — không cần sửa mã.
- Cài đặt một lệnh (`deploy/install.sh`) và lệnh quản trị `penai`: cập nhật có sao lưu + tự quay lại khi lỗi, rollback, backup/restore, doctor, reset-password, install-cli, auto-update.
