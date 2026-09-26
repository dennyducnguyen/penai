# PenAI API Reference (OpenAI-compatible)

Tài liệu tra cứu đầy đủ cho **máy gọi máy**: liệt kê mọi endpoint, công dụng, tham số, mẫu request
và mẫu response THẬT (chụp từ production 13/09/2026).

- Hướng dẫn ngắn cho người: `docs/api-public.md`
- Kiến trúc, lý do thiết kế, số đo, bẫy: `specs/spec-public-api-gateway.md`

---

## 0. Tóm tắt trong 10 dòng

```
Base URL : https://ai.example.com/v1
Auth     : Authorization: Bearer psk_...        (một loại key duy nhất)
Chuẩn    : OpenAI Chat Completions + Images     (dùng SDK openai được ngay)
Phục vụ  : codex (ChatGPT sub) · claude-code (Claude Max) · antigravity (agy) · agent PenAI  → §2b
KHÔNG có : embeddings, /v1/images/edits (sửa ảnh dùng penai.ref_images), /v1/files/:id, /v1/jobs, tool-calling do client khai
Model    : "penai-fast" | "penai-smart" | "penai-image" | "penai-image-codex" | "<provider>/<model>" | "agent:<key>"
Stream   : SSE chuẩn OpenAI; phần mở rộng nằm ở khóa "penai" BÊN TRONG chunk hợp lệ
File     : agent trả file qua penai.files[] + link https://ai.example.com/f/<token> (hạn 24h)
Lỗi      : khung OpenAI { error: { message, type, code, penai_request_id } }
Giới hạn : 120 req/phút, 4 request song song/key; claude-code & antigravity tổng 2 việc cùng lúc
```

---

## 1. Chọn endpoint nào

```
Cần sinh văn bản?
├─ Cần tool / kho tri thức / tạo file  →  POST /v1/chat/completions  model="agent:<key>"
└─ Chỉ cần model trả lời               →  POST /v1/chat/completions  model="penai-fast"

Cần ảnh?
├─ Ảnh từ mô tả / sửa ảnh / ảnh mẫu   →  POST /v1/images/generations   (20-55s, Antigravity → codex)
└─ Cần ảnh trong một quy trình dài     →  agent mode rồi đọc penai.files[]

Không biết có model/agent nào?         →  GET /v1/models
Bị 429 nhiều, muốn biết vì sao?        →  GET /v1/api/status
```

---

## 2. `GET /v1/models`

**Công dụng:** liệt kê model alias và agent mà key hiện tại được phép dùng. Gọi cái này trước khi
hardcode tên model — danh sách agent thay đổi theo workspace.

### Request

```bash
curl https://ai.example.com/v1/models \
  -H "Authorization: Bearer $PENAI_KEY"
```

