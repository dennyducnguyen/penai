# CSDL của workspace (🗃️ Dữ liệu)

Mỗi workspace có một **cơ sở dữ liệu (CSDL) riêng**: bảng PostgreSQL thật, không cần dịch vụ ngoài (Supabase, Google Sheets…). Dùng để lưu dữ liệu của các "app nhỏ" dựng bằng quy trình: khách hàng, đơn hàng, nhật ký đồng bộ, trạng thái…

Có 5 cách dùng chung một CSDL:

| Cách | Dùng khi |
|---|---|
| Dashboard → **🗃️ Dữ liệu** | Xem, sửa, thêm/xóa dòng; tạo bảng; nhập/xuất CSV; xem lịch sử; khôi phục |
| Bước **🗃️ Cơ sở dữ liệu** (`db`) trong quy trình | Quy trình tự đọc/ghi bảng (kéo thả, chọn thao tác hoặc viết SQL) |
| Agent khi chat trên trang Chat (tool `db_schema`, `db_query`) | Nhờ AI tạo bảng, nhập liệu, hỏi số liệu |
| API `/v1/db/*` (khóa `psk_`) | Phần mềm khác, Claude Code |
| MCP (quyền `db:read`, `db:write`) | Claude / ChatGPT gắn PenAI vào |

Token / refresh token **không** lưu ở CSDL — dùng **🔑 Khóa bí mật** (mã hóa, tự che trong nhật ký), quy trình tự ghi bằng bước 🔐 Khóa bí mật (mục 6).

## 1. Quyền

| Vai trò | Được làm |
|---|---|
| viewer (Chỉ xem) | Xem cấu trúc, đọc dữ liệu (SELECT) |
| operator, ws_admin | Đọc, ghi, tạo/sửa/xóa bảng |
| member, khách qua Zalo/Telegram | Không truy cập trực tiếp. Muốn cho khách tra cứu: làm quy trình có bước db, bật "Cho chạy từ chat" |

Bước db trong quy trình chạy bằng quyền **người sở hữu quy trình**. Khóa API theo vai trò của khóa. MCP: `db:read` chỉ đọc, `db:write` (tài khoản operator trở lên) được ghi + đổi cấu trúc.

**Lệnh phá dữ liệu** — `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` không có `WHERE`, xóa cột — bị từ chối (HTTP 409) trừ khi gửi kèm `confirm: true`. Agent phải hỏi người dùng trước.

## 2. Viết SQL

PostgreSQL bình thường, không ghi tên schema (mỗi workspace một schema riêng, đã đặt sẵn):

```sql
CREATE TABLE don_hang (
  ma_don     text PRIMARY KEY,
  ngay_dat   timestamptz NOT NULL DEFAULT now(),
  khach      text,
  tong_tien  numeric NOT NULL DEFAULT 0,
  trang_thai text
);
COMMENT ON TABLE don_hang IS 'Đơn Shopee, quy trình dong-bo-don ghi mỗi giờ';
COMMENT ON COLUMN don_hang.trang_thai IS 'moi | dang_giao | da_giao | huy';
```

- **Giá trị từ người dùng/biến đi bằng tham số** `$1, $2…` + `params` — không ghép chuỗi vào câu lệnh.
- **Nhiều lệnh** cách nhau `;` chạy trong **một giao dịch**: lỗi một lệnh thì hủy cả gói. Có `params` thì chỉ một lệnh.
- **Được dùng**: `SELECT` (kể cả `WITH`, `JOIN`, `GROUP BY`, hàm thường), `INSERT … ON CONFLICT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE/ALTER/DROP TABLE|VIEW|INDEX|SEQUENCE|MATERIALIZED VIEW`, `TRUNCATE`, `COMMENT ON`, `EXPLAIN`.
- **Bị chặn**: `SET`/`RESET`, `BEGIN`/`COMMIT`, `DO`, `CREATE FUNCTION/TRIGGER/EXTENSION/SCHEMA`, `COPY`, `GRANT`, bảng tạm (`TEMP`), bảng/hàm hệ thống `pg_*`, `set_config`, `current_setting`, hàm chạy SQL động (`query_to_xml`…), tên schema khác (`public.…`). `information_schema` đọc được.
- **Giới hạn** (đổi được, mục 7): mỗi lệnh tối đa 15 giây, trả tối đa 1000 dòng (`truncated: true` khi bị cắt — dùng `WHERE`/`LIMIT`/`OFFSET`), CSDL tối đa 500 MB / workspace (vượt thì chỉ còn đọc và xóa).
- **Chạy thử** (`dryRun: true`): lệnh chạy thật trong giao dịch rồi **hoàn tác** — biết trước số dòng bị ảnh hưởng mà không lưu.

