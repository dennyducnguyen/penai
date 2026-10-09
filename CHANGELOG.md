# Thay đổi qua các phiên bản

Định dạng: mỗi phiên bản một mục, mới nhất ở trên. Số phiên bản theo quy ước `LỚN.VỪA.NHỎ`
(tăng số LỚN khi có thay đổi phải làm thêm bước thủ công lúc nâng cấp; số VỪA khi thêm tính năng;
số NHỎ khi sửa lỗi).

## 1.11.0 — 2026-10-09

- **Tên danh bạ ở danh sách chờ duyệt Zalo**: ưu tiên tên bạn lưu, sau đó tên đã đồng bộ và tên người gửi. Đổi hoặc xóa tên rồi đồng bộ sẽ cập nhật cả Inbox và danh sách chờ duyệt; dữ liệu tách riêng theo kênh và workspace.
- **Khách chỉ gửi ảnh**: mặc định xác nhận “Đã nhận hình ạ.” ở ảnh đầu; các ảnh cùng người gửi trong cùng hội thoại cách nhau dưới 30 giây được lưu mà không nhắn lặp. Có yêu cầu kèm ảnh thì AI xử lý bình thường. Inbox → Cài đặt → Khi khách chỉ gửi ảnh cho phép chọn xác nhận ngắn hoặc im lặng.
- **Kết thúc cuộc gọi Zalo**: bỏ qua tín hiệu hệ thống `chat.recommended` / `sendBubbleMessage`, không chạy AI, không coi là file và không tự thả cảm xúc.
- **Gửi bộ ảnh**: các ảnh JPG/PNG/WebP liền nhau trong một lượt gửi được gom thành bộ, tối đa 20 ảnh mỗi bộ và không vượt giới hạn tài khoản. GIF/video/tài liệu gửi riêng. Yêu cầu gửi được điều tiết theo tài khoản, cách nhau ít nhất 0,5 giây; bộ lỗi giữa chừng không tự gửi lại, từng ảnh đã xác nhận được ghi riêng vào Inbox.

Cập nhật: `sudo penai update`. Không cần nâng cấp database hoặc quét lại QR. Bộ ảnh vẫn gồm nhiều yêu cầu gửi bên dưới; điều tiết tốc độ không bảo đảm tài khoản sẽ không bị Zalo giới hạn. Ảnh đã nhận được lưu trên đĩa; AI tự đọc lại tối đa 5 ảnh gần đây trong phiên đang chạy.

## 1.10.0 — 2026-10-09

- **Tên danh bạ Zalo trong Inbox**: ưu tiên tên bạn tự lưu, hiện thêm tên Zalo gốc bên dưới khi khác nhau; tìm kiếm theo cả hai tên.
- Tên danh bạ được lưu riêng, không bị tin nhắn mới ghi đè. Đồng bộ lại để nhận tên mới hoặc xóa tên đã bỏ trên Zalo; lỗi tải danh bạ vẫn giữ tên cũ.

Cập nhật bằng lệnh penai update. Database tự thêm một cột; không cần quét QR lại. Inbox → Đồng bộ danh bạ để tải lại tên nếu cần.

## 1.9.1 — 2026-10-08

Sửa lỗi của kênh WhatsApp cá nhân vừa ra ở 1.9.0. Ai đã tạo kênh WhatsApp nên cập nhật ngay.

- **Bảo mật — khóa mã hóa của WhatsApp không còn bị ghi vào nhật ký máy chủ.** Ở 1.9.0, mỗi lần mở hoặc đóng phiên mã hóa với một người, thư viện WhatsApp in cả khóa của phiên đó vào nhật ký dịch vụ (`journalctl`, chỉ tài khoản root trên máy chủ đọc được). Bản này chặn hẳn các dòng đó. Nếu máy chủ có người khác vào được bằng quyền root hoặc bạn từng gửi nhật ký cho ai, hãy ngắt kết nối WhatsApp (Channels → Kết nối QR → Ngắt kết nối) rồi quét lại để tạo phiên mới.
- **Đặt "số phút AI tạm im" về 0 có hiệu lực ngay.** Trước đây hội thoại vừa có người trả lời tay vẫn im tới hết giờ tạm dừng cũ dù đã đặt về 0 (áp dụng cho cả Zalo cá nhân).
- **Tin cũ của WhatsApp hiện đủ hơn**: tin mẫu của tài khoản doanh nghiệp (mã xác thực, thông báo đơn hàng) và lời mời vào nhóm hiện đúng nội dung thay vì "[Nội dung chưa hỗ trợ hiển thị]"; hội thoại nhập từ tin cũ được điền tên người sau khi WhatsApp gửi danh bạ về.

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm).