### Response (thật)

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "penai-fast",
      "object": "model",
      "created": 0,
      "owned_by": "penai",
      "penai": {
        "streaming": "native",
        "route": ["codex/gpt-5.6-sol", "codex/gpt-5.5"],
        "kind": "chat"
      }
    },
    {
      "id": "penai-image",
      "object": "model",
      "created": 0,
      "owned_by": "penai",
      "penai": {
        "streaming": "none",
        "route": ["antigravity/gemini-3.7-flash-low", "codex/gpt-image-2"],
        "kind": "images"
      }
    },
    {
      "id": "penai-image-codex",
      "object": "model",
      "created": 0,
      "owned_by": "penai",
      "penai": { "streaming": "none", "route": ["codex/gpt-image-2"], "kind": "images" }
    },
    {
      "id": "agent:tro-ly",
      "object": "model",
      "created": 0,
      "owned_by": "penai",
      "penai": {
        "streaming": "native",
        "provider": "codex",
        "model": "gpt-5.6-sol",
        "name": "Trợ lý"
      }
    }
  ]
}
```

### `penai.streaming` — đọc trước khi bật `stream: true`

| Giá trị | Nghĩa |
|---|---|
| `native` | Luôn stream token thật |
| `none` | Model ảnh — không stream |
| `mixed` | Route có chặng CLI; chặng đầu stream thật, chặng dự phòng thì không |
| `tools_only` | Chỉ stream khi request không có tool |
| `emulated` | **Không stream token** — trả nguyên khối ở cuối (agent chạy trên `claude-code`/`antigravity`) |

---

## 2b. Provider và model có thật phía sau

Ba provider, đều là **gói thuê bao / CLI nằm trên VPS** — đó là lý do API này tồn tại.
Danh sách model lấy live ngày 13/09/2026; **đừng hardcode**, hỏi lại bằng
`GET /v1/providers/<tên>/models` (cần key ws_admin) hoặc dùng alias cho chắc.

| Provider | Là gì | Tạo ảnh | Stream token | Việc song song |
|---|---|---|---|---|
| `codex` | Tài khoản **ChatGPT subscription** qua OAuth (HTTP) | ✅ `gpt-image-2` — **dự phòng** | ✅ luôn luôn | 4 |
| `claude-code` | Gói **Claude Max** qua Claude Code CLI (spawn tiến trình) | ❌ | ⚠️ chỉ khi không có tool | **1** |
| `antigravity` | Gói **Google Antigravity Ultra** qua `agy` CLI (spawn tiến trình) | ✅ **mặc định** — tool `generate_image` (có sửa ảnh, ảnh tham chiếu) | ⚠️ chỉ khi không có tool | **1** |

`claude-code` + `antigravity` còn bị **trần chung 2 việc cùng lúc** (RAM: mỗi tiến trình ~220 MB).

### Model của `codex` (ChatGPT subscription)

```
gpt-6-astra · gpt-5.6-sol · gpt-5.6-terra · gpt-5.6-luna · gpt-5.5 · gpt-reserve · codex-auto-review
```

Dùng: `"model": "codex/gpt-5.6-sol"` — hoặc alias `penai-fast` (`gpt-5.6-sol`, hỏng thì `gpt-5.5`).

**Dự phòng tự động khi ChatGPT chạm limit (14/09/2026)**: gọi thẳng `codex/<model>` mà codex trả
429 (limit 5 giờ), 5xx, hết tài khoản, hay 400 "model not supported" **trước khi có byte nào** →
cùng lời gọi đó chạy tiếp trên `antigravity/gemini-3.7-flash-medium` (config `api.fallback`).
App không phải làm gì: response vẫn `model: "codex/gpt-5.6-sol"`, chỉ `penai.route` /
`x-penai-route` báo provider thật. Chặng codex bị cooldown (tôn trọng `Retry-After`) rồi tự quay lại.
Lưu ý antigravity chỉ chạy 1 tiến trình đồng thời — lúc codex nghẽn mà bắn nhiều request song song
thì từ request thứ 2 xếp hàng, quá 30 s nhận 429.

**Danh sách này phụ thuộc GÓI ChatGPT của tài khoản, và đổi ngay khi gói đổi.** 13/09/2026 gói Plus
hết hạn, tài khoản tụt về `free`: `gpt-5.6-sol` và `gpt-6-astra` biến mất khỏi danh sách và mọi lời
gọi trả 400 `The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account`.
Gia hạn Plus xong là có lại ngay (token OAuth tự làm mới rồi nhận gói mới).

Vì vậy: **đừng hardcode tên model**, và **nên dùng alias** — alias có chặng dự phòng nên vẫn chạy
khi một model biến mất.

Nếu cần che cho app ngoài trong lúc sự cố, PenAI có sẵn cơ chế đổi tên model ở tầng provider
(`providers.codex.modelRewrites` trong config, vd `{"gpt-5.6-sol": "gpt-5.6-terra"}`) — mặc định
**rỗng**, không đổi gì. Khi bật, `penai.route` / `x-penai-route` vẫn báo model THẬT đã chạy, không
báo tên bạn xin.

### Model của `claude-code` (Claude Max)

```
claude-sonnet-5 · claude-opus-5 · claude-haiku-4-5 · fable
claude-opus-4-8 · claude-opus-4-7 · claude-opus-4-6 · claude-sonnet-4-6
bí danh ngắn: sonnet · opus · haiku
```

Dùng: `"model": "claude-code/sonnet"`.

### Model của `antigravity` (Google Ultra)

```
gemini-3.8-flash-{high,medium,low} · gemini-3.7-flash-{high,medium,low}
gemini-3.6-flash-{high,medium,low} · gemini-3.1-pro-{high,low}
claude-sonnet-4-6 · claude-opus-4-6-thinking · gpt-oss-120b-medium
```

Dùng: `"model": "antigravity/gemini-3.7-flash-high"`.
**Lưu ý:** mức suy luận của Gemini đã nằm TRONG tên model (`-high`/`-medium`/`-low`); với những
model đó `reasoning_effort` bị bỏ qua (tránh truyền trùng). Các model không có hậu tố mức —
`claude-sonnet-4-6`, `claude-opus-4-6-thinking` — thì `reasoning_effort` vẫn có tác dụng.

---

## 3. `POST /v1/chat/completions`

**Công dụng:** sinh văn bản. Hai chế độ, chọn bằng tên `model`.

### 3.1 Tham số

| Trường | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|
| `model` | string | — | **bắt buộc**. Xem §3.2 |
| `messages` | array | — | **bắt buộc**, ≥1. Role: `system`, `developer`, `user`, `assistant`, `tool` |
| `stream` | bool | `false` | |
| `stream_options.include_usage` | bool | `false` | Thêm `usage` vào chunk cuối |
| `max_tokens` / `max_completion_tokens` | int | — | 1…200000 |
| `reasoning_effort` | enum | — | `minimal` \| `low` \| `medium` \| `high`. **Không có `off` — bỏ trường đi là off.** Xem §3.2b |
| `user` | string | — | Định danh người dùng cuối → thư mục/bộ nhớ riêng ở agent mode |
| `penai.conversation_id` | string | — | **Agent mode**: neo hội thoại bền (xem §3.4) |
| `penai.reasoning_effort` | enum | — | Như trên, ưu tiên hơn trường gốc. **Agent mode chỉ đọc trường này** (§3.2b) |
| `penai.return_files` | enum | `url` | `url` \| `b64` \| `none` (xem §3.6) |
| `penai.url_ttl_hours` | int | 24 | Hạn link file, trần 168 |

`messages[].content` nhận cả chuỗi lẫn mảng phần tử (`{type:"text",text}` /
`{type:"image_url",image_url:{url}}`). Ảnh chỉ dùng cho lượt user cuối, tối đa 8 ảnh.

**Không hỗ trợ:** `tools` / `functions` do client khai, `temperature`, `top_p`, `n>1`, `logprobs`,
`response_format`. Gửi lên cũng không lỗi, chỉ bị bỏ qua.

### 3.2 Đặt tên model

| Dạng | Ví dụ | Ý nghĩa |
|---|---|---|
| Alias ảo | `penai-fast` | Server tự chọn provider/model theo route cấu hình. **Nên dùng** |
| Ép provider | `codex/gpt-5.6-sol`, `claude-code/sonnet` | Debug. Cần policy cho phép |
| Agent | `agent:tro-ly` | Chạy agent PenAI đầy đủ |

### 3.2b Mức suy luận (`reasoning_effort`) — đọc kỹ, có bẫy

Cả ba provider đều nhận, nhưng xử lý khác nhau:

| Provider | Cách áp dụng |
|---|---|
| `codex` | Gửi `reasoning: { effort }` lên ChatGPT. Đây là nơi tham số này có ý nghĩa rõ nhất |
| `claude-code` | Truyền `--effort` cho CLI; `minimal` được tự hạ thành `low` |
| `antigravity` | Truyền `--effort`, **trừ khi** tên model đã có hậu tố `-high`/`-medium`/`-low` (lúc đó bỏ qua) |

Hai chỗ truyền, tương đương:

```jsonc
{ "model": "codex/gpt-5.6-sol", "reasoning_effort": "low", "messages": [...] }
{ "model": "codex/gpt-5.6-sol", "penai": { "reasoning_effort": "low" }, "messages": [...] }
```

Gửi cả hai thì `penai.reasoning_effort` thắng.

| Giá trị | Ghi chú |
|---|---|
| *(bỏ hẳn trường)* | **Đây chính là "off"** — server không gửi `reasoning` lên, model dùng mặc định |
| `minimal` | **`gpt-5.6-*` TỪ CHỐI** → 400 `'minimal' is not supported with the 'gpt-5.6-sol' model`. Chỉ dùng cho model đời cũ hơn |
| `low` / `medium` / `high` | Chạy tốt trên `gpt-5.6-*` (đã đo) |

**Không có giá trị `"off"`.** Truyền `"off"` sẽ bị từ chối ở tầng validate (400 `invalid_request`).

Đo thật trên `gpt-5.6-sol`, cùng một bài toán: `high` → 2.586 ms / 47 completion token, trả lời
đúng. Lỗi từ nhà cung cấp (như `minimal` ở trên) được trả nguyên văn trong `message` của
`503 all_routes_exhausted`, không bị nuốt.

> ⚠️ **Hạn chế đã biết ở agent mode (13/09/2026, sẽ sửa):**
> 1. Agent mode **chỉ đọc `penai.reasoning_effort`**, bỏ qua `reasoning_effort` ở cấp gốc.
>    Raw mode nhận cả hai.
> 2. Agent mode **bỏ qua mức thinking đã cấu hình sẵn của agent** (cột `thinking_level`). Nghĩa là
>    cùng một agent: gọi qua Telegram/Dashboard thì chạy đúng mức đã đặt, gọi qua API thì chạy
>    **không thinking** trừ khi bạn truyền `penai.reasoning_effort`.
>
> Cho tới khi sửa: ở agent mode hãy **luôn truyền tường minh** `penai.reasoning_effort` nếu cần
> suy luận sâu.

---

### 3.3 raw mode — stateless

Server dùng **TRỌN** `messages[]` bạn gửi. Không lưu session, không tool, không file.

```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PENAI_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "penai-fast",
    "messages": [
      { "role": "system",    "content": "Bạn trả lời bằng tiếng Việt, thật ngắn." },
      { "role": "user",      "content": "Mã bí mật của tôi là XANH-42." },
      { "role": "assistant", "content": "Đã ghi nhận." },
      { "role": "user",      "content": "Mã bí mật của tôi là gì?" }
    ]
  }'
