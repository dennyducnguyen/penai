<p align="center">
  <img src="docs/assets/logo.svg" width="96" height="96" alt="PenAI">
</p>

<h1 align="center">PenAI</h1>

<p align="center">Nền tảng AI Agent cho doanh nghiệp — cài trên VPS của bạn, dữ liệu nằm trên máy của bạn.</p>

---

PenAI là hệ thống "trợ lý AI của công ty": bạn tạo các **agent** (trợ lý AI có vai trò riêng), nạp **kho tri thức** của doanh nghiệp, giao **kỹ năng** (skill) và **công cụ** (tool), rồi cho nhân viên/khách hàng trò chuyện qua Dashboard web hoặc các kênh chat quen thuộc.

## Tính năng

- **Agent**: nhiều agent, mỗi agent một vai trò, model, bộ tool, skill, thư viện file và trí nhớ riêng.
- **Nhà cung cấp AI (provider)**:
  - Gói thuê bao: **ChatGPT** (Plus/Pro/Team), **Claude** (Pro/Max qua Claude Code), **Google Antigravity** — đăng nhập ngay trong Dashboard.
  - API key: **OpenAI**, **Gemini**, **Qwen**, **Anthropic**, hoặc bất kỳ dịch vụ tương thích OpenAI (OpenRouter, DeepSeek...).
- **Kênh chat**: Telegram, Zalo OA, Zalo cá nhân, Microsoft Teams, Discord, Slack, WhatsApp, Feishu — cùng trang Chat ngay trong Dashboard.
- **Hồ sơ contact**: mỗi người nhắn tới bot có hồ sơ riêng (tên, cách xưng hô, vai trò, nhãn VIP/Đại lý…) và chỉ dẫn riêng cho AI — AI biết đang nói chuyện với ai và trả lời đúng từng người.
- **Kho tri thức (Vault)**: tải lên PDF/Word/Excel/TXT, tìm kiếm ngữ nghĩa, phân quyền theo bộ sưu tập, agent đọc toàn văn khi tìm trúng tài liệu.
- **Skill & MCP**: nạp skill (thư mục `SKILL.md` + script), kết nối MCP server (Canva, Google, công cụ nội bộ...), phân quyền theo agent và theo người dùng.
- **Lịch hẹn ngay trong lúc chat**: nhắn *"nhắc tôi 8h sáng mai…"*, *"sáng thứ Hai hằng tuần gửi tôi báo cáo…"* là agent tự đặt lịch; tới giờ agent tự chạy và gửi kết quả về đúng cuộc trò chuyện (Telegram, Zalo, trang Chat…). Chi tiết: [docs/lich-hen.md](docs/lich-hen.md).
- **Tool có sẵn**: đọc/ghi file, chạy Python/Node trong sandbox, đọc tài liệu, tạo ảnh, tạo landing page, đặt lịch (cron), gửi thẻ duyệt có nút bấm, xuất link tải công khai có hạn...
- **Quản trị**: tài khoản đăng nhập + 4 cấp quyền, workspace theo bộ phận, nhật ký kiểm tra (audit), theo dõi token, giới hạn hạn mức.
- **API tương thích OpenAI**: phần mềm khác gọi agent PenAI bằng SDK `openai` chính thức.

## Yêu cầu

| | Tối thiểu | Nên dùng |
|---|---|---|
| Hệ điều hành | Ubuntu 22.04/24.04 hoặc Debian 12/13 (máy mới cài) | Ubuntu 24.04 |
| RAM | 2 GB | 4 GB (nếu dùng Claude/Antigravity) |
| Ổ đĩa | 20 GB | 40 GB |
| Tên miền | một tên miền/tên miền phụ trỏ bản ghi **A** về IP của VPS, vd `ai.congty.vn` | |

## Cài đặt

### Cách 1 — nhờ AI cài giúp (khuyên dùng)

1. Tải mã nguồn về máy: `git clone https://github.com/dennyducnguyen/penai.git` rồi mở thư mục bằng Claude Code (hoặc công cụ AI lập trình khác).
2. Dán cho AI câu sau (thay thông tin của bạn):

   > Đọc AGENTS.md rồi cài PenAI lên VPS của tôi: IP `1.2.3.4`, SSH user `root` cổng `22` (khóa SSH ở `~/.ssh/id_ed25519`), tên miền `ai.congty.vn`, email quản trị `admin@congty.vn`.

AI sẽ kiểm tra tên miền, SSH vào VPS, chạy script cài chính thức và báo lại địa chỉ + mật khẩu đăng nhập.

### Cách 2 — tự chạy một dòng lệnh

SSH vào VPS rồi chạy (thay tên miền và email):

```bash
curl -fsSL https://raw.githubusercontent.com/dennyducnguyen/penai/main/deploy/install.sh | sudo bash -s -- --domain ai.congty.vn --email admin@congty.vn --yes
```

Cài xong (khoảng 5–10 phút), màn hình in **địa chỉ đăng nhập và mật khẩu quản trị** — lưu lại ngay. Tùy chọn khác (cổng, nhiều bản cài trên một máy, không dùng tên miền...): xem [docs/cai-dat.md](docs/cai-dat.md).