## 1.9.0 — 2026-10-08

Bản này thêm kênh **WhatsApp cá nhân** và gộp Inbox thành một nơi dùng chung cho Zalo cá nhân và WhatsApp cá nhân.

- **Kênh WhatsApp cá nhân** (`whatsapp_personal`): nối tài khoản WhatsApp đang dùng trên điện thoại vào PenAI bằng cách quét mã QR (hoặc nhập mã 8 ký tự nếu không quét được) — giống WhatsApp Web, điện thoại vẫn dùng bình thường. Có tin riêng và nhóm, gửi/nhận chữ, ảnh, file, thả cảm xúc. Chế độ an toàn như Zalo cá nhân: mặc định chỉ lưu tin, agent chỉ tự trả lời ở hội thoại bạn chỉ định. Tạo ở Channels → ＋ Thêm kênh → `whatsapp_personal` → Kết nối QR. Đây là kết nối không chính thức: nên dùng số dành riêng và đừng gửi hàng loạt, WhatsApp có thể khóa số. Hướng dẫn: [docs/whatsapp-personal.md](docs/whatsapp-personal.md).
- **Inbox dùng chung**: menu "Inbox Zalo" đổi thành **Inbox**, chọn kênh (Zalo hoặc WhatsApp) ở ô đầu trang. Mọi thứ của Inbox Zalo giữ nguyên. Với WhatsApp, ngay sau khi liên kết PenAI nhập luôn phần tin cũ mà WhatsApp gửi về.
- **MCP cho WhatsApp**: Claude, ChatGPT… hoặc agent của PenAI gửi tin WhatsApp bằng bộ công cụ `whatsapp_…` (cùng cách dùng với `zalo_…`). Kết nối MCP đã tạo từ trước cần **kết nối lại** để được cấp quyền WhatsApp; phần Zalo không bị ảnh hưởng.
- **Phân quyền theo kênh** cho thành viên (Người dùng → Sửa → "Kênh được trực") áp dụng cho cả kênh WhatsApp, cả trong Inbox lẫn qua MCP.
- Loại kênh `zalo` hiển thị là **Zalo OA** cho khỏi nhầm với Zalo cá nhân. Loại `whatsapp` (WhatsApp Cloud API) tạm ẩn khỏi ô Thêm kênh vì chưa hoàn thiện; kênh đã tạo vẫn chạy.
- Địa chỉ API mới `/v1/inbox/…` dùng cho cả hai nền tảng. Địa chỉ `/v1/zalo-inbox/…` và các công cụ MCP `zalo_…` **giữ nguyên**, tích hợp đang chạy không phải sửa gì.

Cập nhật: `sudo penai update`. Có một bước nâng cấp database tự chạy: các bảng Inbox đổi tên từ `zalo_…` sang `inbox_…` (không sao chép, không xóa dữ liệu). Tên cũ vẫn dùng được nên `sudo penai rollback` về bản trước vẫn chạy bình thường. Không phải làm gì thêm; kênh Zalo đang kết nối không cần quét lại.

## 1.8.0 — 2026-10-06

Bản này dành cho ai dùng provider **Claude** (gói Pro/Max qua Claude Code CLI): chạy nhanh hơn, tốn hạn mức ít hơn, và không còn im lặng khi Claude bận hoặc hết hạn mức.

