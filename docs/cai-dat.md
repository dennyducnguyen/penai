# Cài đặt PenAI chi tiết

Tóm tắt nhanh ở [README](../README.md). Tài liệu này giải thích từng bước, mọi tùy chọn và cách xử lý sự cố.

## 1. Chuẩn bị

**VPS**: Ubuntu 22.04/24.04 hoặc Debian 12/13, nên là máy mới cài. RAM tối thiểu 2 GB (script tự tạo swap 2 GB nếu máy chưa có), 4 GB nếu dùng Claude Code/Antigravity (mỗi tiến trình CLI tốn khoảng 220 MB). Ổ đĩa ≥ 20 GB.

**Tên miền**: tạo bản ghi **A** trỏ tên miền (hoặc tên miền phụ như `ai.congty.vn`) về IP của VPS tại nơi bạn quản lý tên miền. Kiểm tra từ máy bất kỳ:

```bash
nslookup ai.congty.vn
```

Kết quả phải là IP của VPS. DNS thường cập nhật sau vài phút (có nơi tới vài giờ).

**Cổng mạng**: nhà cung cấp VPS phải mở cổng **80** và **443** (HTTP/HTTPS) và cổng SSH.

## 2. Chạy script cài

```bash
curl -fsSL https://raw.githubusercontent.com/dennyducnguyen/penai/main/deploy/install.sh | sudo bash -s -- --domain ai.congty.vn --email admin@congty.vn --yes
```

Hoặc clone repo trên VPS rồi `sudo bash deploy/install.sh --domain ... --email ...` (không có `--yes` thì script hỏi xác nhận).

Script làm lần lượt 10 bước và in tiến độ:

1. Kiểm tra hệ điều hành, RAM, ổ đĩa, tên miền; tạo swap nếu thiếu; chọn cổng nội bộ trống (từ 18800).
2. Cài gói hệ thống: git, nginx, certbot, bubblewrap (sandbox cho lệnh agent chạy), Python + thư viện Office, ffmpeg, pandoc.
3. Node.js 24 (bản chính thức, có kiểm tra checksum) vào `/opt/node24`, pnpm vào `/opt/pnpm11`.
4. PostgreSQL 18 + pgvector từ kho chính thức PostgreSQL; tạo database và role `penai_app` với mật khẩu ngẫu nhiên.
5. User hệ thống, thư mục, tải mã nguồn (bản phát hành mới nhất).
6. Sinh bí mật (`/etc/penai/penai.env`) và file cấu hình (`/etc/penai/penai.config.json5`).
7. Cài thư viện, nâng cấp database, tạo và khởi động dịch vụ `penai.service`.
8. Tạo workspace "Công ty", tài khoản quản trị và agent mẫu "Trợ lý".
9. Cài Claude Code CLI và Antigravity CLI (script chính thức của Anthropic và Google).
10. Cấu hình nginx và xin chứng chỉ HTTPS Let's Encrypt (tự gia hạn).

Cuối cùng script in **địa chỉ, email và mật khẩu quản trị** — mật khẩu chỉ hiện một lần.

## 3. Tùy chọn

