# Quy trình phát hành (dành cho người bảo trì)

## Ba môi trường

| | Nguồn mã | Ai dùng | Cập nhật |
|---|---|---|---|
| Máy phát triển | nhánh `feat/…`, `fix/…` | người bảo trì | tùy ý |
| **Máy demo** của người bảo trì | nhánh `main` | người bảo trì thử | tự động mỗi 5 phút sau khi gộp vào `main` |
| **Máy học viên** | tag phát hành `vX.Y.Z` | học viên | `sudo penai update` khi họ muốn |

Học viên **chỉ nhận tag**, không bao giờ nhận `main` — thứ đang thử dở trên máy demo không lọt tới học viên.

## Làm một thay đổi

1. Tạo nhánh từ `main` mới nhất: `git switch -c feat/ten-viec origin/main`.
2. Sửa mã, chạy `pnpm typecheck` (và `pnpm test` nếu có PostgreSQL + pgvector).
3. Đẩy nhánh, mở pull request. GitHub Actions chạy typecheck + toàn bộ test + kiểm tra script cài.
4. CI xanh → gộp (squash merge) vào `main`.
5. Trong ≤ 5 phút máy demo tự cập nhật (xem: `sudo penai --instance <tên> status`). Thử trên máy demo.

## Phát hành phiên bản cho học viên

Khi máy demo chạy ổn:

1. Tăng `version` trong `package.json` theo quy ước:
   - **NHỎ** (1.0.0 → 1.0.1): sửa lỗi.
   - **VỪA** (1.0.1 → 1.1.0): thêm tính năng, cập nhật không cần làm gì thêm.
   - **LỚN** (1.1.0 → 2.0.0): học viên phải làm thêm bước thủ công khi nâng cấp — ghi rõ các bước trong CHANGELOG.
2. Thêm mục mới ở đầu `CHANGELOG.md`, viết cho học viên đọc (tính năng mới, lỗi đã sửa, việc cần làm).
3. Gộp thay đổi phiên bản vào `main` (qua pull request như trên), chờ máy demo lên đúng bản đó.
4. Gắn tag và tạo bản phát hành:
   ```bash
   git switch main && git pull
   git tag -a v1.1.0 -m "PenAI 1.1.0"
   git push origin v1.1.0
   gh release create v1.1.0 --title "PenAI 1.1.0" --notes-file <(sed -n '/^## 1.1.0/,/^## /p' CHANGELOG.md | sed '$d')
   ```
5. Học viên chạy `sudo penai update` (hoặc nhờ AI) là lên bản mới.

**Sửa lỗi gấp cho bản đã phát hành**: sửa trên `main` như bình thường rồi phát hành bản NHỎ (vd `v1.1.1`). Không sửa lại tag cũ — học viên đã cài tag cũ sẽ không nhận được thay đổi.

## Luật để học viên cập nhật an toàn

1. **Migration chỉ thêm**: bảng mới, cột mới có giá trị mặc định hoặc cho phép NULL. Muốn xóa/đổi tên cột: bản này thêm cột mới + chép dữ liệu; một bản LỚN sau mới xóa cột cũ. Lý do: `penai update` chạy migration khi bản cũ còn đang chạy, và `rollback` không khôi phục database.
2. **Không sửa file migration đã phát hành** — máy đã chạy file đó sẽ không chạy lại. Đặt tên migration mới theo số tiếp theo, giữ nguyên tên các file cũ.
3. **Khóa cấu hình mới phải có giá trị mặc định** trong `packages/shared/src/config.ts` — file cấu hình của học viên không có khóa đó.
4. **Mẫu triển khai** (`deploy/templates/*`) được dựng lại mỗi lần cập nhật (trừ `penai.config.json5` và `nginx.conf` chỉ dùng lúc cài). Thêm biến môi trường bắt buộc mới → phải có giá trị mặc định trong mã, vì `penai.env` cũ không có.
5. `deploy/install.sh` trên `main` là bản học viên tải về khi cài mới, nhưng nó cài **tag mới nhất** — giữ cho `install.sh` luôn cài được tag mới nhất.
6. `deploy/penai` (lệnh quản trị) tự thay bằng bản đi kèm mỗi phiên bản — thay đổi phải tương thích với file `penai-install.conf` của các bản cài cũ.

## Dựng máy demo

Máy demo cài bằng **chính script của học viên** (nhờ vậy mỗi lần phát hành cũng là một lần thử đường cài/cập nhật), chỉ khác là theo nhánh `main` và tự cập nhật:

```bash
... | sudo bash -s -- --domain demo.example.com --email admin@example.com --channel main --auto-update --yes
```

Máy demo chạy chung VPS với hệ thống khác thì thêm `--instance <tên> --new-pg-cluster --db-port 5434 --memory-max 700` để tách hẳn user, thư mục, cụm PostgreSQL và giới hạn RAM.

```bash
sudo penai --instance <tên> status
sudo penai --instance <tên> update --channel main --yes   # cập nhật ngay, không chờ lịch tự động
sudo penai --instance <tên> logs -n 100
```
