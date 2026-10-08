# Kiến trúc PenAI

Tài liệu mô tả cấu trúc hệ thống: các thành phần, mã nguồn nằm ở đâu, một tin nhắn đi qua những bước nào, dữ liệu lưu thế nào và bản cài trên máy chủ được tổ chức ra sao. Dành cho người muốn hiểu sâu hoặc sửa mã — học viên chỉ cài và dùng thì đọc [README](../README.md) là đủ.

## 1. Tổng quan

Mỗi bản cài PenAI là **một tiến trình Node.js** (chạy TypeScript trực tiếp bằng `tsx`, không có bước build) cùng **một database PostgreSQL** có extension `pgvector` (tìm kiếm theo vector — dùng cho tìm kiếm ngữ nghĩa). Một bản cài phục vụ một công ty; bên trong chia thành nhiều **workspace** (không gian làm việc, thường là một bộ phận), dữ liệu các workspace tách biệt ở mức database.

```
  Người dùng
  ├─ Trình duyệt: Dashboard quản trị + trang Chat ─────────┐
  ├─ Kênh chat: Telegram, Zalo, Teams, Discord, Slack… ─────┤  (webhook hoặc kết nối liên tục)
  └─ Phần mềm khác: API tương thích OpenAI (khóa psk_) ─────┤
                                                            │ HTTPS 443
                                              ┌─────────────▼─────────────┐
                                              │ nginx (chứng chỉ HTTPS)   │
                                              └─────────────┬─────────────┘
                                                            │ 127.0.0.1:18800
  ┌─────────────────────────────────────────────────────────▼─────────────────────────────┐
  │ penai.service — một tiến trình Node.js                                                 │
  │   apps/server   : API /v1/*, Dashboard, webhook kênh, xác thực, thương hiệu            │
  │   core          : vòng lặp agent (nghĩ → gọi tool → quan sát), hàng đợi, trần đồng thời │
  │   tools         : 42 tool có sẵn + custom tool + tool từ MCP                          │
  │   providers     : kết nối mô hình AI      channels : 8 kênh chat      mcp : máy chủ MCP │
  └───────┬──────────────────────────┬──────────────────────────────┬────────────────────┘
          │                          │                              │
  PostgreSQL + pgvector      /var/lib/penai                  Nhà cung cấp AI
  (agent, hội thoại, trí     (file người dùng, thư viện,     ChatGPT (codex), Claude Code CLI,
  nhớ, kho tri thức,         skill, token đăng nhập          Antigravity CLI, OpenAI/Gemini/
  người dùng… — RLS)         provider, CLI claude/agy)       Qwen/Anthropic bằng API key
```

## 2. Mã nguồn

Monorepo pnpm (nhiều gói trong một kho mã), TypeScript strict, ESM.