```

Response (thật):

```jsonc
{
  "id": "chatcmpl-552898959fe445aa86dee182",
  "object": "chat.completion",
  "created": 1789234242,
  "model": "penai-fast",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "Mã bí mật của bạn là **XANH-42**." },
      "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 27, "completion_tokens": 47, "total_tokens": 74 },
  "penai": {
    "route": "codex/gpt-5.6-sol",
    "request_id": "req_3c97c4a39ed04643a667d94c",
    "queued_ms": 0
  }
}
```

### 3.4 agent mode — có tool, vault, file

```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PENAI_KEY" -H "content-type: application/json" \
  -d '{
    "model": "agent:tro-ly",
    "messages": [{ "role": "user", "content": "Bạn là agent gì?" }],
    "penai": { "conversation_id": "crm-ticket-8812" }
  }'
```

Response (thật):

```jsonc
{
  "id": "chatcmpl-3219bd7d63db4f81bd6bcea4",
  "object": "chat.completion",
  "created": 1789234301,
  "model": "agent:tro-ly",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant",
                   "content": "Tôi là Trợ lý AI của công ty..." },
      "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 6864, "completion_tokens": 30, "total_tokens": 6894 },
  "penai": {
    "route": "codex/gpt-5.6-sol",
    "request_id": "req_32a513a33c1043bebeb9922a",
    "queued_ms": 0,
    "agent": "tro-ly",
    "session_id": "<uuid-phiên>",
    "conversation_id": "crm-ticket-8812"
  }
}
```

**Hai cách quản ngữ cảnh — chọn một, đừng trộn:**

| | Có `penai.conversation_id` | Không có |
|---|---|---|
| Bạn gửi | **Chỉ lượt user mới** | **Toàn bộ lịch sử** |
| Server làm | Tra session đã neo, nạp tiếp | Tạo session tạm, nạp cả mảng |
| Dùng khi | Chatbot nhiều lượt, tiết kiệm băng thông | Gọi một phát, hoặc bạn tự quản lịch sử |

Gửi cả lịch sử **kèm** `conversation_id` sẽ làm nội dung lặp — server chỉ lấy lượt cuối.

### 3.5 Streaming

```bash
curl -N https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PENAI_KEY" -H "content-type: application/json" \
  -d '{"model":"penai-fast","stream":true,
       "stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"Đếm từ 1 đến 5"}]}'