- **Claude tốn hạn mức ít hơn nhiều ở việc nhiều bước** (báo cáo, tra cứu nhiều lần gọi công cụ). Trước đây mỗi bước agent gọi công cụ, PenAI gửi lại toàn bộ cuộc trò chuyện cho Claude như một yêu cầu mới, nên Claude phải đọc lại từ đầu và tính đủ tiền từng lần. Nay các bước sau **nối tiếp phiên của bước trước** và chỉ gửi phần mới. Đo thật với ngữ cảnh khoảng 31 nghìn token: bước sau đọc lại 30,8 nghìn token từ bộ nhớ đệm (tính bằng khoảng 1/10) và chỉ xử lý mới khoảng 500 token, thay vì xử lý mới cả 31 nghìn. Không phải cấu hình gì; lỗi ở phiên cũ thì tự quay về cách gọi cũ.
- **Model dự phòng chạy đúng lúc cần nhất.** Trước đây khi Claude đang bận và yêu cầu phải chờ quá lâu, agent báo lỗi luôn dù đã khai model dự phòng; và khi đã chuyển sang model dự phòng thì lượt đó vẫn chiếm chỗ của Claude. Nay Claude bận quá hạn chờ, lỗi, hay hết hạn mức đều chuyển sang model dự phòng, và lượt chạy ở model dự phòng không còn chiếm chỗ của Claude.
- **Chọn model dự phòng bằng danh sách**: Dashboard → Agents → Cấu hình → mục "Model dự phòng" → ＋ Thêm model dự phòng, chọn provider và model như ô Model chính (trước đây phải gõ JSON). Nên đặt ít nhất một model dự phòng khác provider, ví dụ agent chạy Claude thì dự phòng bằng ChatGPT (codex).
- **Claude chạy 2 yêu cầu cùng lúc**: bản cài mới trên máy từ 4 GB RAM mặc định cho 2 tiến trình Claude song song. Bản đã cài giữ nguyên cấu hình cũ (1). Muốn nâng: `sudo penai cli-concurrency 2`, không cần khởi động lại. Xem số hiện tại và RAM trống: `sudo penai cli-concurrency`. Mỗi tiến trình Claude cần khoảng 220 MB RAM; lệnh sẽ cảnh báo nếu máy không đủ.
- **Máy chủ có CPU kiểu cũ (không có AVX2)**: Claude Code từ sau bản 2.1.112 không chạy được trên các máy này (lỗi "Illegal instruction"), thường gặp ở VPS giá rẻ. Nay `sudo penai install-cli claude` tự nhận ra và cài bản 2.1.112 chạy được; `sudo penai doctor` kiểm tra Claude CLI có thực sự khởi động được không và báo rõ nguyên nhân. Muốn dùng bản Claude Code mới: nhờ nhà cung cấp VPS đổi kiểu CPU của máy ảo sang "host", rồi chạy lại `sudo penai install-cli claude`.

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm). Sau khi cập nhật nên vào Agents → Cấu hình để thêm model dự phòng cho các agent đang chạy Claude.

## 1.7.2 — 2026-10-01

- Sửa lỗi **đăng nhập ChatGPT báo "Link callback thuộc phiên đăng nhập khác (state không khớp)"** khi nhiều người cùng bấm Providers → Đăng nhập (vd cả lớp dùng chung một tài khoản quản trị). Trước đây máy chủ chỉ giữ một phiên đăng nhập, người bấm sau làm hỏng phiên người trước. Nay giữ được nhiều phiên cùng lúc (tối đa 20, mỗi phiên 10 phút), mỗi người dán đúng link của mình là xong.

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm).

## 1.7.1 — 2026-10-01

- Sửa `sudo penai doctor` / `sudo penai install-browser` báo sai "Chromium không khởi động được" trên Ubuntu khi chạy lệnh từ thư mục `/root` (lỗi của bước kiểm tra, trình duyệt của agent vẫn chạy bình thường).

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm).

## 1.7.0 — 2026-10-01

- **Agent dùng trình duyệt thật**: tool `browser` nâng cấp từ "chỉ đọc chữ một trang" thành trình duyệt **giữ trang mở suốt cuộc trò chuyện**. Agent mở trang, đọc danh sách nút/ô nhập/link (mỗi phần tử một mã như `e12`), rồi **bấm, gõ, chọn, cuộn, quay lại, nhấn phím**, và **chụp màn hình để tự xem** (mô hình đọc được ảnh như ChatGPT/codex). Ảnh chụp cũng lưu vào thư mục làm việc để gửi cho người dùng. Chạy được trang cần JavaScript (Tiki, Lazada, trang quản trị…). Agent được dặn hỏi lại trước khi bấm nút có hậu quả thật (đặt hàng, thanh toán, gửi, xóa) và dừng lại khi gặp CAPTCHA.
- **Dashboard → 🌐 Trình duyệt** (quản trị viên): trạng thái Chromium, các phiên đang mở, và **hồ sơ trình duyệt** là bộ cookie đăng nhập sẵn để agent vào trang không cần đăng nhập. Nhập cookie bằng cách dán JSON từ tiện ích Chrome Cookie-Editor, file cookies.txt, hoặc chuỗi `ten=gia-tri`. Xem cookie theo tên miền và hạn, xóa từng cookie / theo tên miền / xóa hết, **Thử truy cập** (mở trang bằng hồ sơ, xem ảnh chụp). Gán hồ sơ ở Agents → Cấu hình → Hồ sơ trình duyệt.
- Cookie **mã hóa** bằng `PENAI_MASTER_KEY`; Dashboard và agent không bao giờ thấy giá trị cookie; mọi lần sửa ghi Audit log. Đóng phiên thì tự lưu lại cookie mới của các tên miền trong hồ sơ, giúp lượt đăng nhập kéo dài hơn.
- An toàn: trình duyệt **chặn mọi truy cập vào mạng nội bộ** (localhost, IP riêng, metadata đám mây), không tải file, không phát video. RAM được giữ trong tầm: tối đa 2 phiên cùng lúc, phiên rảnh 10 phút tự đóng, không còn phiên thì Chromium tắt hẳn (chỉnh bằng `PENAI_BROWSER_MAX_SESSIONS`, `PENAI_BROWSER_IDLE_MIN`).
- Lệnh mới `sudo penai install-browser`; `sudo penai doctor` kiểm tra thêm Chromium.
- Giới hạn đã biết: **Shopee** chặn trình duyệt tự động bằng trang xác minh (CAPTCHA), kể cả khi có cookie. PenAI không vượt CAPTCHA. Dữ liệu shop của bạn nên lấy qua API chính thức.

