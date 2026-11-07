# Quy trình tự động (Workflow)

Dashboard → **⚙️ Quy trình**. Dùng để tự động hóa những việc **không cần AI**, hoặc chỉ cần AI ở một bước nhỏ. Quy trình được kích hoạt theo lịch, qua link webhook (đường link để hệ thống khác gọi vào), hoặc bấm tay. Mỗi lần chạy, các bước được thực hiện lần lượt: gọi API, chạy mã, rẽ nhánh, lặp, gửi tin vào Zalo/Telegram…, gọi tool/MCP, hoặc nhờ một agent làm một việc. Cách làm giống n8n nhưng đơn giản hơn và nằm luôn trong PenAI.

So với **Cron & lịch hẹn**: cron luôn chạy một agent AI (tốn lượt AI mỗi lần). Quy trình chạy thẳng các bước nên nhanh, rẻ, kết quả lặp lại giống nhau. Khi thật sự cần AI thì thêm một bước "Nhờ agent".

## 1. Tạo quy trình — 4 cách

| Cách | Dùng khi |
|---|---|
| **Dashboard** → ＋ Tạo mới / 📋 Từ mẫu / ⬆ Nhập JSON | Tự dựng bằng tay: kéo thả bước, điền form, bấm 🧪 Chạy thử |
| **Nhắn cho agent** ở trang Chat (tài khoản operator trở lên) | *"Mỗi sáng 8h gọi API đơn hàng, có đơn thì báo từng kho vào nhóm Telegram kinh doanh"*. Agent dùng bộ tool `workflow_*` để tạo, chạy thử, sửa, rồi gửi link |
| **API** `/v1/workflows` với khóa `psk_…` | Claude Code / phần mềm khác tạo từ xa (mục 6) |
| **MCP** (🔗 Kết nối AI bên ngoài) | Claude Desktop / ChatGPT / Claude Code kết nối qua OAuth, tick quyền *Quy trình* |

Mỗi lần lưu (do người, agent, API hay MCP) tạo một **phiên bản** mới; vào 🗂 Phiên bản để xem khác biệt và **hoàn về**. Agent hoặc AI bên ngoài vừa sửa thì trang dựng hiện dải "🤖 Agent vừa sửa".

## 2. Định dạng (JSON dạng cây)

```json
{
  "name": "Báo cáo đơn hàng sáng",
  "description": "Mỗi sáng lấy đơn, tổng hợp, báo từng kho vào nhóm.",
  "triggers": [
    { "type": "schedule", "cron": "0 8 * * 1-5" },
    { "type": "webhook", "methods": ["POST"], "respond": "wait" },
    { "type": "manual" }
  ],
  "inputs": { "ngay": { "type": "string", "default": "{{ today(-1) }}", "note": "YYYY-MM-DD" } },
  "settings": { "concurrency": "skip", "notifyOnError": { "channel": "telegram:Bot", "to": "1068263601" } },
  "steps": [
    { "id": "lay_don", "type": "http", "url": "https://api.example.com/orders?date={{ inputs.ngay }}",
      "headers": { "Authorization": "Bearer {{ secrets.API_KEY }}" }, "retry": { "times": 2, "delay": "10s" } },
    { "id": "tong_hop", "type": "code",
      "code": "const d = steps.lay_don.output.body.items; return { tong: sum(d, 'total'), kho: groupBy(d, 'kho') };" },
    { "id": "co_don", "type": "if", "cond": "steps.tong_hop.output.tong > 0",
      "then": [
        { "id": "tung_kho", "type": "loop", "over": "steps.tong_hop.output.kho", "as": "kho", "max": 50,
          "body": [ { "id": "bao", "type": "send", "channel": "telegram:Bot", "to": "-100123",
                      "text": "Kho {{ kho.key }}: {{ kho.count }} đơn" } ] },
        { "id": "nhan_xet", "type": "agent", "agent": "tro-ly",
          "message": "Viết 2 câu nhận xét: {{ json(steps.tong_hop.output) }}" },
        { "id": "tra_loi", "type": "respond", "status": 200, "body": { "ok": true, "tong": "{{ steps.tong_hop.output.tong }}" } }
      ],
      "else": [ { "id": "dung", "type": "stop", "reason": "Không có đơn" } ] }
  ]
}
```

Mỗi bước có `id` (chữ thường, số, `_`; duy nhất trong cả quy trình) và `type`. Các trường tùy chọn dùng chung cho mọi bước: `name`, `note`, `retry: {times, delay}`, `onError: "continue"` (lỗi vẫn chạy tiếp, `steps.<id>.error` chứa lỗi), `timeout: "30s"`, `disabled: true` (bỏ qua bước).