```

Luồng sự kiện (rút gọn, thật):

```
data: {"id":"chatcmpl-4fd8...","object":"chat.completion.chunk","created":1789234257,
       "model":"penai-fast","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"content":"1\n"},"finish_reason":null}]}

: ping

data: {...,"choices":[{"index":0,"delta":{}}],"penai":{"queued":{"position":1,"eta_ms":3200}}}

data: {...,"choices":[{"index":0,"delta":{}}],"penai":{"tool_call":{"name":"vault_search"}}}

data: {...,"choices":[{"index":0,"delta":{}}],
       "penai":{"file":{"id":"f_d514cc85","name":"bao-cao.txt","content_type":"text/plain",
                        "bytes":82,"url":"https://ai.example.com/f/DQ9g...",
                        "expires_at":"2026-09-13T17:44:19.482Z"}}}

data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
       "usage":{"prompt_tokens":28,"completion_tokens":71,"total_tokens":99},
       "penai":{"route":"codex/gpt-5.6-sol","request_id":"req_...","queued_ms":0}}

data: [DONE]
```

**Quy tắc quan trọng khi parse:** mọi phần mở rộng của PenAI nằm ở khóa `penai` **bên trong một
chunk hợp lệ** (chunk vẫn có `choices`). Không có `event:` riêng. Nhờ vậy SDK openai chuẩn không
vỡ, và code `chunk.choices[0].delta.content` luôn an toàn.

| Khóa | Xuất hiện khi |
|---|---|
| `penai.queued` | Request phải xếp hàng — `{position, eta_ms}` |
| `penai.tool_call` | Agent gọi tool — `{name}` |
| `penai.file` | Agent trả file |
| `penai.route` / `request_id` / `queued_ms` / `files` | Chunk cuối |

Server gửi comment `: ping` mỗi 15 giây khi chưa có nội dung. **Đừng đặt idle timeout < 30 s.**
Đóng kết nối = server huỷ luôn lượt chạy (tiến trình CLI bị kill trong ~5 s).

### 3.6 Agent trả file

```jsonc
// request
{ "model": "agent:tro-ly",
  "messages": [{ "role": "user",
                 "content": "Tạo file bao-cao-test.txt 3 dòng rồi gửi cho tôi bằng send_file" }] }
