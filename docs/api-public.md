# API công khai PenAI (OpenAI-compatible)

Hướng dẫn ngắn cho **người** dựng app gọi PenAI từ server khác.

- Tra cứu đầy đủ (mọi endpoint, mẫu request/response thật, mã lỗi) — **dành cho máy/AI đọc**: `api-reference.md`
- Kiến trúc, số đo, lý do thiết kế, bẫy triển khai: `../specs/spec-public-api-gateway.md`

- Base URL: `https://ai.example.com/v1`
- Xác thực: `Authorization: Bearer psk_...`
- Bật/tắt + cấu hình: nhánh `api` trong `penai.config.json5` (bản cài trên VPS: `/etc/penai/penai.config.json5`)

## 1. Vì sao dùng API này

Chỉ phục vụ những thứ app **không tự gọi được**:

| Có phục vụ | Không phục vụ |
|---|---|
| Tài khoản **ChatGPT subscription** (pool xoay vòng) | `openai-key`, `gemini`, `anthropic`… — app có API key thì gọi thẳng nhà cung cấp |
| **Claude Code CLI** (gói Claude Max) | Embeddings — không provider nào trong phạm vi hỗ trợ |
| **Antigravity** (`agy`, gói Google Ultra) | |
| **Agent PenAI** (tool, vault, skill, file) | |

## 2. Dùng với SDK openai (khuyến nghị)

Không cần client riêng.

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PENAI_KEY,          // psk_...
  baseURL: "https://ai.example.com/v1",
});

const r = await client.chat.completions.create({
  model: "penai-fast",
  messages: [{ role: "user", content: "Xin chào" }],
});
console.log(r.choices[0].message.content);
```

```python
from openai import OpenAI
client = OpenAI(api_key=PENAI_KEY, base_url="https://ai.example.com/v1")
r = client.chat.completions.create(model="penai-fast",
                                   messages=[{"role": "user", "content": "Xin chào"}])
```

## 3. Chọn model

| `model` | Nghĩa |
|---|---|
| `penai-fast` | Alias ảo — nhanh, stream token thật (ChatGPT subscription) |
| `penai-smart` | Mạnh hơn; có chặng dự phòng sang Claude Code / Antigravity |
| `penai-image` | Tạo / sửa ảnh — Antigravity trước, ChatGPT dự phòng |
| `penai-image-codex` | Tạo / sửa ảnh chỉ bằng ChatGPT (codex) |
| `codex/gpt-5.6-sol`, `claude-code/sonnet`, … | Ép đúng provider/model — dùng để debug |
| `agent:<key>` | Chạy agent PenAI đầy đủ (tool, vault, trả file) |

Các alias `penai-*` được khai sẵn trong file cấu hình lúc cài (`/etc/penai/penai.config.json5` → `api.models`,
mặc định trỏ `gpt-5.5` rồi `gpt-5.4` của ChatGPT, `sonnet` của Claude, `gemini-3.7-flash-*` của Antigravity).
Tài khoản của bạn có model khác thì sửa route ở đó rồi `sudo penai restart`.

**Nên dùng alias** (`penai-fast`…): route phía sau đổi được (hết quota tài khoản này → nhảy
provider khác) mà app không phải deploy lại.

Ba provider phía sau (danh sách model đầy đủ: `api-reference.md` §2b):

| Provider | Là gì | Model hay dùng |
|---|---|---|
| `codex` | ChatGPT subscription | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` |
| `claude-code` | Gói Claude Max qua CLI | `sonnet`, `opus`, `haiku`, `claude-sonnet-5` |
| `antigravity` | Gói Google Ultra qua `agy` | `gemini-3.8-flash-high`, `gemini-3.1-pro-high` |

**Model khả dụng đổi theo gói ChatGPT của tài khoản** — gói hết hạn là model cao cấp biến mất ngay
(đã xảy ra 13/09/2026). Dùng alias để có chặng dự phòng thay vì hardcode tên model.

**Mức thinking**: `"reasoning_effort": "low" | "medium" | "high"`. Không có `"off"` — muốn tắt thì
**bỏ hẳn trường đi**. `minimal` bị `gpt-5.6-*` từ chối. Ở agent mode phải truyền dạng lồng
`"penai": { "reasoning_effort": "..." }` — chi tiết và hạn chế đã biết: `api-reference.md` §3.2b.

`GET /v1/models` liệt kê những gì key của bạn được dùng, kèm `penai.streaming`:

