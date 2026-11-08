# Dùng HoiAI làm nhà cung cấp AI

[HoiAI](https://chat.hoiai.vn) là cổng AI: **một tài khoản** dùng cho

- **chat** — đọc chữ, **ảnh** và **tin nhắn thoại** (âm thanh);
- **embedding** (biến văn bản thành vector để tìm kiếm theo nghĩa) — dùng cho Kho tri thức;
- **tạo ảnh / sửa ảnh theo ảnh mẫu**.

Tính tiền bằng credit trả trước trên tài khoản HoiAI.

## Kết nối (khuyên dùng): đăng nhập bằng mã kích hoạt

1. Dashboard → **Providers** → **＋ Kết nối HoiAI**.
2. Bấm **Mở trang kích hoạt** → đăng nhập HoiAI (chưa có tài khoản thì đăng ký ngay tại đó).
3. Kiểm tra mã trên trang HoiAI **trùng** với mã PenAI đang hiện (dạng `ABCD-1234`) → bấm **Đồng ý**.
4. Hộp thoại PenAI tự chuyển sang "Đã kết nối". Provider tên `hoiai` được tạo sẵn với model chat mặc định và model embedding (nếu workspace chưa có embedding mặc định thì dùng luôn HoiAI).
5. **Agents** → chọn provider `hoiai` cho agent → Lưu.

Cách này không cần PenAI có tên miền hay HTTPS: HoiAI không chuyển trình duyệt về PenAI, PenAI tự hỏi HoiAI vài giây một lần cho tới khi bạn bấm Đồng ý (mã hết hạn sau 10 phút).

> Chỉ bấm **Đồng ý** khi chính bạn vừa bấm Kết nối trong PenAI. Ai đó gửi mã cho bạn nhờ "đồng ý giúp" là họ đang xin dùng credit của bạn.

## Kết nối bằng API key

Đã có khóa `hk_live_…` (tạo ở trang tài khoản HoiAI): Providers → **＋ Kết nối HoiAI** → **Đã có API key HoiAI? Dán khóa** → dán khóa → **Kiểm tra key & tải model** → chọn model → **Thêm provider**. Base URL để trống (mặc định `https://chat.hoiai.vn/api/v1`).

## Quản lý

Hàng `hoiai` trong trang Providers:

| Nút | Việc |
|---|---|
| **Tài khoản** | Email, credit còn lại, link **Nạp credit**, các model khóa được dùng |
| **Đăng nhập lại** | Lấy khóa mới (vd khóa bị thu hồi), giữ nguyên model đã chọn |
| **Cấu hình** | Đổi model chat / embedding mặc định |
| **Ngắt kết nối** | Thu hồi khóa phía HoiAI rồi xóa provider khỏi PenAI (agent đang dùng thì phải đổi provider trước) |

## Tin nhắn thoại

Khi model của agent nhận âm thanh (HoiAI khai báo trong danh sách model), tin nhắn thoại từ **Telegram, Zalo cá nhân, WhatsApp cá nhân** được gửi thẳng cho model nghe và trả lời. Model không nghe được thì AI lịch sự đề nghị người dùng nhắn chữ (như trước).

## Lỗi thường gặp

| Thông báo | Cách xử lý |
|---|---|
| "Hết credit HoiAI" | Nạp thêm credit trên HoiAI (nút Tài khoản → Nạp credit) |
| "Khóa HoiAI không hợp lệ hoặc đã bị thu hồi" | Providers → hàng `hoiai` → **Đăng nhập lại** |
| "Mã kích hoạt đã hết hạn" | Bấm **Lấy mã mới**, làm lại trong 10 phút |
| "Bạn đã bấm Từ chối" | Bấm **Lấy mã mới** |

Người bảo trì muốn trỏ sang máy thử của HoiAI: đặt `PENAI_HOIAI_BASE_URL=https://.../api/v1` trong `penai.env` rồi `sudo penai restart` (chỉ ảnh hưởng kết nối mới; provider đã tạo giữ base URL đã lưu).