```

```jsonc
// response (thật)
{
  "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant",
    "content": "Đã tạo và gửi file **bao-cao-test.txt**.\n\n[bao-cao-test.txt](https://ai.example.com/f/DQ9g-Q_...)"
  }}],
  "usage": { "prompt_tokens": 20943, "completion_tokens": 123, "total_tokens": 21066 },
  "penai": {
    "route": "codex/gpt-5.6-sol",
    "agent": "tro-ly",
    "session_id": "<uuid-phiên>",
    "files": [{
      "id": "f_d514cc8559dbde951263f0d7",
      "name": "bao-cao-test.txt",
      "content_type": "text/plain; charset=utf-8",
      "bytes": 82,
      "url": "https://ai.example.com/f/<token>",
      "expires_at": "2026-09-13T17:44:19.482Z"
    }],
    "tool_calls": [{ "name": "write_file" }, { "name": "send_file" }]
  }
}
```

| `penai.return_files` | Hành vi |
|---|---|
| `url` (mặc định) | Link `/f/<token>`, hạn 24h. Link cũng được chèn markdown vào `content` |
| `b64` | Nhúng `b64_json` cho file ≤ 1 MB; vượt thì tự hạ về link + `downgraded: true` |
| `none` | Chỉ metadata, không tạo link |

Link `/f/<token>` là **public-by-token**: không cần header, ai có link đều mở được. Tải bằng
`curl -L <url>`.

---

## 4. `POST /v1/images/generations`

**Công dụng:** tạo ảnh, **sửa ảnh** hoặc tạo ảnh **dựa trên ảnh tham chiếu**, không cần agent.

**Chạy ở đâu (từ 13/09/2026):** mặc định **Antigravity** (gói Google Ultra, tool `generate_image`
của `agy`, hạn mức lớn) → **codex** (ChatGPT subscription, `gpt-image-2`) làm dự phòng: agy lỗi,
hoặc agy đang bận ảnh khác thì codex làm ngay thay vì bắt bạn chờ. `penai.route` trong response cho
biết ảnh thật sự do ai tạo.

Thời gian thật (đo trên production): agy tạo mới **20–35 s**, sửa ảnh / có ảnh tham chiếu **35–55 s**;
codex **20–35 s**. Chữ tiếng Việt có dấu trên ảnh: agy vẽ đúng.

### Muốn dùng ChatGPT (codex) thay vì Antigravity

Chọn một trong ba cách (tương đương nhau):

```jsonc
{ "model": "penai-image-codex", ... }                          // alias chỉ có codex
{ "model": "penai-image", "penai": { "provider": "codex" } }  // ép provider
{ "model": "codex/gpt-image-2", ... }                          // dạng provider/model
```

Ngược lại, ép chỉ Antigravity (không rơi sang codex): `"penai": { "provider": "antigravity" }`.

### Request — tạo ảnh mới

```bash
curl https://ai.example.com/v1/images/generations \
  -H "Authorization: Bearer $PENAI_KEY" -H "content-type: application/json" \
  -d '{
    "model": "penai-image",
    "prompt": "Banner quảng cáo bia lon xanh trên bàn gỗ, chữ lớn: \"GIẢM 20% HÔM NAY\"",
    "n": 1,
    "response_format": "url",
    "penai": { "aspect_ratio": "16:9", "url_ttl_hours": 24 }
  }'
```

### Request — sửa ảnh / dùng ảnh tham chiếu

Gửi ảnh dạng **data URL base64** trong `penai.ref_images` (tối đa 5 ảnh, ~10 MB/ảnh). Prompt mô tả
cần đổi gì — "chỉ đổi dòng chữ thành MUA 1 TẶNG 1, giữ nguyên mọi thứ khác" — hoặc cách dùng ảnh mẫu —
"in logo trong ảnh lên cốc cà phê".

```bash
IMG=$(base64 -w0 banner.jpg)
curl https://ai.example.com/v1/images/generations \
  -H "Authorization: Bearer $PENAI_KEY" -H "content-type: application/json" \
  -d "{
    \"model\": \"penai-image\",
    \"prompt\": \"Chỉ đổi dòng chữ lớn thành: MUA 1 TẶNG 1. Giữ nguyên bối cảnh, lon bia, người, bố cục.\",
    \"penai\": { \"ref_images\": [\"data:image/jpeg;base64,$IMG\"] }
  }"
