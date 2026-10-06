# AGENTS.md — hướng dẫn cho trợ lý AI

Bạn là trợ lý AI (Claude Code, Codex, Cursor…) đang giúp người dùng **cài đặt, cập nhật hoặc vận hành PenAI** trên VPS Linux của họ. Làm đúng các quy trình dưới đây, **đừng tự nghĩ cách triển khai khác** — script chính thức đã xử lý sao lưu, migration, cách ly dịch vụ và tự quay lại khi lỗi.

Trả lời người dùng bằng tiếng Việt; thuật ngữ kỹ thuật lần đầu nhắc tới thì giải thích ngắn trong ngoặc.

## Luật bắt buộc

1. **Chỉ cài bằng `deploy/install.sh`, chỉ vận hành bằng lệnh `penai` trên VPS.** Máy chủ tự tải mã từ GitHub. KHÔNG chép mã từ máy người dùng lên VPS (scp/rsync/sftp): clone trên Windows có thể đổi kiểu xuống dòng làm hỏng script, và dễ kéo theo `node_modules`, `.env`.
2. **KHÔNG sửa file trong `/opt/<bản-cài>/` trên VPS** — mỗi lần cập nhật đều bị thay. Cấu hình nằm ở `/etc/<bản-cài>/penai.config.json5`, bí mật ở `/etc/<bản-cài>/penai.env`.
3. **KHÔNG đổi, xóa hay in ra `PENAI_MASTER_KEY`** (mất khóa = mất mọi token/API key đã lưu). Không in nội dung `penai.env`, token, mật khẩu database vào hội thoại. Ngoại lệ duy nhất: mật khẩu quản trị lúc cài xong — phải báo cho người dùng.
4. **KHÔNG xóa database, KHÔNG chạy `penai restore`** trừ khi người dùng yêu cầu rõ ràng. Trước mọi thao tác rủi ro: `sudo penai backup`.
5. Lệnh chạy qua SSH không có bàn phím → luôn thêm `--yes` (install.sh, `penai update`, `penai rollback`).
6. Thông tin đăng nhập SSH của người dùng chỉ dùng để kết nối — không ghi vào file nào trong repo.
7. Người dùng định dùng PenAI cho **kinh doanh thực tế** (phục vụ khách hàng, thu phí, cài cho khách) → nhắc họ đọc [LICENSE](LICENSE): dùng thương mại cần tác giả cho phép bằng văn bản.

## Quy trình cài mới

**Hỏi đủ thông tin trước khi làm:** IP VPS · cách SSH (user, cổng, đường dẫn khóa hoặc mật khẩu) · tên miền sẽ dùng · email quản trị.

1. **Kiểm tra tên miền** trỏ đúng IP VPS: `nslookup <tên-miền>` (hoặc `dig +short <tên-miền>`). Chưa đúng → hướng dẫn người dùng tạo bản ghi **A** tại nơi quản lý tên miền, trỏ về IP VPS, chờ vài phút rồi kiểm tra lại. DNS sai thì không xin được HTTPS.
2. **Kiểm tra VPS:**
   ```bash
   ssh -p <cổng> <user>@<IP> 'cat /etc/os-release | head -3; free -m; df -h /'
   ```
   Cần Ubuntu 22.04/24.04 hoặc Debian 12/13, RAM ≥ 2 GB (4 GB nếu dùng Claude/Antigravity), ổ trống ≥ 10 GB.
3. **Chạy cài** (5–10 phút — đặt thời gian chờ của lệnh ≥ 15 phút):
   ```bash
   ssh -o ServerAliveInterval=30 -p <cổng> <user>@<IP> 'curl -fsSL https://raw.githubusercontent.com/dennyducnguyen/penai/main/deploy/install.sh | sudo bash -s -- --domain <tên-miền> --email <email> --yes'
   ```
   User là `root` thì bỏ chữ `sudo`. Máy chủ đã có PenAI khác → xem mục "Nhiều bản trên một máy".
4. **Đọc phần cuối kết quả**: địa chỉ Dashboard + email + **mật khẩu quản trị** (chỉ in một lần) → báo ngay cho người dùng và nhắc lưu lại.
5. **Kiểm tra**: `ssh ... 'sudo penai doctor'` → báo kết quả. Mục "CLI claude/agy chưa cài" là cảnh báo nhẹ (chỉ ảnh hưởng provider Claude/Antigravity).
6. **Hướng dẫn người dùng bước tiếp theo trong Dashboard:** Providers → đăng nhập ChatGPT/Claude/Antigravity hoặc thêm API key → Agents → agent "Trợ lý" chọn provider/model → Chat thử → Channels nối Telegram/Zalo/Teams.

Cài bị dừng giữa chừng: đọc thông báo lỗi, sửa nguyên nhân (DNS, mạng, hết ổ đĩa…), rồi **chạy lại đúng lệnh cũ** — các bước đã xong sẽ được bỏ qua.

