# Facebook Fanpage và Instagram trong PenAI

Có từ bản **1.19.0** (qua hub); **1.20.0** thêm app Facebook riêng, bình luận và MCP "PenAI Kênh". Mỗi **Fanpage Facebook** (Messenger) hoặc **tài khoản Instagram Business** (tin nhắn Direct) là một kênh của PenAI, gắn **một agent riêng**. Khách nhắn vào Trang → agent trả lời; mọi tin đến/đi nằm trong **📥 Inbox** để nhân viên cùng theo dõi, trả lời tay, bật/tắt AI theo từng khách.

Có **hai cách nối**, chọn theo từng Trang:

- **Qua hub** (mặc định chat.hoiai.vn): không cần tự tạo Meta App (ứng dụng trên Meta for Developers) — hub giữ app, lo phần Meta duyệt. Mục 1. Bản fork tự dựng hub riêng thì đổi biến `PENAI_META_HUB_URL` (mục 6).
- **App Facebook riêng**: tự tạo app ở developers.facebook.com, tự cấp quyền cho Trang mình quản trị — không phụ thuộc ai. Mục 7.

| Tính năng | Mục |
|---|---|
| Kết nối 1 chạm qua popup, hoặc dán mã `hfb_…` / `hig_…` | [1](#1-kết-nối-trang) |
| Agent tự trả lời: chữ, ảnh, file; hiệu ứng "Đã xem" + "Đang soạn…" | [2](#2-agent-trả-lời) |
| Inbox: xem hội thoại, trả lời tay, tắt AI theo khách, tên + ảnh đại diện khách | [3](#3-inbox) |
| Biết **người trả lời ở nơi khác** (Meta Business Suite, ứng dụng Trang, app khác) → hiện trong Inbox, AI tự tạm im | [4](#4-người-trả-lời-ngoài-penai) |
| Quy tắc 24 giờ của Meta | [5](#5-giới-hạn-của-meta) |
| Cách hoạt động, hợp đồng với hub | [6](#6-cách-hoạt-động-cho-người-sửa-mã) |
| **App Facebook riêng** — tự tạo app, tự cấp quyền, không qua hub | [7](#7-app-facebook-riêng) |
| **Bình luận**: vào Inbox theo bài viết, AI trả lời công khai + nhắn riêng, nhân viên trả lời từ Inbox | [8](#8-bình-luận) |
| **MCP "PenAI Kênh"**: một bộ công cụ cho mọi kênh — nhắn tin, đăng bài, bình luận, số liệu; agent PenAI và Claude/ChatGPT cùng dùng | [9](#9-mcp-penai-kênh) |

---

## 1. Kết nối Trang

**Chuẩn bị (làm một lần):**

1. Tạo tài khoản tại **https://chat.hoiai.vn**, vào mục **Facebook** → kết nối Facebook → chọn các Fanpage cần dùng. Trang có tài khoản Instagram Business liên kết thì Instagram tự hiện kèm.
2. Máy chủ PenAI phải có `PENAI_PUBLIC_URL` trong `/etc/<bản-cài>/penai.env` (bản cài bằng `install.sh` đã có sẵn) — hub dùng địa chỉ này để gửi tin về.

**Tạo kênh:** Dashboard → **Channels** → **＋ Thêm kênh** → loại **Facebook Fanpage** (hoặc **Instagram**) → chọn **agent** →

- **Cách 1 — Kết nối nhanh với HoiAI** (khuyên dùng): bấm nút → cửa sổ hub mở ra (đăng nhập chat.hoiai.vn nếu chưa) → chọn Trang → **Cấp quyền cho PenAI** → cửa sổ tự đóng, PenAI nhận mã.
- **Cách 2 — Dán mã**: trên chat.hoiai.vn/facebook bấm **Copy mã Fanpage (`hfb_…`)** hoặc **Copy mã Instagram (`hig_…`)**, dán vào ô mã. Hợp khi người cài khác người giữ tài khoản Facebook.

→ **Tạo kênh**. PenAI tự đăng ký địa chỉ nhận tin của kênh với hub; tên kênh mặc định là tên Trang / `@tên-instagram`.

> ⚠️ **Mã kết nối là chìa khóa của Trang** (bên trong có token truy cập Trang). Đừng gửi mã qua nhóm chat công khai; lỡ lộ thì vào chat.hoiai.vn tạo lại secret cho Trang rồi kết nối lại.

**Mỗi Trang một agent:** một Fanpage và tài khoản Instagram của nó là **hai kênh riêng**, gắn được hai agent khác nhau. Đổi agent: Channels → **Sửa**.

**Kết nối lại** (Trang đổi quyền, hub cấp lại secret, báo token hết hạn…): Channels → dòng kênh → **Kết nối Trang** → Kết nối nhanh hoặc dán mã mới → **Kết nối lại**. Dán mã của một Trang đã có kênh ở ô "Thêm kênh" cũng tự cập nhật đúng kênh cũ, không tạo kênh trùng. Nút **Đăng ký lại với hub** dùng khi hub tạm lỗi lúc tạo kênh.

Hộp thoại **Kết nối Trang** cho biết: trạng thái token, đã đăng ký với hub chưa, lúc nhận tin gần nhất từ hub, địa chỉ nhận tin.

**Một Trang chỉ gửi tin về một nơi.** Nối cùng Trang vào bản PenAI thứ hai thì bản đầu thôi nhận tin.

## 2. Agent trả lời

- Khách nhắn → khi agent bắt đầu xử lý, khách thấy **"Đã xem"** và **"Đang soạn…"** (lặp lại mỗi 15 giây tới khi trả lời xong).
- Câu trả lời gửi dạng chữ trơn (Messenger/Instagram không hiện Markdown), tự cắt đoạn 2.000 ký tự (Facebook) / 1.000 ký tự (Instagram). Câu dẫn trước khi agent dùng tool ("Để em kiểm tra…") là một tin riêng.
- **Ảnh khách gửi**: agent xem được ảnh. Mặc định **AI trả lời luôn** khi khách chỉ gửi ảnh (khách Fanpage hay gửi ảnh sản phẩm để hỏi). Đổi ở Inbox → ⚙️ Cài đặt → "Khi khách chỉ gửi ảnh" (xác nhận ngắn / im lặng). File (PDF, Excel…) agent đọc được; video, tin nhắn thoại agent chưa xem/nghe được — agent được dặn hỏi lại khách.
- **Agent gửi file** (`send_file`, ảnh tạo ra…): Facebook tải thẳng file lên Messenger (≤ 25 MB). Instagram chỉ nhận ảnh/video/âm thanh qua đường link nên PenAI tạo link công khai có hạn 7 ngày; tài liệu (PDF…) gửi dạng link.
- **Pairing** (duyệt người lạ) mặc định **tắt** với kênh Fanpage — khách lạ nhắn tới là chuyện thường. Bật lại ở Channels → Sửa nếu muốn.
- Tắt hẳn AI mà vẫn nhận tin vào Inbox: Channels → Sửa → bỏ tick **Agent tự trả lời**.
- Lịch hẹn (`cron_*`) và quy trình gửi được về hội thoại Fanpage, nhưng chỉ trong 24 giờ kể từ tin cuối của khách (mục 5).

## 3. Inbox

Dashboard → **📥 Inbox** → chọn kênh Facebook/Instagram ở ô trên cùng.

- Danh sách khách đã nhắn (tên + ảnh đại diện lấy từ Meta), số tin chưa đọc, realtime.
- Mỗi tin ghi rõ ai gửi: khách · **🤖 AI** · **👤 Nhân viên** (trả lời từ PenAI, kèm tên) · **🧑‍💼 Người trả lời qua Meta Business Suite / ứng dụng khác** (mục 4).
- Trả lời tay: gõ chữ, dán/đính ảnh → gửi ngay qua Messenger/Instagram.
- **AI trả lời: Tắt cho hội thoại này** — dùng khi nhân viên tự lo khách đó.
- Nhân viên trả lời → AI **tạm im** trong hội thoại đó `N` phút (mặc định 30, đổi ở ⚙️ Cài đặt; 0 = không tạm dừng). Nút **Cho AI trả lời lại** bỏ tạm dừng ngay.
- Không có "Nhắn tin mới" và "Đồng bộ danh bạ" với Fanpage/Instagram — Meta chỉ cho Trang trả lời người đã nhắn tới.
- Thành viên (role `member`) chỉ thấy kênh được gán: **Người dùng → Sửa** → tick kênh.
- Contacts ghi mọi khách nhắn tới (PSID/IGSID — mã khách do Meta cấp riêng cho từng Trang), xuất Excel được.

## 4. Người trả lời ngoài PenAI

Mỗi khi Trang gửi một tin — từ PenAI, từ **Meta Business Suite**, ứng dụng **Trang** trên điện thoại hay một ứng dụng chat khác — Meta gửi lại một bản sao gọi là **tin dội lại** (echo). PenAI dùng nó để:

1. Nhận ra tin **không phải PenAI gửi** (so với mã các tin PenAI vừa gửi; chờ 2,5 giây phòng khi kết quả gửi về chậm).
2. Ghi tin đó vào Inbox, nguồn **🧑‍💼 Người trả lời qua …**: "Meta Business Suite / hộp thư Trang" (ứng dụng của Meta) hoặc "ứng dụng khác (app …)".
3. Coi như nhân viên đã trả lời → **AI tạm im** trong hội thoại đó theo số phút ở Cài đặt, giống khi trả lời từ Inbox.

Lưu ý:

- Meta **không cho biết tên người** bấm gửi trong Business Suite — Inbox chỉ ghi được nguồn.
- **Tin nhắn tự động của Meta** (tin chào, trả lời nhanh cài trong Business Suite) cũng là tin dội lại từ ứng dụng của Meta → cũng làm AI tạm im. Dùng AI của PenAI thì nên tắt các tin tự động đó, hoặc đặt "AI tạm im" = 0.
- Instagram: tin gửi từ ứng dụng Instagram trên điện thoại cũng được nhận ra như trên.

## 5. Giới hạn của Meta

- **24 giờ**: Trang chỉ được nhắn cho khách trong 24 giờ kể từ tin cuối của khách. Quá hạn, PenAI báo lỗi rõ ("Đã quá 24 giờ…"). Nhân viên trả lời từ Inbox khi quá 24 giờ: PenAI thử gửi kèm thẻ **HUMAN_AGENT** (Meta cho người thật trả lời trong 7 ngày) — chỉ được nếu Meta App của hub đã được Meta duyệt tính năng Human Agent.
- Không nhắn chủ động cho người chưa từng nhắn Trang.
- Instagram: tin tối đa 1.000 ký tự; tài khoản phải là Instagram **Business/Creator** liên kết với Fanpage, và bật "Cho phép truy cập tin nhắn" trong cài đặt quyền riêng tư của Instagram.
- Khi Meta App của hub chưa được Meta duyệt quyền nâng cao, chỉ người có vai trò trong app (quản trị, nhà phát triển, người thử) mới nhắn thử được.

## 6. Cách hoạt động (cho người sửa mã)

```
Khách ──Messenger/IG──► Meta ──webhook──► hub (chat.hoiai.vn) ──POST + chữ ký──► PenAI /webhooks/meta/<kênh>
                                                                                   │ lưu Inbox, chạy agent
PenAI ──────────── Graph API (Page Access Token) ─────────────► Meta ──► Khách ◄──┘
```

| Thành phần | Mã |
|---|---|
| Adapter kênh (`facebook`, `instagram`): đọc webhook, chữ ký, gửi tin/file, typing, làm mới token, nhận diện tin dội lại | `packages/channels/src/meta-page.ts` |
| Kênh có Inbox dùng chung (Zalo, WhatsApp, Facebook, Instagram) | `packages/channels/src/inbox-channel.ts`, `apps/server/src/inbox.ts` |
| API kết nối, đăng ký với hub, route webhook (đọc body gốc) | `apps/server/src/meta-channels.ts` |
| App Facebook riêng: đăng nhập Facebook, chọn Trang, webhook thẳng từ Meta | `apps/server/src/meta-apps.ts`, bảng `meta_apps` (migration 0038) |
| MCP "PenAI Kênh" + kết nối nội bộ | `apps/server/src/mcp-channel-tools.ts`, `createInternalMcpServer` trong `mcp-server.ts`, `InternalMcpConnection` trong `mcp-manager.ts` |

**Lưu trữ:** `channels.token_encrypted` = JSON `{pageAccessToken, penaiSecret}` mã hóa AES-256-GCM; `channels.config` = thông tin Trang (`pageId`, `pageName`, `igAccountId`, `igUsername`…), địa chỉ API của hub, kết quả đăng ký — không chứa bí mật. Không có migration: tin nhắn dùng các bảng `inbox_*` sẵn có. `threadId`/`chatKey` = PSID/IGSID của khách.

**Cấu hình:** `PENAI_META_HUB_URL` (mặc định `https://chat.hoiai.vn`) trong `penai.env`. PenAI chỉ nhận mã kết nối có địa chỉ API **cùng gốc** với hub này (chặn mã giả dẫn bí mật ra nơi khác).

### Hợp đồng với hub

Hub tự dựng (bản fork) cần làm đúng các điểm sau:

1. **Trang cấp quyền** `GET <hub>/facebook/penai-connect?platform=facebook|instagram|all&state=<ngẫu nhiên>&origin=<gốc PenAI>&app_name=<tên>` mở trong popup; xong thì `window.opener.postMessage({type:"HOIAI_PENAI_CONNECTED", platform, connect_code, page_id, page_name, ig_account_id, ig_username, state}, <origin>)`. PenAI chỉ nhận tin từ đúng gốc của hub và đúng `state`.
2. **Mã kết nối**:
   - `hfb_` / `hig_` + base64url của JSON `{platform, page_id, page_name, avatar_url, ig_account_id, ig_username, ig_name, ig_avatar_url, page_access_token, penai_secret, register_webhook_endpoint, refresh_token_endpoint}`.
   - Hoặc mã dùng một lần `hfbx_` / `higx_` + chuỗi ngẫu nhiên (20–200 ký tự `A-Za-z0-9_-`): PenAI gọi `POST <hub>/api/facebook/penai/exchange {code}` → `{success:true, data:<JSON như trên>}`.
3. **Đăng ký nhận tin** `POST register_webhook_endpoint {page_id, ig_account_id?, penai_secret, platform, webhook_url}` (kèm header `X-PenAI-Secret`) → `{success:true, data:{…}}`; 4xx = từ chối. Tùy chọn: `data.previous_webhook_url` (địa chỉ cũ bị thay), `data.supports_expected_webhook_url: true` + nhận `expected_webhook_url` (chỉ ghi/gỡ khi địa chỉ hiện tại khớp) → PenAI mới gỡ đăng ký khi xóa kênh.
4. **Chuyển tiếp webhook**: POST nguyên JSON `{object:"page"|"instagram", entry:[…]}` (một entry mỗi lần) tới `webhook_url`, header `X-PenAI-Signature: sha256=<HMAC-SHA256(penai_secret, body)>`; khuyên dùng thêm `X-HoiAI-Timestamp: <giây>` + `X-HoiAI-Signature: sha256=<HMAC(penai_secret, "<ts>.<body>")>` (PenAI ưu tiên bản này, lệch giờ tối đa 5 phút). PenAI trả 200 ngay, 401 sai chữ ký, 404 kênh không còn, 503 kênh tạm dừng. Gửi lại khi lỗi mạng/5xx được — PenAI bỏ tin trùng theo `mid`. Cần chuyển cả tin dội lại (`message_echoes`).
5. **Làm mới token** `POST refresh_token_endpoint {page_id, ig_account_id?, penai_secret}` → `{success:true, data:{page_access_token}}` — PenAI gọi khi Graph API báo lỗi 190.

## 7. App Facebook riêng

Dùng khi muốn tự chủ (không phụ thuộc hub) hoặc cần quyền mà hub chưa có. Ở **chế độ phát triển** (Development mode) app dùng được ngay với Trang mà tài khoản đăng nhập quản trị — không cần Meta duyệt.

**Tạo app (một lần):**

1. developers.facebook.com → **Create App** → loại **Business** (hoặc chọn mục đích "Quản lý Trang / Messenger").
2. Thêm sản phẩm **Facebook Login for Business**, **Webhooks**, **Messenger** (và **Instagram** nếu dùng Instagram).
3. **App settings → Basic**: lấy **App ID** và **App Secret**.
4. PenAI → **Channels** → mục **Meta Apps** → **＋ Thêm app** → dán App ID, App Secret → Lưu. Hộp thoại hiện 3 giá trị kèm nút Sao chép:
   - **Valid OAuth Redirect URI** → dán vào Facebook Login → Settings.
   - **Webhook Callback URL** + **Verify Token** → Webhooks → chọn **Page** → Subscribe, tick `messages`, `messaging_postbacks`, `message_echoes`, `feed`. Instagram: chọn **Instagram** → tick `messages`, `comments`.
5. App dùng Facebook Login for Business có **Configuration** thì dán Configuration ID; không thì để trống.
6. **Quyền trong app**: chỉ cần nhắn tin thì app chỉ thêm `pages_messaging`, `pages_manage_metadata`, `pages_show_list` — đơn giản và dễ được Meta duyệt nhất. Cần thêm tính năng thì thêm quyền tương ứng vào app:

   | Tính năng (tick khi bấm Đăng nhập Facebook) | Quyền app cần có |
   |---|---|
   | Messenger (luôn có) | `pages_show_list`, `pages_manage_metadata`, `pages_messaging` |
   | Bình luận bài viết | `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement` (Instagram: `instagram_manage_comments`) |
   | Đăng bài | `pages_read_engagement`, `pages_manage_posts` (Instagram: `instagram_content_publish`) |
   | Số liệu Trang | `pages_read_engagement`, `read_insights` (Instagram: `instagram_manage_insights`) |
   | Instagram | `instagram_basic`, `instagram_manage_messages` |

   Tick mục mà app chưa có quyền thì Facebook báo **Invalid Scopes** — bỏ tick mục đó hoặc thêm quyền vào app rồi đăng nhập lại.

**Nối Trang:** mục Meta Apps → **Đăng nhập Facebook** → chọn tính năng (mặc định chỉ Messenger) → **Tiếp tục sang Facebook** → cấp quyền, tick các Trang → quay về PenAI, hộp **Chọn Trang** tự mở → chọn agent → **＋ Kênh Facebook** / **＋ Kênh Instagram**. PenAI tự đăng ký Trang gửi sự kiện cho app.

- Token Trang lấy theo cách này không tự hết hạn (trừ khi đổi mật khẩu hoặc gỡ quyền). Token người dùng của app hết hạn sau ~60 ngày: chỉ cần khi chọn thêm Trang — bấm **Đăng nhập lại**, token các kênh tự cập nhật.
- Token hỏng (Graph API báo lỗi 190): kênh báo "Đăng nhập Facebook lại" ở Channels → Kết nối Trang và Inbox.
- Đổi App Secret: mục Meta Apps → Cài đặt Meta → dán Secret mới; mọi kênh của app tự cập nhật.
- Webhook từ Meta tới `/webhooks/meta-app/<mã>`, PenAI kiểm chữ ký `X-Hub-Signature-256` bằng App Secret.
- Một Trang chỉ nên nối **một cách**: kênh đang qua hub mà nối lại bằng app riêng (hoặc ngược lại) thì kênh chuyển sang cách mới.
- Muốn khách không có vai trò trong app cũng nhắn được ổn định lâu dài: chuyển app sang Live và qua Meta duyệt các quyền đang dùng.

## 8. Bình luận

Bật sẵn cho mọi kênh Facebook/Instagram (cả hai cách nối; qua hub thì hub phải chuyển tiếp sự kiện `feed`/`comments`).

- Mỗi **bài viết** là một hội thoại trong Inbox (tên 📝 + đoạn đầu bài), bộ lọc **Tin nhắn / Bình luận**. Mỗi bình luận ghi tên người viết.
- **AI tự xử lý** bình luận mới của khách — bật/tắt từng kiểu ở Inbox → ⚙️ Cài đặt:
  - **AI trả lời công khai dưới bình luận** (mặc định bật).
  - **AI nhắn riêng** (Messenger / Instagram Direct) cho người bình luận (mặc định bật) — Meta cho nhắn riêng 1 lần mỗi bình luận, trong 7 ngày; khách trả lời thì thành hội thoại tin nhắn bình thường.
  - **Nhận bình luận vào Inbox** (tắt = bỏ qua bình luận hoàn toàn).
- AI nhận đoạn đầu bài viết làm ngữ cảnh; mỗi người bình luận trên mỗi bài có một mạch hội thoại riêng với AI.
- **Nhân viên trả lời từ Inbox**: bấm **↩ Trả lời** (công khai) hoặc **✉ Nhắn riêng** trên một bình luận rồi gõ; gõ thẳng không chọn = bình luận vào bài.
- Bình luận do Trang viết trên **Meta Business Suite** cũng hiện (ghi rõ nguồn) và làm AI tạm im ở bài đó theo số phút cài đặt.
- AI bị tắt cho hội thoại bài viết (Inbox → AI trả lời: Tắt) thì AI không trả lời bình luận của bài đó.

## 9. MCP "PenAI Kênh"

Một bộ công cụ MCP (giao thức để AI gọi công cụ) cho **mọi kênh** — thêm kênh mới không sinh thêm công cụ, công cụ nhận `channel_id`:

| Công cụ | Việc | Quyền |
|---|---|---|
| `channels_list` | Danh sách kênh, trạng thái, tính năng | bất kỳ quyền nào dưới đây |
| `conversations_list`, `messages_get`, `messages_search` | Đọc hội thoại / tin nhắn / bình luận | `channels:messages` |
| `message_send` | Gửi tin, ảnh; trả lời / nhắn riêng bình luận | `channels:send` |
| `page_posts_list`, `page_post_create`, `page_post_delete` | Xem, **đăng** (chữ, link, ảnh, nhiều ảnh, video, hẹn giờ Facebook; ảnh / reel / carousel Instagram), xóa bài | `pages:publish` |
| `page_comments_list`, `page_comment_reply`, `page_comment_hide`, `page_private_reply` | Bình luận | `pages:comments` |
| `page_insights` | Số liệu theo ngày | `pages:insights` |

**Agent của PenAI dùng:** Dashboard → **MCP** → Thêm → transport **PenAI Kênh (nội bộ)** → tick quyền, (tùy chọn) giới hạn kênh → Tạo. Chạy ngay trong PenAI, không qua mạng, không đăng nhập. Gán cho agent như MCP khác (phạm vi `granted` = chỉ agent được cấp ở trang Agents). Agent đăng được cả ảnh vừa tạo trong thư mục làm việc (`files`).

**Claude / ChatGPT dùng:** Dashboard → 🔗 Kết nối AI bên ngoài → địa chỉ MCP như trước; khi cấp quyền tick thêm các quyền `channels:*` / `pages:*` (kết nối tạo trước 1.20.0 cần kết nối lại). Đọc tin nhắn từ AI bên ngoài vẫn cần quản trị bật "Cho ứng dụng AI bên ngoài đọc" ở Inbox → Cài đặt của từng kênh.

Bài đăng **đăng thẳng** (không qua bước duyệt) — chỉ cấp `pages:publish` cho agent/ứng dụng bạn tin. Mọi lần đăng ghi nhật ký máy chủ (kênh, mã bài, nguồn). Bộ công cụ `zalo_*` / `whatsapp_*` cũ vẫn giữ cho các kết nối đang dùng.