```

| Trường | Mặc định | Ghi chú |
|---|---|---|
| `prompt` | — | **bắt buộc**, ≤ 32000 ký tự |
| `size` | `1024x1024`; có `ref_images`/`aspect_ratio` thì `auto` | `1024x1024` \| `1536x1024` \| `1024x1536` \| `auto` |
| `n` | 1 | **trần 4** — mỗi ảnh là một lời gọi riêng, thời gian cộng dồn |
| `response_format` | `url` | `url` \| `b64_json` |
| `penai.url_ttl_hours` | 24 | trần 168 |
| `penai.provider` | theo route của model | `antigravity` \| `codex` — ép đúng một provider, không dự phòng |
| `penai.aspect_ratio` | — | `W:H`, vd `16:9`, `9:16`, `4:5`, `3:2`, `21:9`. Thắng `size`. agy dùng tỷ lệ gần nhất; codex quy về ngang/dọc/vuông |
| `penai.ref_images` | — | mảng data URL `data:image/...;base64,...`, tối đa 5 |

SDK: JS truyền thẳng khóa `penai` vào `client.images.generate({...})`; Python dùng
`extra_body={"penai": {...}}`.

### Response (thật)

```jsonc
{
  "created": 1789234370,
  "data": [{
    "url": "https://ai.example.com/f/<token>",
    "expires_at": "2026-09-13T17:32:50.018Z",
    "penai": { "route": "antigravity/gemini-3.7-flash-low", "bytes": 705334 }
  }]
}
```

`penai.route`: `antigravity/<model chở lời gọi tool>` hoặc `codex/gpt-image-2`. Ảnh từ agy là **JPEG**
(link `/f/` trả đúng `content-type`), từ codex là PNG.

Với `response_format: "b64_json"`:

```jsonc
{ "created": 1789234370,
  "data": [{ "b64_json": "/9j/4AAQ...", "penai": { "route": "antigravity/gemini-3.7-flash-low", "bytes": 892871 } }] }
