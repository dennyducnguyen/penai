# Thay đổi qua các phiên bản

Định dạng: mỗi phiên bản một mục, mới nhất ở trên. Số phiên bản theo quy ước `LỚN.VỪA.NHỎ`
(tăng số LỚN khi có thay đổi phải làm thêm bước thủ công lúc nâng cấp; số VỪA khi thêm tính năng;
số NHỎ khi sửa lỗi).

## 1.0.0 — 2026-09-26

Bản phát hành công khai đầu tiên.

- Agent đa vai trò: prompt, model, tool, skill, thư viện file, trí nhớ theo người dùng và theo workspace.
- Provider: ChatGPT (codex), Claude Code, Google Antigravity qua gói thuê bao; OpenAI, Gemini, Qwen, Anthropic và dịch vụ tương thích OpenAI qua API key. Trang Providers luôn hiện đủ ba provider thuê bao, báo rõ "chưa cài CLI / chưa đăng nhập / sẵn sàng".
- Kênh chat: Telegram, Zalo OA, Zalo cá nhân (chế độ an toàn), Microsoft Teams, Discord, Slack, WhatsApp, Feishu, trang Chat trên web.
- Kho tri thức (Vault) có tìm kiếm ngữ nghĩa, bộ sưu tập phân quyền; Knowledge Graph; skill nhiều file có phiên bản; MCP có phân quyền theo agent và người dùng; cron; landing page; thẻ duyệt; API tương thích OpenAI.
- Đăng nhập email + mật khẩu, 4 vai trò, audit log, theo dõi token.
- Thương hiệu cấu hình được (tên, khẩu hiệu, 3 bộ màu, màu riêng, logo riêng) — không cần sửa mã.
- Cài đặt một lệnh (`deploy/install.sh`) và lệnh quản trị `penai`: cập nhật có sao lưu + tự quay lại khi lỗi, rollback, backup/restore, doctor, reset-password, install-cli, auto-update.