### Loại bước

| `type` | Trường chính | Kết quả (`steps.<id>.output`) |
|---|---|---|
| `http` | `method`, `url`, `headers`, `query`, `body`, `bodyType` (`json`/`form`/`text`), `failOnStatus: false` | `{ status, headers, body }` — body tự đọc JSON |
| `code` | `code` — JavaScript có `return` | giá trị return |
| `if` | `cond`, `then[]`, `else[]` | `{ branch }` |
| `switch` | `value`, `cases: [{ value \| when, steps[] }]`, `default[]` | `{ case, value }` |
| `loop` | `over` (mảng), `as`, `max` (≤ 1000), `body[]`; bước `break` để thoát | `{ count, items }` |
| `while` | `cond`, `max`, `body[]` | `{ count, items }` |
| `parallel` | `branches: [[…], […]]` (≤ 10 nhánh) | mảng kết quả từng nhánh |
| `wait` | `duration: "30s"` hoặc `until` (thời điểm) | — |
| `set` | `values: { ten: "{{ … }}" }` → dùng `vars.ten` | các giá trị |
| `stop` | `reason` — dừng, không tính là lỗi | — |
| `send` | `channel` (`"kiểu:Tên kênh"` hoặc id), `to` (cuộc trò chuyện), `text`, `files[]` | `{ sent }` |
| `tool` | `tool`, `args`, `agent` (tùy chọn: chạy bằng thư mục + quyền của agent đó) | kết quả tool (JSON nếu đọc được) |
| `mcp` | `server`, `tool`, `args` — gọi thẳng MCP, không qua AI | kết quả tool |
| `agent` | `agent` (key), `message`, `json: true` (bắt trả JSON), `deliver: { channel, to }` (gửi câu trả lời thẳng vào chat) | `{ text, json? }` |
| `respond` | `status`, `headers`, `body` — trả cho bên gọi webhook | — |
| `subworkflow` | `workflow` (id/slug), `inputs`, `wait` | `{ runId, status, output }` |
| `file` | `action` (`read`/`write`/`append`/`list`/`delete`), `path`, `content` | tùy thao tác |
| `shell` | `command`, `env` — cần `workflows.allowShell: true` và quản trị viên tick "Cho phép chạy" | `{ output }` |

**`to` của bước `send`**: Telegram = chat id (nhóm là số âm); Zalo/WhatsApp cá nhân = `direct:<uid>` hoặc `group:<id nhóm>`. Ô "Gửi tới" trên Dashboard gợi ý sẵn các cuộc trò chuyện gần đây. Tin gửi đi được ghi vào hội thoại đó, nên khi người dùng nhắn lại, agent biết vừa có tin gì.

**Bước `agent`** giao việc cho agent như một tin nhắn: agent dùng đủ tool, skill, kho tri thức của nó, chạy bằng quyền người sở hữu quy trình. Có `deliver` thì câu trả lời được gửi thẳng vào cuộc trò chuyện đó. Mỗi lượt tốn AI như chat thường. Việc nặng thì đặt `timeout` dài (vd `"5m"`).

### Biểu thức

- `"{{ biểu thức JS }}"` trong chuỗi. Nếu cả chuỗi chỉ là một `{{ }}` thì giữ nguyên kiểu (số, object…), tiện truyền JSON vào `body`/`args`.
- `cond`, `over`, `value` và bước `code` là JavaScript, chạy trong máy ảo cách ly QuickJS: không có `fetch`, `require` hay file, có giới hạn thời gian và bộ nhớ.
- Ngữ cảnh: `inputs.*`, `trigger.*` (webhook: `body`, `query`, `method`), `steps.<id>.output` / `.error` / `.durationMs`, `vars.*`, `workflow.runId`; trong vòng lặp có biến `as` (mặc định `item`), `index`, `loop.first/last`.
- Hàm có sẵn: `today(±ngày)`, `now()`, `formatDate(d, "DD/MM/YYYY HH:mm")`, `addDays`, `diffDays`, `weekday`, `json`, `parseJson`, `get(obj, "a.b")`, `num`, `sum(arr, key)`, `avg`, `min`, `max`, `count`, `groupBy(arr, key)` → `[{key, items, count}]`, `uniq`, `sortBy(arr, key, desc)`, `pluck`, `chunk`, `range`, `round`, `formatNumber`, `formatVND`, `slugify`, `truncate`, `base64`, `sha256`, `hmacSha256`. Ngày giờ tính theo múi giờ `timezone` của hệ thống.

