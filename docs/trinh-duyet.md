# Trình duyệt cho agent

Agent có thể dùng một **trình duyệt web thật** (Chromium chạy ngầm trên máy chủ, gọi là *headless*: không có cửa sổ) để mở trang, đọc nội dung, cuộn, bấm nút, điền ô nhập và chụp màn hình. Loại trang cần JavaScript mới hiện nội dung (Shopee, Lazada, Tiki, trang quản trị) cũng dùng được — việc mà tool `http_fetch` không làm được.

Trang **Dashboard → 🌐 Trình duyệt** (chỉ quản trị viên `ws_admin`) dùng để:

- xem Chromium đã cài chưa và phiên trình duyệt nào đang mở;
- tạo **hồ sơ trình duyệt**. Mỗi hồ sơ là một bộ cookie đã đăng nhập sẵn các trang (cookie là "vé đăng nhập" trang web lưu trong trình duyệt), để agent vào trang mà không phải đăng nhập lại;
- thêm, xem, xóa cookie và **thử truy cập** (mở trang bằng hồ sơ rồi xem ảnh chụp màn hình).

## Cài đặt

Không phải làm gì thêm. Lần khởi động đầu tiên sau khi cập nhật lên 1.7.0, dịch vụ tự thấy máy chưa có Chromium và **cài chạy nền** trong vài phút (tải khoảng 170 MB vào `/opt/penai-browsers`, dùng chung cho mọi bản cài trên máy). Trong lúc đó, trang Trình duyệt hiện ⏳ *Đang tự cài*.

| Việc | Lệnh trên máy chủ |
|---|---|
| Cài lại / nâng cấp bằng tay | `sudo penai install-browser` (thêm `--force` để cài lại) |
| Kiểm tra | `sudo penai doctor` → dòng "Trình duyệt Chromium cho agent" |
| Nhật ký lần cài | `/var/log/<bản-cài>/browser-setup-*.log` |
| Tắt tự cài | thêm `PENAI_BROWSER_AUTO_INSTALL=0` vào `/etc/<bản-cài>/penai.env` |