| Thư mục | Nội dung chính |
|---|---|
| `apps/server/src/index.ts` | Điểm khởi động: đọc cấu hình, mở database, nạp provider, MCP, kênh chat, cron, worker trí nhớ, theo dõi file cấu hình |
| `apps/server/src/app.ts` | Toàn bộ route HTTP `/v1/*` (agent, kênh, skill, MCP, vault, người dùng…), webhook kênh, `/healthz` |
| `apps/server/src/ui.ts` | Dashboard: SPA JavaScript thuần nhúng trong một template literal (không React, không bước build) |
| `apps/server/src/branding.ts` | Ráp tên/khẩu hiệu/màu/logo từ cấu hình vào Dashboard; logo SVG mặc định |
| `apps/server/src/agent-runtime.ts` | Dựng "bộ đồ nghề" cho mỗi lượt chạy agent: prompt, trí nhớ, kho tri thức, skill, tool, quyền MCP |
| `apps/server/src/channels-runtime.ts` | Nhận tin từ kênh: ghép nối (pairing), lưu file đính kèm, xếp hàng, chạy agent, gửi trả lời/file |
| `apps/server/src/web-auth.ts`, `web-chat.ts` | Đăng nhập Dashboard (email + mật khẩu, cookie), trang Chat web có gửi/nhận file |
| `apps/server/src/api/` | API tương thích OpenAI: `/v1/chat/completions`, `/v1/models`, `/v1/images/generations` |
| `apps/server/src/library*.ts`, `vault-*.ts` | Thư viện file theo agent; kho tri thức (chia đoạn, tạo vector, tìm kiếm) |
| `apps/server/src/cron-runner.ts`, `cron-tools.ts` | Chạy agent theo lịch và gửi kết quả về cuộc trò chuyện đã đặt lịch; phần runtime của tool `cron_*` (agent tự đặt lịch khi chat — [lich-hen.md](lich-hen.md)) |
| `apps/server/src/memory-worker.ts`, `mcp-manager.ts` | Tóm tắt hội thoại cũ thành trí nhớ; kết nối và tự nối lại MCP |
| `apps/server/src/inbox.ts`, `mcp-server.ts` | Inbox Zalo cá nhân (lưu tin, realtime SSE, gửi text/ảnh); PenAI MCP server + OAuth cho Claude/ChatGPT gọi vào ([zalo-personal.md](zalo-personal.md)) |
| `apps/server/src/browser-runtime.ts` | Trình duyệt của agent: một Chromium dùng chung, phiên theo agent + người dùng; API Dashboard → Trình duyệt (hồ sơ cookie mã hóa, thử truy cập) — [trinh-duyet.md](trinh-duyet.md) |
| `apps/server/src/version.ts` | Phiên bản đang chạy (đọc `release.json` do lệnh cài/cập nhật ghi) |
| `packages/shared` | Đọc/kiểm tra cấu hình (`config.ts`), mã hóa AES-256-GCM (`crypto.ts`), logger, kiểu dùng chung |
| `packages/db` | Schema, migration SQL viết tay, hàm truy vấn theo từng nhóm (`*-repo.ts`), lệnh `cli-*` (migrate, tạo quản trị, đặt lại mật khẩu) — **nơi duy nhất có SQL** |
| `packages/core` | `agent-loop.ts` (vòng lặp agent), `scheduler.ts` (làn xử lý song song), `provider-gate.ts` (trần số lời gọi cùng lúc theo provider), `cron.ts` (tính lịch theo múi giờ) |
| `packages/providers` | `codex/` (ChatGPT, nhiều tài khoản xoay vòng), `claude-code/`, `antigravity/`, `acp/`, `openai-compat.ts`, `gemini.ts`, `dashscope.ts` (Qwen), `anthropic.ts`, `images/` (tạo ảnh), `mock-llm.ts` |
| `packages/tools` | `builtin/` (42 tool: file, exec, web, trình duyệt, trí nhớ, skill, landing page, tài liệu, vault, KG, tạo ảnh, thẻ duyệt, lịch hẹn `cron_*`…), `browser/` (điều khiển Chromium, đọc cookie, chặn mạng nội bộ), `exec-sandbox.ts` (cách ly lệnh bằng bubblewrap), `custom-tool.ts` |
| `packages/channels` | `telegram.ts`, `zalo.ts` (Zalo OA), `zalo-personal.ts`, `whatsapp-personal.ts` (WhatsApp cá nhân), `personal.ts` (bề mặt chung của kênh cá nhân), `teams.ts`, `discord.ts`, `slack.ts`, `whatsapp.ts`, `feishu.ts`; `format.ts` (Markdown → HTML Telegram) |
| `packages/mcp` | Kết nối MCP server qua stdio/SSE/HTTP, đăng nhập OAuth |
| `deploy/` | `install.sh` (cài), `penai` (lệnh quản trị), `templates/` (cấu hình, systemd, nginx, tự cập nhật) |
| `scripts/` | Công cụ phát triển: `mock-dashboard.ts` (xem Dashboard không cần DB), `print-logo.ts`, script kiểm tra nhanh |
| `docs/` | Tài liệu người dùng và người phát triển |