### Sau khi cài

1. Mở `https://ai.congty.vn`, đăng nhập bằng email + mật khẩu vừa nhận.
2. **Providers** → đăng nhập ChatGPT / Claude / Antigravity, hoặc thêm provider bằng API key.
3. **Agents** → mở agent mẫu "Trợ lý", chọn provider + model bạn có → Lưu.
4. **Chat** để thử; **Channels** để nối Telegram, Zalo, Teams...

## Cập nhật phiên bản mới

```bash
sudo penai update
```

Lệnh tự **sao lưu** dữ liệu, cài bản mới vào thư mục riêng, nâng cấp database, khởi động lại và kiểm tra; bản mới lỗi thì **tự quay về bản cũ**. Hoặc nhờ AI: *"Cập nhật PenAI trên VPS của tôi theo AGENTS.md"*.

Các lệnh vận hành khác (`penai status`, `penai backup`, `penai rollback`, `penai doctor`...): xem [docs/van-hanh.md](docs/van-hanh.md).

## Tùy biến mà không mất khi cập nhật

- **Tên, khẩu hiệu, màu, logo**: sửa khối `branding` trong `/etc/penai/penai.config.json5` rồi tải lại trang.
- **Agent, prompt, skill, MCP, kênh chat, người dùng**: làm trong Dashboard (lưu trong database).
- **Không sửa mã trong `/opt/penai/` trên máy chủ** — mỗi lần cập nhật sẽ bị thay. Muốn sửa mã: fork repo này, sửa trong fork rồi `sudo penai set-repo <url-fork>` (xem [docs/phat-trien.md](docs/phat-trien.md)).

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [AGENTS.md](AGENTS.md) | Hướng dẫn cho AI (Claude Code...) cài đặt, cập nhật, vận hành PenAI |
| [docs/cai-dat.md](docs/cai-dat.md) | Cài đặt chi tiết, mọi tùy chọn, xử lý sự cố |
| [docs/van-hanh.md](docs/van-hanh.md) | Lệnh `penai`: cập nhật, sao lưu, khôi phục, nhật ký, kiểm tra |
| [docs/dang-nhap-nguoi-dung.md](docs/dang-nhap-nguoi-dung.md) | Tài khoản, vai trò, phân quyền |
| [docs/ho-so-contact.md](docs/ho-so-contact.md) | Hồ sơ contact, nhãn, chỉ dẫn cho AI theo từng người |
| [docs/huong-dan-teams-bot.md](docs/huong-dan-teams-bot.md) | Nối Microsoft Teams |
| [docs/zalo-personal.md](docs/zalo-personal.md) | Nối Zalo cá nhân (chế độ an toàn) |
| [docs/api-public.md](docs/api-public.md) · [docs/api-reference.md](docs/api-reference.md) | API tương thích OpenAI |
| [docs/kien-truc.md](docs/kien-truc.md) | Kiến trúc: thành phần, mã nguồn, luồng xử lý, dữ liệu, bản cài trên máy chủ |
| [docs/phat-trien.md](docs/phat-trien.md) | Sửa mã nguồn, chạy test |
| [CHANGELOG.md](CHANGELOG.md) | Thay đổi qua từng phiên bản |

## Lưu ý quan trọng

- **Gói thuê bao cá nhân** (ChatGPT, Claude, Antigravity) được dùng qua công cụ chính thức của từng hãng bằng tài khoản của chính bạn. Hãy đọc điều khoản của nhà cung cấp — nhiều gói cá nhân không cho phép dùng làm máy chủ phục vụ nhiều người. Dùng cho doanh nghiệp nên chọn provider **API key**.
- **Zalo cá nhân** dùng thư viện không chính thức (`zca-js`): tài khoản có thể bị Zalo giới hạn hoặc khóa. Nên dùng tài khoản Zalo riêng cho bot.
- Giữ bí mật file `/etc/penai/penai.env` (chứa khóa mã hóa `PENAI_MASTER_KEY`). **Mất khóa này là mất mọi token/API key đã lưu.** Lệnh `penai backup` sao lưu cả file này.

## Giấy phép

Mã nguồn công khai theo **[Giấy phép PenAI — Học tập và Dùng thử](LICENSE)**:

- ✅ Học tập, nghiên cứu, giảng dạy, dùng cá nhân, cài thử và đánh giá trong doanh nghiệp — **miễn phí**.
- ⚠️ **Dùng thương mại** (vận hành kinh doanh thực tế, cung cấp dịch vụ/cài đặt thu phí, bán lại, đổi thương hiệu để kinh doanh) — **phải được tác giả cho phép bằng văn bản**. Liên hệ: https://github.com/dennyducnguyen

## Ghi nhận

Một số ý tưởng kiến trúc (agent gateway đa kênh, phân quyền skill/MCP theo agent) được tham khảo từ dự án mã nguồn mở [GoClaw](https://github.com/nextlevelbuilder/goclaw). Mã nguồn PenAI được viết mới bằng TypeScript.