## Quy trình cập nhật

```bash
ssh ... 'sudo penai status'            # phiên bản đang chạy + bản mới nhất
ssh ... 'sudo penai update --yes'      # sao lưu → cài bản mới → migration → khởi động lại → kiểm tra
ssh ... 'sudo penai status'
```

Báo người dùng: phiên bản cũ → mới và danh sách "Thay đổi" mà lệnh in ra. Nếu `update` báo lỗi: lệnh **đã tự quay về bản cũ** — gửi người dùng thông báo lỗi và 30 dòng cuối của file nhật ký được nhắc tới; **không tự sửa tay trên máy chủ**.

## Việc thường gặp

| Người dùng muốn | Lệnh / cách làm |
|---|---|
| Quên mật khẩu đăng nhập | `sudo PENAI_USER_PASSWORD='<mk-mới>' penai reset-password <email>` (có bàn phím thì bỏ biến, lệnh sẽ hỏi) |
| AI trả lời riêng theo từng người (xưng hô, chỉ dẫn, nhãn VIP/đại lý…) | Dashboard → Contacts → bấm vào người → tab "Hồ sơ & chỉ dẫn"; nhãn dùng chung: nút 🏷️ Quản lý nhãn (ws_admin). Chi tiết: [docs/ho-so-contact.md](docs/ho-so-contact.md) |
| AI tự nhắc việc / gửi báo cáo định kỳ | Người dùng nhắn thẳng cho agent ("nhắc tôi 8h sáng mai…", "sáng thứ Hai hằng tuần gửi tôi…") — agent tự đặt lịch, tới giờ gửi kết quả về cuộc trò chuyện đó. Xem/tạm dừng/xóa: Dashboard → Cron & lịch hẹn. Cấm một agent tự đặt lịch: Agents → Sửa → bỏ tick `cron_create`. Múi giờ: khóa `timezone` trong `penai.config.json5` (mặc định `Asia/Ho_Chi_Minh`). Chi tiết: [docs/lich-hen.md](docs/lich-hen.md) |
| Zalo cá nhân (tóm tắt — chi tiết [docs/zalo-personal.md](docs/zalo-personal.md)) | Kết nối: Channels → ＋ Thêm kênh `zalo_personal` → Kết nối QR. Agent chỉ tự trả lời thread "Chỉ định demo" (hoặc mọi tin riêng nếu bỏ tick "Yêu cầu pairing"); tắt hẳn agent mà vẫn giữ kênh: Channels → Sửa → bỏ tick "Agent tự trả lời". Trực chat: Dashboard → 📥 Inbox Zalo (member cần được gán kênh: Người dùng → Sửa); ⚙️ Cài đặt của Inbox: lưu nội dung, phút AI tạm im, tự thả cảm xúc, cho AI ngoài đọc tin. Contacts tự ghi người/nhóm nhắn tới, có UID + nút ⬇ Xuất Excel. Claude/ChatGPT gửi tin/ảnh Zalo: địa chỉ MCP ở Dashboard → 🔗 Kết nối AI bên ngoài (cần `PENAI_PUBLIC_URL` trong `penai.env` — bản cài có sẵn) |
| Agent mở trình duyệt xem/thao tác trang web (Shopee, Tiki, trang quản trị…), đăng nhập sẵn bằng cookie | Dashboard → 🌐 Trình duyệt → ＋ Tạo hồ sơ → 🍪 Cookie (dán JSON từ tiện ích Cookie-Editor) → Thử truy cập; gán hồ sơ ở Agents → Cấu hình → Hồ sơ trình duyệt. Chromium tự cài chạy nền sau khi cập nhật; cài tay/kiểm tra: `sudo penai install-browser`, `sudo penai doctor`. Shopee thường bắt CAPTCHA với trình duyệt tự động (không vượt được). Chi tiết: [docs/trinh-duyet.md](docs/trinh-duyet.md) |
| Đổi tên hiển thị, khẩu hiệu, màu | Sửa khối `branding` trong `/etc/<bản-cài>/penai.config.json5` (định dạng JSON5), tải lại trang là thấy. `theme`: `xanh-duong`, `tim`, `xanh-ngoc`; màu riêng `primaryColor: "#rrggbb"` |
| Dùng logo riêng | Chép ảnh lên máy chủ: `sudo install -m 0640 -o root -g <bản-cài> logo.png /etc/<bản-cài>/logo.png`, thêm `logoFile: "/etc/<bản-cài>/logo.png"` vào `branding` |
| Dùng provider Claude / Antigravity | `sudo penai install-cli claude` / `sudo penai install-cli agy`, rồi Dashboard → Providers → Đăng nhập |
| Claude báo lỗi "Illegal instruction" / không chạy sau khi cài | CPU của VPS không có tập lệnh AVX2 (kiểu CPU ảo hóa cũ). `sudo penai install-cli claude` tự cài bản 2.1.112 chạy được; `sudo penai doctor` báo rõ. Muốn bản mới: nhờ nhà cung cấp VPS đổi kiểu CPU sang "host" rồi chạy lại lệnh cài |
| Claude chậm vì nhiều người/kênh/lịch hẹn dùng cùng lúc ("Chờ quá … trong hàng đợi") | Xem: `sudo penai cli-concurrency`. Nâng số tiến trình Claude chạy song song: `sudo penai cli-concurrency 2` (mỗi tiến trình ~220 MB RAM, không cần khởi động lại). Và đặt model dự phòng (dòng dưới) |
| Bot im lặng khi Claude hết hạn mức hoặc quá tải | Dashboard → Agents → Cấu hình → "Model dự phòng" → ＋ Thêm model dự phòng (nên khác provider, vd agent Claude thì dự phòng bằng `codex`). Model chính lỗi, hết hạn mức hoặc chờ quá lâu thì tự chuyển |
| Xem lỗi | `sudo penai logs -n 200` |
| Sao lưu thủ công | `sudo penai backup` (thêm `--with-data` để lấy cả file người dùng) |
| Quay về bản trước | `sudo penai rollback --yes` |
| Khôi phục dữ liệu | `sudo penai restore /var/backups/<bản-cài>/<thời-điểm> --yes` — CHỈ khi người dùng yêu cầu rõ |
| Tự cập nhật hằng ngày | `sudo penai auto-update on --every 1d` |
| Dùng bản fork của họ | `sudo penai set-repo https://github.com/<họ>/penai.git` rồi `sudo penai update --channel main --yes` |
| Đổi tên miền | Trỏ DNS tên mới → `sudo certbot --nginx -d <tên-mới>` → sửa `PENAI_PUBLIC_URL` trong `/etc/<bản-cài>/penai.env` và `PUBLIC_URL` trong `/etc/<bản-cài>/penai-install.conf` → `sudo penai restart` |

