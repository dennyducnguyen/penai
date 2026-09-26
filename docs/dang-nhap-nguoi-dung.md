# Đăng nhập Dashboard + phân quyền người dùng

Dashboard PenAI đăng nhập bằng **email + mật khẩu**. Khóa API `psk_…` chỉ dành cho
**phần mềm gọi API** (script, ứng dụng khác tích hợp với PenAI).

## Hai loại danh tính, một cơ chế phân quyền

| | Tài khoản người dùng | Khóa API |
|---|---|---|
| Ai dùng | Người, qua trình duyệt | Chương trình, qua `Authorization: Bearer psk_…` |
| Lưu ở đâu | Cookie `penai_session` (httpOnly, SameSite=Lax, Secure, 7 ngày) | Header mỗi request |
| Tạo ở đâu | Dashboard → **Người dùng** (ws_admin) hoặc CLI `user:create` | Dashboard → **Khóa API (tích hợp)** |
| Bảng | `users` + `workspace_members` + `web_sessions` | `api_keys` |

Cả hai đi qua cùng middleware trong `apps/server/src/web-auth.ts` → cùng `authCtx {userId, workspaceId, role}`
→ mọi route `/v1/*` không đổi. Role của phiên web đọc **sống** từ `workspace_members`
(hàm SECURITY DEFINER `auth_lookup_web_session`), nên đổi quyền / gỡ khỏi workspace có hiệu lực ở request kế tiếp.

## Vai trò

| Role | Thấy gì | Làm gì |
|---|---|---|
| `ws_admin` | mọi menu | cấu hình, tạo/sửa/khóa người dùng, đặt lại mật khẩu, khóa API |
| `operator` | mọi menu vận hành | chat mọi agent, kênh, cron, kho tri thức |
| `viewer` | chỉ đọc | không chat |
| `member` (mới) | **chỉ trang Chat** | chat với agent được gán trong `agent_user_grants`, chỉ thấy phiên chat của mình |

`member` bị chặn ở server bằng allowlist fail-closed (`MEMBER_ALLOW` trong web-auth.ts):
`/auth/me|logout|change-password`, `GET /v1/agents` (chỉ id/key/name/provider/model — không lộ system prompt),
`GET|POST /v1/sessions`, `GET /v1/sessions/:id/messages`, `DELETE /v1/sessions/:id`, `POST /v1/chat`.
Lọc agent nằm ở tầng repo (`listAgents`, `getAgentByKey/ById` → `canAccessAgent`), phiên theo `sessions.owner_user_id`.

## Tài khoản quản trị đầu tiên

Script cài (`deploy/install.sh`) tạo sẵn tài khoản quản trị bằng email bạn khai báo và in mật khẩu ra
màn hình **một lần**. Quên mật khẩu thì đặt lại trên máy chủ:

```bash
sudo penai reset-password admin@congty.vn
```

Lệnh hỏi mật khẩu mới (tối thiểu 8 ký tự), đặt lại và thu hồi mọi phiên đăng nhập cũ của tài khoản đó.
Tạo thêm người dùng thì vào Dashboard → **Người dùng** (tài khoản `ws_admin`).

## API

| Route | Quyền | Ghi chú |
|---|---|---|
| `POST /auth/login {email,password}` | public | 401 sai; 403 khóa/không workspace; 429 sau 8 lần sai/15 phút (theo IP+email) |
| `POST /auth/logout` | public (đọc cookie) | thu hồi phiên, xóa cookie |
| `GET /auth/me` | mọi role | user, workspace, role, roleLabel, authKind, mustChangePassword |
| `POST /auth/change-password {currentPassword,newPassword}` | phiên web | thu hồi mọi phiên cũ, cấp cookie mới |
| `GET /v1/users` | ws_admin | users + agents + roles |
| `POST /v1/users {email,name,password,role,agentIds,mustChangePassword}` | ws_admin | email đã có ở workspace khác → chỉ thêm membership |
| `PATCH /v1/users/:id {name,role,isActive,agentIds}` | ws_admin | không tự hạ quyền / tự khóa |
| `POST /v1/users/:id/password {password,mustChange}` | ws_admin | thu hồi mọi phiên của user |
| `DELETE /v1/users/:id` | ws_admin | gỡ membership + grants; không tự gỡ |