## 3. Một tin nhắn đi qua những đâu

Ví dụ khách nhắn bot Telegram:

1. **Kênh** (`packages/channels/telegram.ts`) nhận tin, bật hiệu ứng "đang soạn…" và emoji trạng thái.
2. **channels-runtime** kiểm tra ghép nối (người lạ phải được quản trị duyệt), lưu ảnh/tài liệu vào thư mục riêng của người gửi, ghi danh bạ, đưa vào hàng đợi — cùng một hội thoại xử lý tuần tự, khác hội thoại chạy song song.
3. **agent-runtime** dựng ngữ cảnh theo thứ tự: prompt của agent → hướng dẫn cố định (`AGENT.md`, skill, MCP) → phần theo người/câu hỏi (`USER.md`, trí nhớ ghim + trí nhớ liên quan) → tài liệu kho tri thức tìm trúng → hồ sơ người đang chat + chỉ dẫn của quản trị viên cho người đó ([ho-so-contact.md](ho-so-contact.md)); kèm tool được phép (kể cả tool MCP theo quyền của agent ∩ người dùng).
4. **agent-loop** gọi mô hình AI qua **ProviderGate** (giới hạn số lời gọi cùng lúc cho mỗi provider — Claude Code/Antigravity mỗi tiến trình tốn ~220 MB RAM). Mô hình muốn dùng tool → chạy tool → đưa kết quả lại → lặp tới khi có câu trả lời.
5. **Trả lời** về kênh (có stream chữ nếu kênh và provider hỗ trợ), gửi file bằng tool `send_file`; lượt chạy được ghi vào `traces` (theo dõi) và thống kê token.

**Lịch hẹn**: người dùng nhờ "nhắc tôi 8h sáng mai…" → agent gọi tool `cron_create` → dòng mới trong `cron_jobs` kèm nơi tạo (kênh, cuộc trò chuyện, người nhờ) và múi giờ. **CronRunner** kiểm tra mỗi 20 giây, chạy lại agent bằng thư mục + quyền hiện tại của người nhờ, rồi gửi câu trả lời về đúng cuộc trò chuyện đó (và ghi vào hội thoại để người dùng trả lời tiếp). Chi tiết: [lich-hen.md](lich-hen.md).

## 4. Dữ liệu và bảo mật

- **Cách ly workspace bằng RLS** (Row-Level Security — PostgreSQL tự lọc dòng theo workspace): mọi bảng theo workspace có `workspace_id`; thiếu ngữ cảnh workspace thì truy vấn trả 0 dòng (an toàn mặc định). Ứng dụng kết nối bằng role `penai_app` không có quyền vượt RLS.
- **Migration**: file SQL đánh số trong `packages/db/migrations/`, chạy theo thứ tự, mỗi file một giao dịch, ghi tên file đã chạy vào `schema_migrations`. Số `0015`–`0016` được bỏ trống có chủ đích. Luật: migration chỉ **thêm** (xem [phat-hanh.md](phat-hanh.md)).
- **Bí mật** (token kênh chat, API key provider, token OAuth MCP, cookie hồ sơ trình duyệt) mã hóa AES-256-GCM bằng khóa `PENAI_MASTER_KEY` trong `/etc/penai/penai.env`. Mất khóa là không giải mã được.
- **Đăng nhập**: mật khẩu băm scrypt; phiên web là cookie httpOnly; khóa API `psk_…` chỉ lưu dạng băm SHA-256. 4 vai trò: `ws_admin`, `operator`, `viewer`, `member` (chỉ chat với agent được gán).
- **File**: `<dataDir>/<workspace>/users/<kênh>-<người-gửi>/` (thư mục riêng từng người, người khác không thấy), `shared/` (chỉ đọc với agent, chứa skill), `thu-vien/<workspace>/<agent>/` (thư viện của agent).
- **Lệnh `exec` của agent** chạy trong sandbox bubblewrap: chỉ thấy thư mục làm việc và cây hệ thống tối thiểu, không thấy biến môi trường của máy chủ (khóa, token).

