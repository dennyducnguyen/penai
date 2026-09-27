# Lịch hẹn: agent tự đặt lịch khi chat

Từ phiên bản 1.2.0, người dùng chỉ cần nhắn cho agent (Telegram, Zalo, trang Chat…) là agent tự tạo lịch: **nhắc việc** (một lần) hoặc **báo cáo định kỳ** (lặp lại). Tới giờ, hệ thống chạy lại agent với việc đã hẹn và **gửi kết quả về đúng cuộc trò chuyện đó**.

Tính năng dựa trên cron (bộ chạy việc theo lịch) sẵn có của PenAI; trước bản 1.2.0 chỉ quản trị viên tạo lịch được ở Dashboard và kết quả chỉ lưu trong Dashboard, không gửi đi đâu.

## 1. Người dùng nhắn thế nào

| Người dùng nhắn | Agent làm |
|---|---|
| "Nhắc tôi 8h sáng mai gọi anh Nam về hợp đồng ABC" | Tạo lịch một lần lúc 08:00 ngày mai |
| "30 phút nữa nhắc tôi uống thuốc" | Tạo lịch một lần sau 30 phút |
| "Sáng thứ Hai hằng tuần lúc 8h gửi tôi tóm tắt 5 tin AI nổi bật" | Tạo lịch lặp `0 8 * * 1`; mỗi lần chạy agent tự tìm tin, tóm tắt rồi gửi |
| "Mỗi ngày 17h30 nhắc cả nhóm chốt đơn" (trong nhóm chat) | Tạo lịch lặp, kết quả gửi vào nhóm |
| "Tôi đang có lịch nhắc nào?" | Liệt kê lịch (id, giờ chạy kế tiếp, nơi gửi) |
| "Đổi lịch báo cáo sang 9h" / "Tạm dừng báo cáo sáng thứ Hai" / "Hủy lịch nhắc gọi anh Nam" | Sửa giờ / tạm dừng / xóa lịch |

Tạo xong, agent báo lại thời điểm chạy đầu tiên (vd *"08:00 thứ Hai 28/09/2026, còn 16 giờ 31 phút"*) để người dùng kiểm tra lại. Lịch lặp mà người dùng nói chưa rõ giờ/tần suất thì agent hỏi lại trước khi tạo.

## 2. Tới giờ thì chuyện gì xảy ra

1. Bộ chạy lịch kiểm tra mỗi 20 giây → lịch chạy trễ tối đa khoảng 20 giây.
2. Agent được chạy lại với **nội dung việc đã hẹn** (agent tự viết lúc tạo lịch, đủ ngữ cảnh vì lúc chạy agent không xem lại hội thoại cũ), bằng đúng **thư mục riêng và quyền của người đã nhờ đặt lịch** — không đọc được file của người khác.
3. Câu trả lời của agent được gửi:
   - **Kênh chat** (Telegram, Zalo, Discord…): thành tin nhắn gửi vào đúng cuộc trò chuyện (chat riêng hoặc nhóm), kèm file nếu agent tạo file. Tin này cũng được ghi vào hội thoại, nên người dùng trả lời tiếp ("ok, xong rồi") thì agent biết vừa nhắc gì.
   - **Trang Chat trên web**: thành một phiên chat mới tên **⏰ + tên lịch** trong danh sách phiên của người đó.
4. Lần này không có gì cần báo (vd lịch "chỉ báo khi có đơn mới") → agent trả `NO_REPLY` và hệ thống không gửi tin.
5. Lượt chạy bị lỗi (mô hình AI lỗi, hết hạn mức…) → người dùng nhận một thông báo lỗi (chỉ lần lỗi đầu, không lặp lại mỗi lượt). Lịch một lần kèm luôn nội dung đã hẹn để người dùng vẫn biết việc cần làm.
6. Lịch một lần chạy xong thì tự tắt (vẫn thấy trong Dashboard kèm lịch sử).

## 3. Dạng lịch

Agent tự chuyển lời người dùng sang một trong các dạng dưới — quản trị viên dùng đúng các dạng này khi tạo lịch ở Dashboard.