Tùy chỉnh (thêm vào `penai.env` rồi chạy `sudo penai restart`; mọi khóa đều có giá trị mặc định):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PENAI_BROWSER_MAX_SESSIONS` | `2` | Số phiên trình duyệt mở cùng lúc. Mỗi phiên tốn khoảng 150–400 MB RAM. Đủ số phiên thì phiên rảnh lâu nhất bị đóng để nhường chỗ |
| `PENAI_BROWSER_IDLE_MIN` | `10` | Phiên rảnh quá số phút này thì tự đóng. Không còn phiên nào thì Chromium tắt hẳn, trả RAM cho máy |
| `CHROME_PATH` | (trống) | Dùng Chrome/Chromium có sẵn trên máy thay cho bản tự cài |
| `PENAI_BROWSER_ALLOW_PRIVATE` | (trống) | `1` = cho agent mở địa chỉ mạng nội bộ (mặc định chặn, xem mục An toàn) |

## Agent dùng thế nào

Tool `browser` (Agents → Cấu hình → danh sách Tools; bỏ tick để cấm agent dùng). Mỗi agent + mỗi người đang chat có **một phiên riêng**, được giữ nguyên giữa các lượt nhắn cho tới khi rảnh quá 10 phút, nên agent làm được nhiều bước liên tiếp:

1. `open` một địa chỉ. Kết quả trả về gồm tiêu đề, vị trí cuộn, **danh sách phần tử bấm/nhập được**, mỗi phần tử có một mã như `[e12]` (★ = đang thấy trên màn hình), và phần chữ của trang.
2. `click` / `type` (gõ chữ, `submit` để nhấn Enter) / `select` theo mã phần tử. Mỗi thao tác trả về trang mới kèm mã **mới**.
3. `scroll` để xem thêm, `text` (kèm `offset`) để đọc tiếp trang dài, `back`, `wait`, `press` (nhấn phím).
4. `screenshot`: ảnh chụp được đưa cho mô hình **xem** (mô hình phải đọc được ảnh, ví dụ ChatGPT/codex) và lưu vào `browser/man-hinh-….jpg` trong thư mục làm việc để gửi cho người dùng bằng `send_file`.
5. `close` khi xong việc.

Người dùng chỉ cần nhắn bình thường, ví dụ: *"Vào tiki.vn tìm trái cây sấy, cho tôi 3 sản phẩm bán chạy kèm giá"*. Agent được dặn phải **hỏi lại trước khi bấm nút có hậu quả thật** (đặt hàng, thanh toán, gửi, xóa, đăng bài), và **dừng lại báo người dùng khi gặp CAPTCHA** (ô xác minh "tôi không phải robot").

## Hồ sơ và cookie

1. Dashboard → Trình duyệt → **＋ Tạo hồ sơ** (ví dụ "Shopee – shop A").
2. Lấy cookie trên máy tính của bạn: cài tiện ích Chrome **Cookie-Editor** → mở trang đã đăng nhập (ví dụ shopee.vn) → Cookie-Editor → **Export → JSON** → dán vào ô trong hộp thoại 🍪 Cookie (hoặc chọn file). Cũng nhận file `cookies.txt` kiểu Netscape, hoặc chuỗi `ten=gia-tri; ...` chép từ DevTools (khi đó nhập thêm ô Tên miền).
3. **Gộp** (mặc định) thì thay cookie cùng tên và giữ cookie khác; **Thay toàn bộ** thì xóa hết cookie cũ của hồ sơ trước.
4. Bấm **Thử truy cập** để xem ảnh chụp: đã đăng nhập chưa, có bị chặn không.
5. Gán cho agent: Agents → Cấu hình → **Hồ sơ trình duyệt**. Agent không có hồ sơ vẫn dùng được trình duyệt, chỉ là chưa đăng nhập trang nào.

Cần biết:

- **Cookie được mã hóa** trong cơ sở dữ liệu bằng `PENAI_MASTER_KEY`. Dashboard chỉ hiện tên, tên miền, hạn và độ dài của cookie, không bao giờ hiện giá trị. Agent dùng cookie nhưng không đọc được giá trị. Mọi lần thêm/xóa đều ghi vào Audit log.
- **Tự lưu cookie mới** (bật mặc định): trang web hay tự làm mới cookie. Khi phiên đóng, cookie mới **của các tên miền đã có trong hồ sơ** được lưu lại (không gom cookie quảng cáo của trang khác), nhờ vậy lượt đăng nhập kéo dài hơn.
- Sửa cookie trong Dashboard thì các phiên đang mở bằng bộ cookie cũ được đóng; lần sau agent dùng sẽ mở lại bằng cookie mới.
- **Đừng bấm Đăng xuất** ở cửa sổ bạn đã lấy cookie: đăng xuất làm cookie trên máy chủ mất hiệu lực. Nên lấy cookie từ một cửa sổ/hồ sơ Chrome riêng.
- Ai có cookie là vào được tài khoản, nên hãy giữ cookie như giữ mật khẩu. Nên dùng tài khoản phụ hoặc tài khoản có quyền hạn chế cho agent.

## Giới hạn: trang chặn truy cập tự động

Một số sàn (đặc biệt **Shopee**) có hệ thống chống robot rất mạnh: xét IP, dấu vân tay trình duyệt, dấu hiệu điều khiển tự động. Khi bị nghi ngờ, trang chuyển sang **trang xác minh / CAPTCHA** ("trượt để hoàn thành câu đố"). PenAI **không vượt CAPTCHA**. Tool nhận ra trang xác minh và dặn agent dừng lại báo người dùng.

Kiểm tra thực tế ngày 01/10/2026:

- Tiki: mở trang, tìm "trái cây sấy", vào trang sản phẩm, đọc giá và chụp màn hình đều chạy tốt.
- Shopee: bị đưa sang trang xác minh ngay từ trang chủ, **kể cả khi có cookie đăng nhập**, và kể cả khi mở bằng trình duyệt thông thường từ cùng mạng. Nguyên nhân là hệ thống chống robot của Shopee, không phải lỗi cookie.

Với dữ liệu của chính shop bạn trên Shopee/Lazada (sản phẩm, đơn hàng, tồn kho), nên dùng **API chính thức** (Shopee Open Platform, Lazada Open Platform) qua MCP hoặc custom tool. API ổn định hơn và không có rủi ro bị khóa tài khoản vì tự động hóa.

## An toàn

- **Chặn mạng nội bộ**: mọi yêu cầu của trang (kể cả ảnh, script) đều được kiểm tra. Địa chỉ `localhost`, `127.0.0.1`, IP mạng riêng (10.x, 192.168.x, 172.16–31.x), địa chỉ metadata đám mây (169.254.x) và tên máy nội bộ đều bị chặn, để trang độc hoặc lời nhắn dụ agent không lợi dụng được trình duyệt đọc dịch vụ nội bộ của máy chủ (kiểu tấn công SSRF). Tắt kiểm tra: `PENAI_BROWSER_ALLOW_PRIVATE=1`.
- Không tải file về, không phát video/âm thanh. Hộp thoại `alert/confirm` của trang tự đóng.
- Chromium chạy bằng user riêng của bản cài, trong giới hạn RAM của dịch vụ (`MemoryMax` nếu bản cài có đặt).
