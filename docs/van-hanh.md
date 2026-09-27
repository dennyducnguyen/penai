# Vận hành PenAI bằng lệnh `penai`

Script cài đặt tạo lệnh `/usr/local/bin/penai` trên máy chủ. Mọi lệnh cần `sudo`. Máy có nhiều bản PenAI thì thêm `--instance <tên>` ngay sau chữ `penai`.

| Lệnh | Việc làm |
|---|---|
| `sudo penai status` | Phiên bản đang chạy, trạng thái dịch vụ, bản phát hành mới nhất, RAM/ổ đĩa |
| `sudo penai update` | Cập nhật lên bản phát hành mới nhất |
| `sudo penai rollback` | Quay về bản chạy trước đó |
| `sudo penai backup [--with-data]` | Sao lưu database + cấu hình (+ file người dùng) |
| `sudo penai restore <thư-mục>` | Khôi phục database từ bản sao lưu |
| `sudo penai restart` | Khởi động lại dịch vụ |
| `sudo penai logs [-n 200] [--follow]` | Xem nhật ký |
| `sudo penai doctor` | Kiểm tra sức khỏe: dịch vụ, database, pgvector, sandbox, CLI, nginx, HTTPS, RAM, ổ đĩa |
| `sudo penai reset-password <email>` | Đặt lại mật khẩu đăng nhập Dashboard |
| `sudo penai install-cli claude\|agy\|all [--force]` | Cài/nâng cấp Claude Code CLI, Antigravity CLI |
| `sudo penai auto-update on\|off` | Bật/tắt tự cập nhật (`--channel stable\|main`, `--every 1d`) |
| `sudo penai set-repo <url>` | Đổi nguồn mã (vd bản fork) |
| `sudo penai version` | Phiên bản lệnh và ứng dụng |

## Cập nhật hoạt động thế nào

`sudo penai update` làm tuần tự, bước nào lỗi thì dừng và **bản đang chạy không bị ảnh hưởng**:

1. Tải mã mới từ GitHub, tìm bản phát hành mới nhất (tag `vX.Y.Z`), in danh sách thay đổi, hỏi xác nhận (`--yes` để bỏ qua).
2. **Sao lưu** database + `/etc/penai` vào `/var/backups/penai/<thời-điểm>/` (giữ 7 bản).
3. Giải nén bản mới vào thư mục riêng `/opt/penai/releases/<thời-điểm>-<commit>`, cài thư viện.
4. Nâng cấp database (migration). Migration chỉ **thêm** bảng/cột nên bản cũ vẫn chạy được trên database mới.
5. Trỏ `/opt/penai/app` sang bản mới, khởi động lại dịch vụ, chờ `/healthz` báo đúng phiên bản mới.
6. Bản mới không lên → **tự trỏ về bản cũ** và khởi động lại.
7. Dọn bản cũ, giữ 3 bản gần nhất để `rollback`.

Nhật ký mỗi lần cập nhật: `/var/log/penai/update-<thời-điểm>.log`.

Tùy chọn: `--ref v1.2.0` (cài đúng một phiên bản), `--channel main` (bản đang phát triển — chỉ dùng để thử), `--no-backup`, `--force` (cài lại dù đang là bản mới nhất).

## Sao lưu và khôi phục

```bash
sudo penai backup                 # database + /etc/penai (gồm PENAI_MASTER_KEY)
sudo penai backup --with-data     # thêm file người dùng, thư viện agent, token đăng nhập provider
ls /var/backups/penai/
sudo penai restore /var/backups/penai/20260926-101500
```

`restore` tự sao lưu trạng thái hiện tại trước khi ghi đè, và bắt gõ lại tên bản cài để xác nhận. Nên chép thư mục `/var/backups/penai/` ra ngoài máy chủ định kỳ — sao lưu nằm cùng máy thì mất máy là mất cả sao lưu.

**Chuyển sang VPS mới**: cài PenAI trên máy mới → chép thư mục sao lưu sang → `sudo penai restore <thư-mục>` → chép đè `PENAI_MASTER_KEY` từ `<thư-mục>/etc/penai.env` vào `/etc/penai/penai.env` của máy mới (không có khóa cũ thì token/API key đã lưu không giải mã được) → giải nén `data.tar.gz` (nếu có) vào `/var/lib/penai/` → `sudo penai restart`.

## File cấu hình

`/etc/penai/penai.config.json5` (định dạng JSON5 — cho phép chú thích `//` và dấu phẩy cuối). Phần `providers`, trần đồng thời (`api.queue`), `branding` và `timezone` tự nạp lại khi lưu file; phần khác cần `sudo penai restart`.

`timezone` (từ bản 1.2.0, mặc định `Asia/Ho_Chi_Minh`): múi giờ của lịch hẹn và ngày "hôm nay" của agent — không phụ thuộc giờ của VPS. File cấu hình cài từ bản cũ không có khóa này vẫn dùng giờ Việt Nam. Xem [lich-hen.md](lich-hen.md).

`/etc/penai/penai.env` chứa bí mật. Sửa xong cần `sudo penai restart`. **Không đổi `PENAI_MASTER_KEY`.**