- `native` — stream token thật
- `none` — model ảnh (`penai-image`, `penai-image-codex`), không stream
- `mixed` — route có chặng CLI xen giữa (chặng đầu stream thật, chặng dự phòng thì không)
- `tools_only` — chỉ stream khi request không có tool
- `emulated` — trả nguyên khối (agent chạy trên provider CLI — agent luôn có tool)

## 4. Hai chế độ, khác nhau ở ngữ cảnh

| | raw mode (`penai-fast`…) | agent mode (`agent:x`) |
|---|---|---|
| Ngữ cảnh | **Stateless** — server dùng TRỌN `messages[]` bạn gửi | Session phía server |
| Tool / Vault / MCP | Không | Có |
| Trả file | Không | Có |

Agent mode có hai cách dùng:

```jsonc
// A. Stateless: gửi cả lịch sử, server tự dựng session tạm
{ "model": "agent:tro-ly", "messages": [ ...toàn bộ lịch sử... ] }

// B. Hội thoại bền: chỉ gửi lượt mới, server nhớ phần trước
{ "model": "agent:tro-ly",
  "messages": [{ "role": "user", "content": "lượt mới" }],
  "penai": { "conversation_id": "crm-ticket-8812" } }
```

## 5. Streaming

```js
const stream = await client.chat.completions.create({
  model: "penai-fast",
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: "user", content: "Viết 3 câu về cà phê" }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  if (chunk.penai?.file) console.log("\nFile:", chunk.penai.file.url);
  if (chunk.penai?.queued) console.log("\nĐang xếp hàng, vị trí", chunk.penai.queued.position);
}
```

Phần mở rộng của PenAI nằm ở khóa `penai` **bên trong chunk hợp lệ** (chunk vẫn có `choices`), nên
SDK chuẩn không vỡ. Các giá trị có thể gặp: `penai.queued`, `penai.tool_call`, `penai.file`,
và ở chunk cuối là `penai.route` / `penai.request_id` / `penai.files`.

Server tự gửi heartbeat `: ping` mỗi 15 s trong lúc chờ — đừng đặt idle timeout dưới 30 s.
Ngắt kết nối là server **huỷ luôn** lượt chạy (đã kiểm chứng: tiến trình CLI bị kill trong ~5 s).

## 6. Agent trả file / ảnh

```jsonc
{ "model": "agent:tro-ly",
  "messages": [{ "role": "user", "content": "Tạo file báo cáo rồi gửi cho tôi" }],
  "penai": { "return_files": "url" } }   // url (mặc định) | b64 | none
```

Phản hồi:

```jsonc
{
  "choices": [{ "message": { "content": "Đã gửi file.\n\n[bao-cao.txt](https://ai.example.com/f/...)" } }],
  "penai": {
    "files": [{ "id": "f_...", "name": "bao-cao.txt", "content_type": "text/plain",
                "bytes": 82, "url": "https://ai.example.com/f/...",
                "expires_at": "2026-09-13T17:44:19Z" }],
    "tool_calls": [{ "name": "write_file" }]
  }
}
```

- Link mặc định hạn **24 giờ** (`penai.url_ttl_hours` để đổi, trần 168 giờ).
- `return_files: "b64"` nhúng base64 cho file ≤ 1 MB; vượt thì tự hạ về link kèm `downgraded: true`.
- Link là **public-by-token**: ai có link đều mở được. Cần kín thì đừng chuyển link ra ngoài.

## 7. Tạo ảnh — không cần agent

```js
const img = await client.images.generate({
  model: "penai-image",
  prompt: "A minimal flat icon of a blue paper airplane",
  size: "1024x1024",          // 1024x1024 | 1536x1024 | 1024x1536
  // response_format: "b64_json",   // mặc định "url"
});
console.log(img.data[0].url, img.data[0].expires_at);

// Sửa ảnh / dùng ảnh tham chiếu + tỷ lệ khung
const b64 = fs.readFileSync("banner.jpg").toString("base64");
const edited = await client.images.generate({
  model: "penai-image",
  prompt: "Chỉ đổi dòng chữ lớn thành: MUA 1 TẶNG 1. Giữ nguyên mọi thứ khác.",
  penai: { ref_images: [`data:image/jpeg;base64,${b64}`], aspect_ratio: "16:9" },
});
```