Chi tiết: `docs/trinh-duyet.md`. Cập nhật: `sudo penai update`. Migration `0033` thêm 1 bảng + 1 cột, tự chạy. **Chromium (~170 MB) tự cài chạy nền trong vài phút** ngay sau khi cập nhật, không phải làm gì thêm. Muốn cài ngay hoặc xem lỗi: `sudo penai install-browser`.

## 1.6.0 — 2026-09-30

- **Contacts ghi đủ người nhắn Zalo cá nhân**: mỗi khi có người nhắn tới (tin riêng, người gửi trong nhóm) và **cả nhóm Zalo**, hệ thống ghi ngay vào Contacts — không còn phụ thuộc việc chỉ định thread demo hay bật agent. Trước đây Contacts trống với Zalo cá nhân vì chỉ ghi người được agent xử lý.
- Trang Contacts: cột **Loại** (👤 Cá nhân / 👥 Nhóm), cột **UID / ID** có nút 📋 sao chép (lấy uid để gửi tin lại), hiện SĐT Zalo nếu có, lọc theo **từng kênh** (thay vì theo loại kênh), tìm được theo SĐT.
- **⬇ Xuất Excel** (Vận hành trở lên): chọn kênh rồi tải file .xlsx đầy đủ — tên, loại, UID, kênh, hồ sơ (xưng hô, SĐT, email, vai trò, nhãn, trường tùy chỉnh, chỉ dẫn AI), trạng thái duyệt, thời gian nhắn. Kênh Zalo cá nhân kèm sheet "Danh bạ Zalo" gồm toàn bộ bạn bè + nhóm đã đồng bộ. UID dài và SĐT có số 0 đầu được giữ nguyên dạng chữ.

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm). Người/nhóm đã nhắn trước bản này sẽ tự vào Contacts ở lần nhắn kế tiếp.

## 1.5.1 — 2026-09-30

- Trang **Channels**: mục "Danh sách kênh" chuyển lên đầu trang (ngay dưới nút ＋ Thêm kênh), các mục chờ duyệt xếp phía dưới.

Cập nhật: `sudo penai update` (không có migration, không phải làm gì thêm).

## 1.5.0 — 2026-09-30

- **Tắt agent mà vẫn giữ kênh**: Channels → Sửa kênh có ô mới **"Agent tự trả lời"** (trên cùng, mặc định có tick). Bỏ tick → AI không trả lời trên kênh đó nhưng kênh vẫn kết nối, Inbox Zalo vẫn lưu/hiện tin, nhân viên vẫn chat tay, MCP vẫn chạy; lịch hẹn agent đã đặt vẫn gửi. Dùng được cho mọi loại kênh.
- **Thả cảm xúc (reaction) Zalo cá nhân**:
  - Trong Inbox: rê chuột vào tin khách → ❤️ 👍 😆 😮 😢 😡 (bấm lại để gỡ); cảm xúc của khách và của mình hiện dưới tin, cập nhật tức thì.
  - Tự thả khi khách nhắn (cả tin riêng và nhóm): Inbox → ⚙️ Cài đặt, **mặc định tắt**, chọn ❤️ hoặc 👍. Thả vào tin cuối mỗi đợt nhắn, có giãn cách để tránh bị Zalo coi là spam.
  - MCP: `zalo_react_latest` (thả vào tin mới nhất của khách trong 1 hội thoại — vd "tìm nhóm X và thả tim tin mới nhất") và `zalo_react_message` (thả vào 1 tin cụ thể). `zalo_get_messages` trả thêm cảm xúc trên từng tin.