Kết quả: `{ rows, row (dòng đầu), count, fields, truncated, kind: read|write|ddl, dryRun, statements: [{command, rowCount}] }` — các trường của lệnh **cuối cùng**. Kiểu `bigint`/`numeric` trả về dạng chuỗi (vd `"120000"`); muốn số thì ép `::int` / `::float` trong SQL.

## 3. Bước `db` trong quy trình

**Viết SQL:**

```json
{ "id": "tong_ngay", "type": "db",
  "sql": "SELECT count(*)::int AS so_don, COALESCE(sum(tong_tien),0)::float AS doanh_thu FROM don_hang WHERE ngay_dat::date = $1::date",
  "params": ["{{ today() }}"] }
```

`sql` là chuỗi cố định — **không chèn `{{ }}`** (lưu sẽ báo lỗi). Biến đặt trong `params`.

**Dạng chọn (không cần SQL)** — Dashboard dựng sẵn form, agent cũng dùng được:

```json
{ "id": "luu_don", "type": "db", "op": "upsert", "table": "don_hang", "match": ["ma_don"],
  "values": { "ma_don": "{{ don.id }}", "tong_tien": "{{ don.total }}", "so_lan": { "$inc": 1 } } }
```

| Trường | Ý nghĩa |
|---|---|
| `op` | `find` (lấy dòng), `count`, `aggregate`, `insert`, `upsert` (thêm hoặc cập nhật theo khóa), `update`, `delete` |
| `table` | Tên bảng |
| `values` | `{ cột: giá trị }` — `{"$inc": n}` = cộng thêm n; object/mảng lưu dạng JSON |
| `match` | upsert: cột khóa (khóa chính hoặc cột UNIQUE) |
| `onConflict` | upsert: `update` (mặc định) hoặc `ignore` |
| `where` | `[{ col, op, value }]`, các điều kiện nối bằng AND. `op`: `eq` `ne` `gt` `gte` `lt` `lte` `contains` `starts` `in` (mảng hoặc "a,b,c") `null` `notnull` `sameday` |
| `columns` | find: cột lấy về (mặc định tất cả) |
| `agg`, `groupBy` | aggregate: `[{ fn: count|sum|avg|min|max, col, as }]`, `["cot"]` |
| `orderBy` | `"-ngay_dat,khach"` (dấu `-` = giảm dần) hoặc `[{col, dir}]` |
| `limit`, `offset` | Phân trang |
| `returning` | insert/upsert/update/delete trả lại dòng (mặc định true) |
| `confirm` | `true` khi cố ý sửa/xóa mọi dòng, DROP, TRUNCATE |

Kết quả dùng ở bước sau: `steps.<id>.output.rows` (đưa vào **Lặp danh sách**), `.row.<cột>`, `.count`. Nút **Xem SQL sẽ chạy** cho thấy câu lệnh thật; nút **Viết SQL** chuyển form thành SQL để sửa tiếp.

## 4. Trang 🗃️ Dữ liệu