- **Chạy ở đâu**: mặc định **Antigravity** (gói Google Ultra), lỗi hoặc đang bận thì **ChatGPT
  (codex)** làm dự phòng. Muốn dùng ChatGPT: `model: "penai-image-codex"` hoặc
  `penai: { provider: "codex" }`. `data[0].penai.route` cho biết ai đã tạo.
- `penai.ref_images`: tối đa 5 data URL (~10 MB/ảnh). `penai.aspect_ratio`: `16:9`, `9:16`, `4:5`…
- `n` tối đa 4 (mỗi ảnh là một lời gọi riêng). Thời gian đo được: tạo mới 20–35 s, sửa ảnh 35–55 s.
- Python: `client.images.generate(..., extra_body={"penai": {"provider": "codex"}})`.

## 8. Hạn mức và mã lỗi

| HTTP | `code` | Ý nghĩa |
|---|---|---|
| 401 | `invalid_api_key` | Key sai / thu hồi / hết hạn |
| 403 | `model_not_allowed`, `agent_not_allowed`, `provider_not_allowed` | Policy của key không cho |
| 403 | `ip_not_allowed` | IP không nằm trong allowlist (mặc định allowlist TẮT) |
| 403 | `key_paused` | Key bị tạm dừng (kill-switch) |
| 404 | `model_not_found` | Alias không tồn tại — xem `GET /v1/models` |
| 429 | `rate_limit_exceeded` | Vượt RPM (mặc định 120/phút, burst 20) |
| 429 | `too_many_concurrent` | Vượt số request song song của key (mặc định 4) hoặc hàng đợi provider đầy |
| 429 | `quota_exceeded` | Vượt hạn mức token tháng |
| 503 | `all_routes_exhausted` | Mọi ứng viên provider đều hỏng — `message` liệt kê lý do từng chặng |

Lỗi 429 luôn kèm `Retry-After` (giây). **Hãy tôn trọng nó** — các provider phía sau là tài khoản
subscription, không phải API trả tiền co giãn.

## 9. Header trả về

```
x-request-id: req_...              # đưa vào báo lỗi để tra log
x-penai-route: codex/gpt-5.6-sol   # provider/model đã phục vụ
x-penai-stream: native | emulated  # có stream token thật không
x-penai-queue-position: 3          # khi phải xếp hàng (non-stream)
x-penai-usage: in=27;out=8
```

## 10. Quản trị (phía PenAI)

Chính sách theo key nằm ở bảng `api_key_policies` (chưa có UI):

```sql
-- Cấp key cho một app: chỉ 2 model, 60 request/phút, 2 request song song
INSERT INTO api_key_policies (api_key_id, workspace_id, models, rpm, max_concurrent, note)
SELECT id, workspace_id, '["penai-fast","penai-image"]'::jsonb, 60, 2, 'app CRM'
FROM api_keys WHERE key_prefix = 'psk_xxxxxxx';

-- Kill-switch tức thì (có hiệu lực sau tối đa 60s vì cache policy)
UPDATE api_key_policies SET paused = true WHERE api_key_id = '...';

-- Xem app nào tốn bao nhiêu
SELECT day, model, requests, input_tokens, output_tokens, images, errors
FROM api_usage_daily ORDER BY day DESC, requests DESC LIMIT 20;
```

Key **không có** dòng policy thì **không bị giới hạn model** (production đang để
`api.defaultModels: []`): dùng được mọi alias, mọi `<provider>/<model>` trong phạm vi, và mọi agent.
Muốn siết một app cụ thể thì thêm dòng policy cho key đó — policy luôn thắng mặc định.

Giám sát hàng đợi: `GET /v1/api/status` → `queue` (running/queued/limit theo provider) và
`cooldowns` (ứng viên đang bị nghỉ vì lỗi).

## 11. Giới hạn cần biết

- **Agent chạy trên `claude-code`/`antigravity` không stream token** — agent luôn có tool, mà hai
  CLI này trả nguyên khối khi có tool. Muốn stream thật thì đặt agent chạy `codex`.
- **Trần đồng thời rất thấp cho CLI**: `claude-code` và `antigravity` mỗi cái 1 việc, tổng 2.
  Lý do: mỗi tiến trình tốn ~220 MB RAM trên VPS chỉ còn ~1,1 GB. Đây là trần **dùng chung** với
  Dashboard, kênh chat và cron — không phải suất riêng của API.
- **Không có lưới an toàn API trả tiền**: mọi tài khoản subscription nghẽn → `503`.
- **Tool/function calling của client** (bạn tự khai `tools`) hiện chưa hỗ trợ ở raw mode.