Khi `mustChangePassword=true`, mọi route trừ `/auth/*` trả 403 `{code:"must_change_password"}`; UI mở dialog bắt đổi.

## Bảo mật

- Mật khẩu: scrypt (N=16384, r=8, p=1, 64 byte, salt 16 byte) qua `node:crypto` — `hashPassword/verifyPassword` trong `packages/shared/src/crypto.ts`. Tối thiểu 8 ký tự.
- Token phiên `pss_<32 byte base64url>`; DB chỉ lưu SHA-256 (`web_sessions.token_hash`).
- CSRF: cookie SameSite=Lax + chặn request đổi dữ liệu có `Sec-Fetch-Site: cross-site` hoặc `Origin` khác host.
- Dashboard không còn lưu token trong `localStorage` (UI tự xóa key `penai_key` cũ).
- Audit: `auth.login`, `auth.password_changed`, `user.create/update/password_reset/remove`.

## Test

`apps/server/test/web-auth.test.ts`: đăng nhập/cookie, CSRF, giới hạn quyền `member`, gán agent, đổi quyền có hiệu lực ngay,
đặt lại mật khẩu thu hồi phiên, bắt đổi mật khẩu, khóa và gỡ người dùng.

## Gửi/nhận file trong trang Chat (`apps/server/src/web-chat.ts`)

- **Gửi file vào**: nút 📎 / dán / kéo-thả trên trang Chat (tối đa 10 file, 100MB/file, gửi base64 trong body `POST /v1/chat` → `files[]`). Ảnh → vision (kèm 5 ảnh gần nhất của phiên) + refImages cho `image_generation`; text nhỏ (≤200KB) inline vào tin; PDF/DOCX/XLSX… lưu để agent `read_document`. File lưu vào thư mục riêng `users/web-<userId>` (giữ tên gốc slug hóa: "Bảng Giá (v2).csv" → `bang-gia-v2.csv`, trùng → hậu tố -2). Chỉ gửi file không chữ → lưu + ack, không chạy LLM (giống Telegram).
- **Agent trả file**: `send_file` (ưu tiên) → marker `[[media:]]` → file mới sinh trong lượt (`newDeliverables`), cùng luật với channels-runtime. SSE thêm sự kiện `saved` (file người dùng đã lưu) và `file {name,p,size,mime,isImage}`; ảnh hiện inline, file khác là thẻ tải. Lịch sử: ghi thêm assistant message `📎 Đã gửi file: … [[files:JSON]]` để mở lại vẫn thấy thẻ (UI tách marker, không đưa vào Markdown).
- **Tải file**: `GET /v1/chat/files?p=<tên>` (thư mục riêng), `p=shared/…`, `p=ws/…` (chỉ operator/ws_admin). Cookie/API key xác thực, realpath chống symlink, `..` → 404, html/svg/js ép tải về, `&dl=1` ép attachment. Member có trong allowlist.
- `userKey = web-<userId>` → memory theo user + thư mục riêng; operator/ws_admin đặt `skipUserMcpLayer` để giữ quyền MCP như dashboard cũ (member chịu lớp `mcp_user_grants` fail-closed).
- Test: `apps/server/test/web-chat-files.test.ts`.

## Chưa làm (giai đoạn 2)

- Một user nhiều workspace (bảng đã hỗ trợ; đăng nhập hiện lấy membership đầu tiên).
- SSO Microsoft Entra, quên mật khẩu qua email, 2FA.
- Memory theo user cho chat web (hiện `/v1/chat` từ Dashboard không truyền `userKey`).