- Lưu ý: chỉ thả được vào tin lưu từ bản này trở đi.

Chi tiết: `docs/zalo-inbox-mcp.md`. Cập nhật: `sudo penai update` (migration `0032` thêm 1 bảng, tự chạy — không phải làm gì thêm).

## 1.4.0 — 2026-09-30

- **Ứng dụng AI bên ngoài (Claude, ChatGPT…) đọc được hội thoại Zalo cá nhân qua MCP** — để tra thông tin, làm báo cáo và trả lời vào đúng hội thoại (cá nhân hoặc nhóm). 3 công cụ mới: `zalo_list_conversations` (danh sách hội thoại + tin cuối + số chưa đọc), `zalo_get_messages` (toàn bộ lịch sử tin nhắn của một hội thoại, lấy theo từng đợt tới hết), `zalo_search_messages` (tìm từ khóa trong tin nhắn). Trả lời: `zalo_send_message` với `to` = `thread_id`.
- **Mặc định TẮT**, quản trị bật riêng từng kênh: Inbox Zalo → ⚙️ Cài đặt → "Cho ứng dụng AI bên ngoài (MCP) đọc hội thoại và nội dung tin nhắn". Kết nối cần thêm quyền mới `zalo:messages` trên trang cấp quyền — kết nối tạo từ bản 1.3.0 phải kết nối lại để dùng.
- Trang Kết nối AI bên ngoài hiện kênh nào đang cho AI ngoài đọc tin.

Chi tiết: `docs/zalo-inbox-mcp.md`. Cập nhật: `sudo penai update` (không có migration mới; không phải làm gì thêm).

## 1.3.0 — 2026-09-30

- **Inbox Zalo cá nhân** (Dashboard → 📥 Inbox Zalo): nhiều người dùng PenAI cùng xem và trả lời khách trên kênh Zalo cá nhân, tin mới hiện ngay không cần tải lại trang. Gửi chữ, **gửi ảnh** (chọn file hoặc dán ảnh), nhắn tin mới theo **số điện thoại** / uid / ID nhóm, tìm theo tên – uid – SĐT, lọc cá nhân/nhóm/chưa đọc. Danh bạ bạn bè + nhóm tự kéo về mỗi lần kết nối (nút Đồng bộ danh bạ).
- **AI và nhân viên cùng trực**: nhân viên trả lời (từ Inbox hoặc từ điện thoại) → AI tự im 30 phút trong hội thoại đó (đổi được, 0 = không tạm dừng); nút "Cho AI trả lời lại"; tắt AI riêng cho từng người/nhóm.
- **Phân quyền Inbox**: Quản trị + Vận hành trực mọi kênh Zalo; Thành viên chỉ trực kênh được gán (Người dùng → Sửa → "Kênh Zalo được trực").
- **Kết nối AI bên ngoài (MCP)** — Dashboard → 🔗 Kết nối AI bên ngoài: địa chỉ `https://<tên-miền>/mcp` cho **Claude, ChatGPT**, Cursor… hoặc chính PenAI (trang MCP) kết nối bằng đăng nhập tài khoản Dashboard. Công cụ: xem danh sách người liên hệ/nhóm, tìm người theo SĐT, **gửi tin + ảnh theo uid hoặc số điện thoại**. Ứng dụng AI không đọc được nội dung tin nhắn. Chống gửi trùng khi ứng dụng thử lại, gửi tuần tự 1 tin/2 giây. Xem/thu hồi kết nối và lượt gửi gần đây ngay trên trang này.
- Lưu ý riêng tư: từ bản này kênh Zalo cá nhân **mặc định lưu nội dung mọi tin nhắn** (kể cả tin riêng) để hiện trong Inbox. Không muốn: Inbox Zalo → ⚙️ Cài đặt → bỏ tick "Lưu nội dung tin nhắn". Zalo không cho lấy lịch sử cũ — Inbox có tin từ lúc cập nhật trở đi.

Chi tiết: `docs/zalo-inbox-mcp.md`. Cập nhật: `sudo penai update` (migration `0031` thêm bảng mới, tự chạy — không phải làm gì thêm; địa chỉ MCP dùng `PENAI_PUBLIC_URL` đã có sẵn trong `penai.env`).

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