- **Danh sách bảng** + dung lượng đã dùng / hạn mức.
- **＋ Bảng mới**: nhập tên bảng, cột (Chữ, Số nguyên, Số thập phân, Tiền, Ngày, Ngày giờ, Đúng/sai, JSON), khóa 🔑, duy nhất, bắt buộc, mặc định. Không chọn khóa thì tự có cột `id` tự tăng; mặc định thêm `tao_luc`, `sua_luc`. Nút **Xem SQL** cho thấy câu `CREATE TABLE`.
- Trong bước db của quy trình, **＋ Tạo bảng mới…** lấy sẵn cột + kiểu từ **kết quả chạy thử** của bước trước (vd danh sách đơn API trả về) và tự điền ô giá trị `{{ item.truong }}`.
- Tab **Dữ liệu**: phân trang, lọc, sắp xếp (bấm tiêu đề cột), bấm đúp vào ô để sửa, ✏️ sửa dòng, 🗑 xóa dòng, ＋ thêm dòng, ⬇ xuất CSV, ⬆ nhập CSV (dòng đầu là tên cột; `,` `;` hoặc tab; có thể xóa dữ liệu cũ trước).
- Tab **Cấu trúc**: cột, ràng buộc, chỉ mục; sửa ghi chú, đổi tên, thêm/xóa cột, xóa bảng (gõ lại tên để xác nhận); **Dùng bởi** — quy trình nào đọc/ghi bảng này.
- Tab **SQL**: ô chạy SQL (Ctrl+Enter), chạy thử.
- Tab **Lịch sử**: mọi lệnh ghi / đổi cấu trúc — ai, từ đâu (Dashboard, API, agent, MCP, quy trình), câu lệnh, số dòng, lỗi.
- Tab **Sao lưu**: bản chụp tự động mỗi ngày (giữ 7 bản) + **💾 Chụp ngay**; **↩ Khôi phục** một bảng = thay toàn bộ dữ liệu hiện tại của bảng bằng bản chụp (bảng đã xóa thì tạo lại).

## 5. API `/v1/db/*`

Xác thực: phiên Dashboard hoặc `Authorization: Bearer psk_…` (Dashboard → 🔑 Khóa API). Lỗi trả `{ "error": "…" }` tiếng Việt; 403 thiếu quyền, 409 cần `confirm`, 413 vượt hạn mức.

| Phương thức + đường dẫn | Việc |
|---|---|
| `GET /v1/db/schema` | Cấu trúc: `{ schema, sizeBytes, quotaBytes, tables: [{ name, kind, comment, rowsEstimate, columns: [{name, type, notNull, default, identity, primaryKey, unique, comment}], primaryKey, constraints, indexes }], usage, canWrite }`. `?format=text` → bản mô tả gọn cho AI |
| `POST /v1/db/query` | `{ sql, params?, confirm?, dryRun? }` → kết quả như mục 2 |
| `POST /v1/db/build` | Form bước db → `{ sql, params, kind, destructive }` (không chạy) |
| `GET /v1/db/tables/:bang/rows` | `?limit=50&offset=0&order=-cot&col=cot&q=chữ` → `{ rows, fields, total }` |
| `POST /v1/db/tables/:bang/rows` | `{ values }` thêm dòng |
| `PATCH /v1/db/tables/:bang/rows` | `{ key: { cot_khoa: giá_trị }, values }` sửa một dòng (bảng không có khóa chính: `ctid` lấy từ trường `_ctid`) |
| `DELETE /v1/db/tables/:bang/rows` | `{ key }` xóa một dòng |
| `POST /v1/db/tables` | `{ name, comment?, columns: [{ name, type, primaryKey?, unique?, notNull?, default?, comment? }], autoId?, timestamps?, preview? }` tạo bảng (`preview: true` chỉ trả SQL) |
| `PATCH /v1/db/tables/:bang` | `{ name?, comment? }` đổi tên / ghi chú |
| `DELETE /v1/db/tables/:bang?confirm=1` | Xóa bảng |
| `POST /v1/db/tables/:bang/columns` | Thêm cột `{ name, type, … }` |
| `PATCH /v1/db/tables/:bang/columns/:cot` | `{ name?, comment? }` |
| `DELETE /v1/db/tables/:bang/columns/:cot?confirm=1` | Xóa cột |
| `GET /v1/db/tables/:bang/export.csv` | Xuất CSV (UTF-8 có BOM, mở được bằng Excel) |
| `POST /v1/db/tables/:bang/import` | `{ csv, replace?, confirm? }` nhập CSV (tối đa 100.000 dòng, 20 MB) |
| `GET /v1/db/audit?limit=100` | Lịch sử thay đổi |
| `GET /v1/db/snapshots` · `POST /v1/db/snapshots` | Danh sách bản chụp · chụp ngay |
| `POST /v1/db/snapshots/:id/restore` | `{ table, confirm: true }` khôi phục một bảng |
| `POST /v1/db/suggest-columns` | `{ sample }` → gợi ý cột từ dữ liệu mẫu |

