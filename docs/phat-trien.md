# Phát triển PenAI (dành cho người sửa mã nguồn)

Học viên chỉ cài và dùng thì **không cần** tài liệu này — xem [README](../README.md).
Tài liệu này dành cho ai muốn sửa mã, chạy test hoặc đóng góp tính năng.

## Kiến trúc tóm tắt

Chi tiết (sơ đồ thành phần, luồng một tin nhắn, dữ liệu, bản cài trên máy chủ): [kien-truc.md](kien-truc.md).

Monorepo pnpm, TypeScript chạy trực tiếp bằng `tsx` (không có bước build).

| Thư mục | Vai trò |
|---|---|
| `apps/server` | Máy chủ Fastify: API `/v1/*`, webhook kênh chat, Dashboard (`src/ui.ts` — SPA JavaScript thuần nhúng trong template literal), thương hiệu (`src/branding.ts`) |
| `packages/shared` | Cấu hình (JSON5 + Zod, `config.ts`), logger, mã hóa AES-256-GCM, kiểu dùng chung |
| `packages/db` | Schema, migration SQL viết tay, RLS theo workspace — **nơi duy nhất có SQL** |
| `packages/providers` | Kết nối LLM: OpenAI/Gemini/Qwen/Anthropic bằng API key; ChatGPT (codex), Claude Code, Antigravity qua gói thuê bao |
| `packages/core` | Vòng lặp agent (nghĩ → gọi tool → quan sát), hàng đợi, trần đồng thời theo provider |
| `packages/tools` | Tool có sẵn của agent (file, exec trong sandbox bubblewrap, tạo ảnh, vault, skill…) |
| `packages/channels` | Kênh chat: Telegram, Zalo OA, Zalo cá nhân, Microsoft Teams, Discord, Slack, WhatsApp, Feishu |
| `packages/mcp` | Kết nối MCP server (stdio/SSE/HTTP, OAuth) |
| `deploy/` | Script cài/cập nhật trên VPS, mẫu cấu hình, systemd, nginx |

Quy ước bắt buộc:

- Mọi bảng theo workspace có `workspace_id NOT NULL` + RLS; thiếu ngữ cảnh workspace → 0 dòng (fail-closed).
- Chỉ `packages/db` được viết SQL; nơi khác gọi hàm repository nhận `WorkspaceContext`.
- Migration **chỉ thêm** (bảng mới, cột có giá trị mặc định). Không sửa file migration đã phát hành — học viên nâng cấp từ bản cũ sẽ không chạy lại file đã sửa. Cần đổi cấu trúc thì viết migration mới.
- Khóa cấu hình mới phải có giá trị mặc định (file cấu hình cũ của học viên không có khóa đó).
- `ui.ts` là JavaScript thuần trong template literal: dấu backtick hoặc `${` lọt vào là hỏng cả Dashboard. Test `apps/server/test/ui-syntax.test.ts` dịch thử toàn bộ script — phải xanh.

## Chạy trên máy

Cần Node.js ≥ 24, pnpm 11 và PostgreSQL ≥ 16 **có extension pgvector**. Cách nhanh nhất có PostgreSQL + pgvector là Docker:

```bash
docker run -d --name penai-pg -p 5433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg17
```

Rồi:

```bash
pnpm install
cp .env.example .env              # sửa DATABASE_URL, DATABASE_URL_ADMIN theo cổng 5433, điền PENAI_MASTER_KEY
cp penai.config.example.json5 penai.config.json5
pnpm db:migrate
PENAI_USER_PASSWORD='matkhau123' pnpm setup:admin -- --email ban@example.com
pnpm dev                          # http://127.0.0.1:18800
```

Chạy thử không cần LLM thật: `pnpm mock-llm` (LLM giả trả lời cố định, cổng 18801) rồi khai provider
`openai-compat` trỏ `http://127.0.0.1:18801/v1` trong `penai.config.json5`.

Chỉ sửa giao diện Dashboard thì không cần cả PostgreSQL: `pnpm exec tsx scripts/mock-dashboard.ts` rồi mở
http://127.0.0.1:18899/#/users — máy chủ giả phục vụ đúng `ui.ts` đang sửa kèm dữ liệu mẫu (đăng nhập sẵn quyền quản trị).

## Test

Test chạy trên PostgreSQL thật (không mock). Database `penai_test` bị **xóa và tạo lại** mỗi lần chạy — đừng trỏ vào cụm PostgreSQL có dữ liệu thật. Mặc định kết nối `127.0.0.1:5433`, đổi bằng biến môi trường:

| Biến | Mặc định |
|---|---|
| `PENAI_TEST_PG_HOST` / `PENAI_TEST_PG_PORT` | `127.0.0.1` / `5433` |
| `PENAI_TEST_ADMIN_MAINT_URL` | `postgres://postgres@HOST:PORT/postgres` |
| `PENAI_TEST_ADMIN_URL` | `postgres://postgres@HOST:PORT/penai_test` |
| `PENAI_TEST_APP_URL` | `postgres://penai_app:penai_app@HOST:PORT/penai_test` |

```bash
pnpm typecheck
pnpm test
```

Một số test cần `bash`, `python3` và `bubblewrap` (test sandbox exec) — chạy trên Linux là đủ. GitHub Actions (`.github/workflows/ci.yml`) chạy typecheck + toàn bộ test cho mỗi pull request.

## Quy trình phát hành

Xem [docs/phat-hanh.md](phat-hanh.md).