| Dạng | Ví dụ | Nghĩa |
|---|---|---|
| `in <số><đơn vị>` | `in 30m`, `in 2h`, `in 1d` | Chạy một lần sau khoảng đó (lưu thành thời điểm cụ thể) |
| `at <ngày> <giờ>` | `at 2026-09-28 08:00`, `at 28/09/2026 8h30` | Chạy một lần vào thời điểm đó |
| `every <số><đơn vị>` | `every 30m`, `every 2h`, `every 1d` | Lặp theo chu kỳ |
| cron 5 trường `phút giờ ngày tháng thứ` | `0 8 * * *` · `30 17 * * 1-5` · `0 9 * * 1` · `0 9 1 * *` | 8:00 hằng ngày · 17:30 thứ Hai–thứ Sáu · 9:00 mỗi thứ Hai · 9:00 ngày 1 hằng tháng |

Đơn vị: `s` giây, `m` phút, `h` giờ, `d` ngày. Trong cron, thứ `0` hoặc `7` là Chủ nhật, `1` là thứ Hai.

## 4. Múi giờ

Giờ trong lịch hiểu theo **múi giờ của doanh nghiệp**, khóa `timezone` trong `/etc/<bản-cài>/penai.config.json5` (mặc định `Asia/Ho_Chi_Minh`) — **không** theo giờ của VPS (nhiều VPS để giờ UTC, lệch 7 tiếng so với Việt Nam). Ngày "hôm nay" agent thấy cũng theo múi giờ này.

- Đổi múi giờ: sửa khóa `timezone` (tên theo chuẩn IANA, vd `Asia/Bangkok`), lưu file là tự nạp lại. Lịch đã tạo giữ múi giờ lúc tạo.
- Lịch tạo **trước bản 1.2.0** không ghi múi giờ nên vẫn chạy theo giờ của VPS như trước. Muốn chuyển sang múi giờ doanh nghiệp: tạo lại lịch đó ở Dashboard → Cron & lịch hẹn rồi xóa lịch cũ.

## 5. Giới hạn an toàn

- Lịch lặp **tối thiểu 5 phút** một lần (mỗi lần chạy là một lượt gọi mô hình AI).
- Mỗi người **tối đa 20 lịch đang bật**.
- Người dùng kênh chat chỉ thấy và sửa được lịch của chính mình và lịch gửi về cuộc trò chuyện đang chat. Trong nhóm chat, các thành viên cùng quản lý lịch của nhóm (xem, đổi giờ, tạm dừng, xóa) nhưng **chỉ người tạo mới sửa được nội dung việc** — vì lịch chạy bằng thư mục riêng của người tạo.
- Quản trị viên (vai trò `ws_admin`) chat trên trang Chat thấy và sửa được mọi lịch của agent đó.
- Không tạo lịch được từ: API tương thích OpenAI, chính các lượt chạy theo lịch (lịch không tự đẻ thêm lịch), agent con được ủy quyền.
- Người nhờ đặt lịch bị gỡ duyệt trên kênh, bị gỡ khỏi workspace/khóa tài khoản, hoặc kênh bị xóa → lịch **tự tắt** ở lần chạy kế tiếp. Kênh đang tạm dừng → bỏ qua lượt đó (lịch một lần thử lại mỗi phút trong 30 phút).

## 6. Quản trị viên

- **Dashboard → Cron & lịch hẹn**: mọi lịch của workspace, cột *Tạo bởi* (🤖 agent tạo khi ai nhờ, qua kênh nào) và *Gửi về*, múi giờ, lần chạy kế tiếp; nút **Lịch sử** (kết quả từng lần chạy), **Tạm dừng / Bật**, **Xóa**.
- Không muốn một agent tự đặt lịch: **Agents → Sửa → bỏ tick `cron_create`** (bỏ thêm `cron_update`, `cron_delete` nếu muốn cấm sửa/xóa qua chat).
- Nhật ký kiểm tra (audit log) ghi `cron.agent_create`, `cron.agent_update`, `cron.agent_delete` kèm người nhờ.

## 7. Dành cho người sửa mã

| Phần | Vị trí |
|---|---|
| 4 tool `cron_create`, `cron_list`, `cron_update`, `cron_delete` | `packages/tools/src/builtin/cron.ts` |
| Kiểm tra lịch, giới hạn, phạm vi xem/sửa | `apps/server/src/cron-tools.ts` (bật trong `buildLoopDeps` khi có `cronOrigin`) |
| Chạy lịch, kiểm tra quyền hiện tại, gửi kết quả, chống chạy trùng | `apps/server/src/cron-runner.ts` |
| Tính lịch theo múi giờ (`nextRun`, `normalizeSchedule`, `describeSchedule`) | `packages/core/src/cron.ts` |
| Cột mới của `cron_jobs`: `timezone`, `created_via`, `owner_key`, `origin` | `packages/db/migrations/0030_cron_agent_tool.sql` |