## 5. Cấu hình

| Nguồn | Nội dung | Đổi xong |
|---|---|---|
| `/etc/penai/penai.config.json5` (đường dẫn qua biến `PENAI_CONFIG`) | `providers` (codex, claude-code, antigravity), `api` (tên gọi tắt model, trần đồng thời), `branding` (tên, màu, logo), `timezone` (múi giờ lịch hẹn, mặc định `Asia/Ho_Chi_Minh`), `port`, `dataDir` | `providers`, trần đồng thời, `branding`, `timezone` tự nạp lại; phần khác cần `sudo penai restart` |
| `/etc/penai/penai.env` | `DATABASE_URL`, `PENAI_MASTER_KEY`, `PENAI_PUBLIC_URL`, `PENAI_EXEC_SANDBOX`, `PENAI_LANE_MAIN`, `LOG_LEVEL`, `PENAI_BROWSER_*` ([trinh-duyet.md](trinh-duyet.md)) | `sudo penai restart` |
| Database | Agent, kênh, provider API key, skill, MCP, người dùng, kho tri thức… | Có hiệu lực ngay (qua Dashboard) |

Khóa cấu hình và kiểm tra hợp lệ nằm ở `packages/shared/src/config.ts`; mẫu cho bản cài mới ở `deploy/templates/penai.config.json5` (có test kiểm mẫu).

## 6. Bản cài trên máy chủ

Script `deploy/install.sh` dựng, lệnh `penai` vận hành ([van-hanh.md](van-hanh.md)). Mặc định tên bản cài là `penai`; cài nhiều bản trên một máy thì mỗi bản một tên (`--instance`) và **một cụm PostgreSQL riêng** (vì các bản dùng chung tên role `penai_app`).

```
/opt/penai/
├── app → releases/20260926T071511Z-bd7d9724   (lối tắt tới bản đang chạy)
├── releases/<thời-điểm>-<commit>/              (giữ 3 bản gần nhất để rollback)
│   └── release.json                            (phiên bản, tag/nhánh, commit, thời điểm cài)
└── repo.git                                    (bản sao kho mã GitHub)
/etc/penai/        penai.config.json5 · penai.env · penai-install.conf
/var/lib/penai/    data/ · codex-accounts/ · .local/bin/{claude,agy} · token đăng nhập provider
/var/backups/penai/<thời-điểm>/   db.dump + etc/ (tạo trước mỗi lần cập nhật, giữ 7 bản)
/var/log/penai/    nhật ký từng lần cập nhật (và browser-setup-*.log lần cài Chromium)
/opt/penai-browsers/   Chromium cho tool trình duyệt — dùng chung mọi bản cài trên máy
```

Dịch vụ systemd `penai.service` chạy bằng user riêng `penai`, thư mục mã chỉ đọc, chỉ ghi được `/var/lib/penai`, có thể giới hạn RAM. `penai update` giải nén bản mới vào thư mục riêng → cài thư viện → migration → đổi lối tắt → khởi động lại → kiểm `/healthz` đúng commit; lỗi thì tự trỏ về bản cũ.

## 7. Phiên bản và phát hành

Mã phát triển trên nhánh `main` (máy demo tự cập nhật theo `main`); học viên nhận bản phát hành gắn tag `vX.Y.Z`. CI trên GitHub chạy typecheck, toàn bộ test trên PostgreSQL thật có pgvector và shellcheck cho script cài. Quy trình: [phat-hanh.md](phat-hanh.md). Chạy và test trên máy: [phat-trien.md](phat-trien.md).