```

**Bẫy đã biết:**
- **Sửa ảnh giữ khung ảnh gốc**: có `ref_images` mà không ghi `size`/`aspect_ratio` thì PenAI đọc kích
  thước ảnh tham chiếu đầu tiên và giữ tỷ lệ đó (trước bản vá, agy trả vuông và cắt mất hai bên banner
  16:9). Ghi `size`/`aspect_ratio` rõ ràng thì theo cái bạn ghi.
- Kích thước ảnh **không đúng từng pixel** như `size` xin: agy trả 1024×1024 (1:1) hoặc 1376×768
  (16:9); codex từng trả 1254×1254 khi xin 1024×1024. Cần kích thước chính xác thì crop/resize hậu kỳ.
- agy chỉ chạy **1 ảnh cùng lúc** (tiến trình CLI ~220 MB, trần chung với chat). Nhiều request song
  song thì request sau tự sang codex; ép `penai.provider: "antigravity"` thì phải xếp hàng (chờ quá
  30 s → `429`).

---

## 5. `GET /v1/api/status`

**Công dụng:** xem hàng đợi và cooldown — dùng để chẩn đoán khi bị 429 nhiều hoặc phản hồi chậm.

```bash
curl https://ai.example.com/v1/api/status -H "Authorization: Bearer $PENAI_KEY"
```

```jsonc
{
  "enabled": true,
  "queue": {
    "codex":       { "running": 0, "queued": 0, "limit": 4, "recentMedianMs": 3277 },
    "claude-code": { "running": 0, "queued": 0, "limit": 1, "recentMedianMs": 3212 },
    "antigravity": { "running": 1, "queued": 0, "limit": 1, "recentMedianMs": 26990 }
  },
  "cooldowns": [],
  "models": ["penai-fast", "penai-smart", "penai-image", "penai-image-codex"]
}
```

`antigravity` đang `running: 1` nghĩa là agy đang bận một việc (chat hoặc ảnh) — ảnh mặc định lúc
đó sẽ do codex làm, trừ khi ép `penai.provider: "antigravity"` (khi đó phải xếp hàng).

`cooldowns[]` có phần tử nghĩa là một ứng viên provider/model đang bị nghỉ vì lỗi:
`{ key, cooldownSec, streak, lastError }`.

---

## 6. Header phản hồi

| Header | Ý nghĩa |
|---|---|
| `x-request-id` | `req_...` — đưa vào báo lỗi để tra log |
| `x-penai-route` | `provider/model` **đã thực sự phục vụ** — có thể khác model bạn xin nếu model đó bị nhà cung cấp gỡ (§2b) |
| `x-penai-stream` | `native` \| `emulated` |
| `x-penai-queue-position` | Có khi phải xếp hàng (non-stream) |
| `x-penai-usage` | `in=27;out=8` |
| `retry-after` | Kèm mọi lỗi 429 (giây) |

---

## 7. Lỗi

Khung chuẩn OpenAI, SDK bắt được:

```jsonc
{ "error": {
    "message": "Key không được dùng model \"claude-code/sonnet\"",
    "type": "invalid_request_error",
    "code": "model_not_allowed",
    "param": "model",
    "penai_request_id": "req_4f2ce32083724b269625945d"
} }
```

| HTTP | `code` | Nguyên nhân | Nên làm gì |
|---|---|---|---|
| 400 | `invalid_request` | Thiếu `messages`/`model`, body sai | Sửa request |
| 401 | `invalid_api_key` | Key sai / thu hồi / hết hạn | Kiểm tra key |
| 403 | `model_not_allowed` | Policy của key không cấp model đó | Gọi `/v1/models` xem được dùng gì |
| 403 | `agent_not_allowed` | Policy không cấp agent đó | Như trên |
| 403 | `provider_not_allowed` | Dạng `provider/model` với provider ngoài phạm vi | Dùng alias |
| 403 | `ip_not_allowed` | IP không trong allowlist (mặc định allowlist TẮT) | Báo quản trị |
| 403 | `key_paused` | Key bị tạm dừng | Báo quản trị |
| 404 | `model_not_found` | Alias không tồn tại | Gọi `/v1/models` |
| 413 | `payload_too_large` | Body quá lớn | Cắt bớt |
| 429 | `rate_limit_exceeded` | Vượt 120 req/phút | **Chờ `Retry-After`** |
| 429 | `too_many_concurrent` | Vượt 4 request song song, hoặc hàng đợi provider đầy | Giảm song song |
| 429 | `quota_exceeded` | Vượt hạn mức token tháng | Báo quản trị |
| 503 | `all_routes_exhausted` | Mọi ứng viên provider đều hỏng | Đọc `message` — có lý do từng chặng |
| 500 | `internal_error` | Lỗi server | Gửi `penai_request_id` cho quản trị |

**Quy tắc retry:** chỉ retry 429 và 503, có backoff, tôn trọng `Retry-After`. Đừng retry 4xx khác.
Phía sau là tài khoản subscription, không phải API trả tiền co giãn — spam retry sẽ làm khoá cả pool.

---

## 8. Giới hạn phải biết trước khi thiết kế app

| Giới hạn | Con số | Vì sao |
|---|---|---|
| Request/phút mỗi key | 120 (burst 20) | Cấu hình `api.rateLimit` |
| Request song song mỗi key | 4 | Cấu hình `api.rateLimit.maxConcurrentPerKey` |
| **Việc song song của `claude-code`** | **1** | Mỗi tiến trình `claude` tốn ~217 MB RAM |
| **Việc song song của `antigravity`** | **1** | ~221 MB RAM |
| **Tổng việc CLI cùng lúc** | **2** | VPS chỉ còn ~1,1 GB trống |
| Việc song song của `codex` | 4 | Pool hiện chỉ có 1 tài khoản ChatGPT |
| Hàng đợi mỗi provider | 20 việc, chờ tối đa 30 s | Quá thì `429` chứ không chờ vô hạn |
| Ảnh mỗi request | `n ≤ 4` | |
| File nhúng base64 | ≤ 1 MB | Vượt thì tự hạ về link |
| Hạn link file | 24 h (trần 168 h) | |

**Trần CLI là dùng CHUNG** với Dashboard, kênh chat (Telegram/Teams/Zalo) và cron — không phải
suất riêng của API. Lưu lượng của người dùng thật được ưu tiên trước lưu lượng API.

---

## 9. Ba điều dễ hiểu nhầm

1. **Agent chạy trên `claude-code`/`antigravity` KHÔNG stream token.** Agent luôn có tool, mà hai
   CLI này trả nguyên khối khi có tool. Client sẽ chờ im lặng rồi nhận một cục ở cuối. Kiểm tra
   trước bằng `penai.streaming` trong `/v1/models`, hoặc header `x-penai-stream: emulated`.
2. **Không có lưới an toàn API trả tiền.** Mọi tài khoản subscription nghẽn cùng lúc → `503`.
   App phải có đường xử lý khi PenAI không trả lời được.
3. **`conversation_id` chỉ có tác dụng ở agent mode.** Ở raw mode nó bị bỏ qua (raw mode stateless
   hoàn toàn — ngữ cảnh nằm trong `messages[]` bạn gửi).
4. **`reasoning_effort` không có `off`, và agent mode đang bỏ qua mức thinking của agent.**
   Xem §3.2b — đây là hạn chế đã biết, chưa sửa.
5. **Với model Gemini đã có hậu tố mức** (`gemini-3.7-flash-high`…), `reasoning_effort` bị bỏ qua —
   mức suy luận nằm sẵn trong tên model.
6. **Model khả dụng phụ thuộc gói ChatGPT của tài khoản** (§2b) — gói hết hạn là mất model cao cấp
   ngay lập tức. Trường `model` trong phản hồi echo lại tên bạn gửi; `penai.route` mới là model
   thật đã chạy — khác nhau khi quản trị bật `modelRewrites`.

---

## 10. Mẫu client hoàn chỉnh

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PENAI_KEY,
  baseURL: "https://ai.example.com/v1",
  maxRetries: 2,              // SDK tự tôn trọng Retry-After
  timeout: 10 * 60 * 1000,    // agent có thể chạy vài phút
});

// văn bản
const r = await client.chat.completions.create({
  model: "penai-fast",
  messages: [{ role: "user", content: "Xin chào" }],
});

// stream
const stream = await client.chat.completions.create({
  model: "penai-fast", stream: true,
  messages: [{ role: "user", content: "Viết 3 câu về cà phê" }],
});
for await (const c of stream) {
  process.stdout.write(c.choices[0]?.delta?.content ?? "");
  if (c.penai?.file) console.log("\nFILE:", c.penai.file.url);
}

// agent nhiều lượt
const a = await client.chat.completions.create({
  model: "agent:tro-ly",
  messages: [{ role: "user", content: "Tóm tắt tình hình kho hôm nay" }],
  penai: { conversation_id: "daily-report" },
});
for (const f of a.penai?.files ?? []) console.log(f.name, f.url);

// ảnh (mặc định Antigravity, dự phòng codex)
const img = await client.images.generate({
  model: "penai-image", prompt: "A minimal flat icon of a blue paper airplane",
});
console.log(img.data[0].url, img.data[0].penai?.route);

// sửa ảnh / ảnh tham chiếu + tỷ lệ khung
const edited = await client.images.generate({
  model: "penai-image",
  prompt: "Chỉ đổi dòng chữ lớn thành: MUA 1 TẶNG 1. Giữ nguyên mọi thứ khác.",
  penai: { ref_images: [`data:image/jpeg;base64,${fs.readFileSync("banner.jpg").toString("base64")}`] },
});

// ép ChatGPT (codex)
const viaCodex = await client.images.generate({ model: "penai-image-codex", prompt: "..." });
```