### Khóa bí mật

Quy trình → 🔑 Khóa bí mật. Khóa được mã hóa bằng `PENAI_MASTER_KEY`, không bao giờ hiện lại, và tự che `***` trong nhật ký. Dùng bằng `{{ secrets.TEN }}`, **chỉ** trong bước http (url/headers/query/body), `mcp.args`, `tool.args` và `shell.env`. Đặt ở chỗ khác thì validator (bộ kiểm tra định nghĩa) báo lỗi.

## 3. Kích hoạt

| Trigger | Ghi chú |
|---|---|
| `schedule` | `cron` 5 trường (`0 8 * * 1-5`) hoặc `schedule: "every 15m"`, `timezone` (mặc định theo hệ thống). Tối thiểu 1 phút |
| `webhook` | Link `https://<tên-miền>/webhooks/workflow/<id>/<token>` (copy trên trang dựng). `methods`, `respond: "async"` (trả ngay `202 { runId, statusUrl }`) hoặc `"wait"` (chờ bước `respond`, không có thì trả kết quả bước cuối; quá `timeoutSec` → `504`, quy trình vẫn chạy nốt), `auth: "hmac"`, `rateLimit` |
| `manual` | Nút ▶ Chạy, tool `workflow_run`, API, MCP |

**Tham số webhook**: query string và body (JSON/form) được gộp vào `inputs`; tham số đã khai báo trong `inputs` được kiểm kiểu. Tham số không khai báo vẫn đọc được ở `trigger.body` và `trigger.query`.

**Ký HMAC** (`auth: "hmac"`) gửi kèm 3 header:
- `x-penai-timestamp`: mili giây hiện tại, lệch tối đa ±5 phút;
- `x-penai-nonce`: chuỗi ngẫu nhiên, mỗi lần một chuỗi khác;
- `x-penai-signature`: hex HMAC-SHA256(khóa, `timestamp + "." + body thô`).

Khóa HMAC xem trên trang dựng. Nút 🔄 Đổi link đổi cả token lẫn khóa.

```bash
curl -X POST 'https://<tên-miền>/webhooks/workflow/<id>/<token>' -H 'content-type: application/json' -d '{"ten":"An","sdt":"0901234567"}'
```

## 4. Chạy, xem kết quả, quyền

- **🧪 Chạy thử** chạy đúng bản đang sửa trên màn hình, chưa cần lưu. Mặc định là "dry run": bước gửi tin, POST, MCP, tool, ghi file chỉ hiện sẽ làm gì. Mỗi thẻ bước hiện ✓/✗ và kết quả; bấm vào bước để xem đầu vào/đầu ra.
- **🕘 Lịch sử**: mỗi quy trình giữ 200 lần chạy gần nhất (`workflows.keepRuns`). Trong ⚙ Cài đặt có thể đặt "Báo khi chạy lỗi" để gửi cảnh báo vào chat.
- **Người sở hữu**: lần chạy mang quyền hiện tại của người tạo, ws_admin đổi được. Người sở hữu mất quyền operator thì quy trình không chạy.
- **Ai làm gì**: viewer chỉ xem; operator và ws_admin tạo, sửa, chạy, xóa. Agent ở trang Chat chỉ quản lý được khi người đang chat là operator trở lên. Người dùng nhắn qua kênh (Zalo, Telegram…) chỉ được nhờ agent **chạy** các quy trình đã bật "Cho phép agent chạy khi được nhờ qua kênh chat" (`settings.allowFromChat`).
- **Tool cần duyệt** (custom tool có "cần duyệt", lệnh `exec`/`shell`): trong quy trình không có ai bấm duyệt lúc chạy, nên operator phải tick "Cho phép chạy không cần duyệt" cho từng bước đó. Agent và AI bên ngoài không tự tick được.
- **An toàn**: bước `http` chặn địa chỉ nội bộ (127.0.0.1, 10.x, 192.168.x, metadata đám mây…) và giới hạn phản hồi 5 MB; một lần chạy tối đa 10 phút; tối đa 100 bước, lồng 5 cấp, 100 quy trình đang bật mỗi workspace.
- Agent đang chạy theo lịch hoặc đang ở trong bước "Nhờ agent" không có tool `workflow_*`, để tránh vòng lặp quy trình gọi agent gọi quy trình.