Ví dụ:

```bash
curl -s https://penai.example.com/v1/db/query -H "Authorization: Bearer psk_…" \
  -H "content-type: application/json" \
  --data-binary '{"sql":"SELECT * FROM don_hang WHERE trang_thai = $1 ORDER BY ngay_dat DESC LIMIT 20","params":["moi"]}'
```

## 6. Khóa bí mật mà quy trình tự ghi (token, refresh token)

Bước **🔐 Khóa bí mật** (`secret`):

| `op` | Việc |
|---|---|
| `set` | `{ name, value, expiresIn? ("3600" / "2h" / "30d" / "{{ … }}"), expiresAt?, note? }` — lưu mã hóa; giá trị tự che `***` trong mọi nhật ký của lần chạy, **kể cả bước trước** (vd bước gọi API vừa trả token) |
| `info` | → `{ exists, expiresAt, expiresInSec, expired, version, updatedAt, writable }` (không lộ giá trị) |
| `lock` | `{ name, wait? ("60s") }` — chờ tới lượt (chỉ một lần chạy giữ khóa), xong thì nạp lại giá trị khóa bí mật mới nhất. Tự nhả khi lần chạy kết thúc |
| `unlock` | Nhả khóa sớm |
| `delete` | Xóa khóa |

Khóa do quy trình tạo thì quy trình ghi được về sau. Khóa người nhập tay (🔑 Khóa bí mật) chỉ ghi được khi tick **Quy trình được ghi** — vd `REFRESH_TOKEN` đổi sau mỗi lần làm mới. Mẫu có sẵn: **Làm mới token OAuth** (Quy trình → 📋 Từ mẫu): `info` → hết hạn? → `lock` → `info` lại (lần chạy khác có thể vừa làm mới) → gọi API làm mới → `set` ACCESS + REFRESH → `unlock`.

API `POST /v1/secrets` nhận thêm `workflowWritable` (true/false) và `expiresAt` (ISO hoặc null).

## 7. Cấu hình (`/etc/<bản-cài>/penai.config.json5`, mọi khóa có mặc định)

```json5
workspaceDb: {
  enabled: true,
  quotaMb: 500,          // hạn mức mỗi workspace
  maxRows: 1000,         // số dòng trả về tối đa mỗi lệnh
  timeoutSeconds: 15,    // trần thời gian mỗi lệnh
  snapshotKeep: 7,       // bản chụp tự động giữ lại (0 = tắt)
  snapshotMaxMb: 50,     // CSDL lớn hơn thì không chụp tự động
},
```

## 8. Cách ly và an toàn (cho người bảo trì)

- Mỗi workspace một schema + một role PostgreSQL cùng tên `wsdb_<uuid không gạch>` (NOLOGIN, chỉ sở hữu schema của mình), tạo lần đầu dùng bằng hàm `wsdb_ensure()` (migration 0037).
- Câu lệnh chạy trong giao dịch: `statement_timeout`, `search_path` = schema của workspace, `SET LOCAL ROLE wsdb_…`; cuối giao dịch kiểm lại `current_user`. Lệnh chỉ đọc chạy trong giao dịch `READ ONLY`.
- Role của workspace không có quyền trên schema `public` (bảng của PenAI) — migration 0037 gỡ quyền mặc định `USAGE` của `PUBLIC`, cấp lại cho `penai_app`.
- Bộ kiểm câu lệnh dùng bộ phân tích cú pháp thật của PostgreSQL (`libpg-query`) — `packages/db/src/wsdb-guard.ts`.
- `sudo penai backup` (pg_dump cả database) đã gồm dữ liệu các workspace. Khôi phục sang cụm PostgreSQL mới: role được tạo lại tự động lần dùng đầu.
- Mã: `packages/db/src/wsdb.ts`, `wsdb-guard.ts`; `packages/core/src/workflow/db-query.ts` (dựng SQL từ form); `apps/server/src/wsdb-service.ts`, `wsdb-routes.ts`, `mcp-db-tools.ts`, `ui-database.ts`; tool `packages/tools/src/builtin/database.ts`.