```python
from openai import OpenAI
client = OpenAI(api_key=PENAI_KEY, base_url="https://ai.example.com/v1", timeout=600)

r = client.chat.completions.create(
    model="penai-fast",
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(r.choices[0].message.content)
```

---

## 11. Quản trị (phía PenAI, không phải phía app)

Tạo key: Dashboard → **Khóa API (tích hợp)**, đặt tên theo app, chọn role thấp nhất dùng được
(`viewer` đủ để gọi API này). Key hiện ra **một lần duy nhất**.

Gắn chính sách cho key (chưa có UI — dùng SQL):

```sql
INSERT INTO api_key_policies (api_key_id, workspace_id, models, agents, rpm, max_concurrent, note)
SELECT id, workspace_id,
       '["penai-fast","penai-image"]'::jsonb,   -- NULL = theo api.defaultModels
       '["tro-ly"]'::jsonb,                     -- NULL = MỌI agent
       60, 2, 'app CRM'
FROM api_keys WHERE name = 'app-crm';

UPDATE api_key_policies SET paused = true WHERE api_key_id = '...';   -- kill-switch

SELECT day, model, requests, input_tokens, output_tokens, images, errors
FROM api_usage_daily ORDER BY day DESC, requests DESC LIMIT 20;
```

Policy có **cache 60 giây** — sửa xong chờ tối đa 1 phút mới có hiệu lực.

**Key không có dòng policy = không giới hạn.** Production đang để `api.defaultModels: []`, nên key
nào (role `viewer` trở lên) cũng gọi được mọi alias, mọi `<provider>/<model>` thuộc `api.providers`,
và **mọi agent**. Thêm dòng policy là cách duy nhất để siết — policy luôn thắng mặc định.

> ⚠️ Key `psk_` dùng chung cho cả API này lẫn API quản trị cũ. Role `viewer` không ghi được, nhưng
> **đọc được** danh sách agent (kèm system prompt) và lịch sử phiên chat của cả workspace. Cấp key
> cho app nào thì cân nhắc điều đó.