## 5. Cấu hình (`/etc/<bản-cài>/penai.config.json5`, mọi khóa có mặc định)

```json5
workflows: {
  enabled: true,
  maxConcurrentRuns: 5,      // số lần chạy song song toàn hệ thống (còn lại xếp hàng)
  maxRunSeconds: 600,
  stepTimeoutSeconds: 30,    // http/code; tool/mcp/agent tối thiểu 120s
  keepRuns: 200,
  webhookRatePerMinute: 60,
  maxEnabledPerWorkspace: 100,
  maxSteps: 100,
  maxLoop: 1000,
  allowShell: false,         // bật bước shell (sandbox bubblewrap)
  allowPrivateNetwork: false // cho bước http gọi mạng nội bộ
}
```

Đổi cấu hình xong thì có hiệu lực ngay, không cần khởi động lại.

## 6. API (Claude Code / phần mềm khác)

Xác thực bằng `Authorization: Bearer psk_…`: Dashboard → 🔑 Khóa API, vai trò operator trở lên. Quy trình tạo qua API thuộc về người đã tạo khóa đó.

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| GET | `/v1/workflows` | Danh sách + thống kê 7 ngày |
| POST | `/v1/workflows` | Tạo: `{ definition, enabled?, note? }` hoặc `{ template: "<key>" }`. Lỗi trả `400 { error, issues: [{path, message}] }` |
| GET | `/v1/workflows/templates` · `/v1/workflows/catalog?kind=` | Mẫu có sẵn · danh mục kênh/tool/MCP/agent/khóa bí mật |
| POST | `/v1/workflows/validate` | Kiểm tra định nghĩa, không lưu |
| GET / PUT / DELETE | `/v1/workflows/:id` | Xem · thay toàn bộ (`{ definition, note?, expectVersion? }`) · xóa |
| PATCH | `/v1/workflows/:id` | `{ enabled }`, `{ ownerUserId }` (ws_admin) hoặc `{ ops: [...] }` |
| POST | `/v1/workflows/:id/run` · `/test` | `{ inputs, wait?, dryRun?, definition? (chỉ /test) }` |
| GET | `/v1/workflows/:id/runs` · `/runs/:runId` | Lịch sử · chi tiết từng bước |
| POST | `/v1/workflows/:id/runs/:runId/cancel` | Hủy lần đang chạy |
| GET / POST | `/v1/workflows/:id/versions` · `/versions/:v` · `/versions/:v/restore` | Phiên bản |
| POST | `/v1/workflows/:id/webhook/rotate` | Đổi link + khóa HMAC |
| GET | `/v1/workflows/:id/export` | Tải JSON |
| GET / POST / DELETE | `/v1/secrets` · `/v1/secrets/:name` | Khóa bí mật (không trả giá trị) |

`ops` dùng cho sửa nhỏ:
- `{op:"update_step", id, fields}`
- `{op:"insert", step, after? | before? | into: {id, key}}`, trong đó `key` là `then`, `else`, `body`, `default`, `branches[i]` hoặc `cases[i].steps`
- `{op:"remove_step", id}`
- `{op:"move_step", id, after? | before? | into?}`
- `{op:"set_step", id, step}`
- `{op:"set_triggers", triggers}`
- `{op:"set", key, value}`

Ví dụ với Claude Code:

```bash
curl -s https://<tên-miền>/v1/workflows -H "Authorization: Bearer $PENAI_KEY" -H 'content-type: application/json' \
  -d @quy-trinh.json
curl -s https://<tên-miền>/v1/workflows/<id>/test -H "Authorization: Bearer $PENAI_KEY" -H 'content-type: application/json' \
  -d '{"dryRun":true,"inputs":{"ngay":"2026-11-07"}}'
```

## 7. Tool cho agent

| Tool | Việc |
|---|---|
| `workflow_catalog` | `kind: "guide"` = hướng dẫn cú pháp; các nhóm khác = danh mục (kênh + cuộc trò chuyện, tool, MCP, agent, khóa bí mật, mẫu) để điền đúng tên |
| `workflow_create` · `workflow_update` | Tạo · sửa (JSON đầy đủ hoặc `ops`, bật/tắt) |
| `workflow_test` · `workflow_run` · `workflow_runs` | Chạy thử (mặc định dry run) · chạy thật · lịch sử/chi tiết |
| `workflow_list` · `workflow_get` · `workflow_delete` | Xem · xóa (cần người dùng xác nhận) |

Tắt cho một agent: Agents → Sửa → bỏ tick các tool `workflow_*`.