### Nhiều bản trên một máy

Mỗi cụm PostgreSQL chỉ chứa **một** bản PenAI (các bản dùng chung tên role `penai_app`). Bản thứ hai cần tên riêng và cụm PostgreSQL riêng:

```bash
... | sudo bash -s -- --instance penai2 --new-pg-cluster --db-port 5434 --domain <tên-miền-2> --email <email> --yes
```

Sau đó mọi lệnh thêm `--instance penai2`: `sudo penai --instance penai2 status`.

## Bản đồ trên máy chủ (bản cài mặc định tên `penai`)

| Đường dẫn | Nội dung | Cập nhật có đụng tới? |
|---|---|---|
| `/opt/penai/app` → `/opt/penai/releases/<thời-điểm>-<commit>` | Mã đang chạy (giữ 3 bản gần nhất) | Thay mới |
| `/opt/penai/repo.git` | Bản sao kho mã GitHub | Tải thêm |
| `/etc/penai/penai.config.json5` | Cấu hình: provider, trần đồng thời, thương hiệu, múi giờ | Không |
| `/etc/penai/penai.env` | Bí mật: kết nối DB, `PENAI_MASTER_KEY`, địa chỉ công khai | Không |
| `/etc/penai/penai-install.conf` | Thông tin bản cài (nguồn mã, cổng, database) | Không |
| `/var/lib/penai/` | Dữ liệu: file người dùng, thư viện agent, token đăng nhập provider, CLI | Không |
| PostgreSQL database `penai` | Agent, hội thoại, kho tri thức, người dùng… | Chỉ migration thêm bảng/cột |
| `/var/backups/penai/` | Bản sao lưu (giữ 7 bản) | Tạo mới trước mỗi lần cập nhật |
| `/var/log/penai/` | Nhật ký các lần cập nhật | Tạo mới |
| Dịch vụ `penai.service` | Tiến trình Node chạy ứng dụng | Khởi động lại |

## Khi người dùng muốn sửa mã nguồn

Đọc [docs/kien-truc.md](docs/kien-truc.md) để nắm cấu trúc hệ thống trước khi sửa. Hướng dẫn họ **fork** repo, sửa trong fork, chạy test theo [docs/phat-trien.md](docs/phat-trien.md), rồi trỏ máy chủ sang fork (`penai set-repo`). Quy tắc cho mọi thay đổi mã:

- Migration SQL **chỉ thêm** (bảng mới, cột có giá trị mặc định); không sửa file migration đã có.
- Khóa cấu hình mới phải có giá trị mặc định.
- `apps/server/src/ui.ts` là JavaScript thuần trong template literal — chạy `pnpm test` (có test dịch thử toàn bộ script) trước khi đẩy.
- Chỉ `packages/db` được viết SQL; mọi bảng theo workspace phải có RLS.
- Dùng `pnpm`, không dùng `npm`.

## Dành cho người bảo trì bản chính thức

Quy trình phát triển → thử trên máy demo → phát hành phiên bản: [docs/phat-hanh.md](docs/phat-hanh.md).