| Tùy chọn | Ý nghĩa |
|---|---|
| `--domain <tên-miền>` | Tên miền của Dashboard (bắt buộc, trừ khi `--no-nginx`) |
| `--email <email>` | Email tài khoản quản trị + email đăng ký chứng chỉ HTTPS (bắt buộc) |
| `--admin-password <mk>` | Tự đặt mật khẩu quản trị (mặc định sinh ngẫu nhiên) |
| `--instance <tên>` | Tên bản cài (mặc định `penai`) — dùng khi cài nhiều bản trên một máy |
| `--port <cổng>` | Cổng nội bộ của ứng dụng (mặc định: cổng trống đầu tiên từ 18800) |
| `--db-port <cổng>` | Cổng PostgreSQL (mặc định 5432) |
| `--new-pg-cluster` | Tạo cụm PostgreSQL riêng (máy đã có một bản PenAI khác) |
| `--repo <url>` | Kho mã nguồn khác (vd bản fork của bạn) |
| `--ref <tag/nhánh>` | Cài đúng một phiên bản, vd `v1.0.0` |
| `--channel stable\|main` | `stable` = bản phát hành (mặc định); `main` = bản đang phát triển, chỉ để thử |
| `--auto-update` | Bật tự cập nhật theo kênh đã chọn |
| `--memory-max <MB>` | Giới hạn RAM của dịch vụ — nên đặt khi VPS còn chạy việc khác |
| `--skip-cli` | Không cài Claude Code CLI / Antigravity CLI |
| `--with-office` | Cài LibreOffice để agent chuyển Word/Excel/PowerPoint sang PDF |
| `--no-ssl` | Có nginx nhưng không xin HTTPS |
| `--no-nginx` | Không cấu hình nginx (tự lo reverse proxy) |
| `--yes` | Không hỏi xác nhận — bắt buộc khi chạy qua SSH không có bàn phím |

## 4. Cài nhiều bản trên một máy

Các bản PenAI dùng chung tên role database `penai_app`, mà role PostgreSQL là chung cho cả cụm, nên **mỗi cụm PostgreSQL chỉ chứa một bản**. Bản thứ hai:

```bash
... | sudo bash -s -- --instance penai2 --new-pg-cluster --db-port 5434 --domain ai2.congty.vn --email admin@congty.vn --memory-max 700 --yes
```

Mọi thứ của bản `penai2` tách riêng: user `penai2`, `/opt/penai2`, `/etc/penai2`, `/var/lib/penai2`, dịch vụ `penai2.service`, cụm PostgreSQL `18/penai2`. Lệnh quản trị thêm `--instance penai2`.

## 5. Xử lý sự cố khi cài

| Hiện tượng | Nguyên nhân thường gặp → cách xử lý |
|---|---|
| `Chưa hỗ trợ ...` | Hệ điều hành khác Ubuntu/Debian → cài lại VPS bằng Ubuntu 24.04 |
| `Tên miền ... trỏ về ... không phải máy này` | Bản ghi A sai hoặc chưa cập nhật → sửa DNS, chờ, chạy lại lệnh cài |
| `Chưa xin được HTTPS` | DNS chưa trỏ đúng hoặc cổng 80 bị chặn → mở cổng, rồi `sudo certbot --nginx -d <tên-miền>` và sửa `PENAI_PUBLIC_URL` trong `/etc/penai/penai.env` thành `https://...`, rồi `sudo penai restart` |
| `Cụm PostgreSQL ... đã chứa một bản PenAI khác` | Máy đã có PenAI → dùng `--instance` + `--new-pg-cluster` như mục 4 |
| Dừng giữa chừng vì mạng | Chạy lại đúng lệnh cũ — bước đã xong được bỏ qua |
| `bubblewrap không chạy được` | VPS (thường là OpenVZ/LXC) chặn user namespace → lệnh exec của agent chạy không cách ly. Nên đổi sang VPS KVM. Trên Ubuntu 24.04 script tự tạo profile AppArmor `/etc/apparmor.d/penai-bwrap` chỉ cho riêng bubblewrap |
| Cài xong không vào được trang | `sudo penai doctor` để xem mục nào không đạt |

## 6. Gỡ cài đặt

Không có lệnh gỡ tự động (tránh xóa nhầm dữ liệu). Muốn gỡ bản `penai`, sao lưu trước (`sudo penai backup --with-data`), rồi:

```bash
sudo systemctl disable --now penai penai-autoupdate.timer 2>/dev/null
sudo rm -f /etc/systemd/system/penai*.service /etc/systemd/system/penai-autoupdate.timer /usr/local/bin/penai
sudo rm -rf /opt/penai /etc/penai /var/lib/penai
sudo -u postgres dropdb penai
sudo rm -f /etc/nginx/sites-enabled/<tên-miền> /etc/nginx/sites-available/<tên-miền> && sudo systemctl reload nginx
```
