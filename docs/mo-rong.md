# Bản fork nội bộ: thêm tính năng riêng mà vẫn nhận bản mới

Dành cho công ty muốn chạy PenAI với **tính năng riêng** (tích hợp phần mềm nội bộ, trang báo cáo riêng…) nhưng vẫn **cập nhật được tính năng mới** của bản chính thức.

## Mô hình

```
github.com/dennyducnguyen/penai        (bản chính thức — tag v1.18.0, v1.19.0 …)
        │  git merge v1.19.0
        ▼
github.com/<công-ty>/penai-<tên>       (bản fork riêng tư — tag v1.19.0-<tên>.1 …)
        │  sudo penai update
        ▼
máy chủ của công ty
```

Nguyên tắc để gộp bản mới **không xung đột**:

1. **Không sửa file lõi.** Tính năng riêng đặt trong các vùng riêng:
   - `apps/server/src/extensions/<tên>.ts`: gói mở rộng (route API, tool cho agent, trang Dashboard, việc chạy nền), xem mục dưới;
   - `packages/db/migrations/9001_<tên>.sql` trở lên: migration riêng (bản chính thức dùng `00xx`, không bao giờ trùng);
   - `internal/`: tài liệu nội bộ (máy chủ, quy trình vận hành).
2. Sửa lỗi hoặc tính năng dùng chung thì gửi về bản chính thức trước, rồi gộp lại về fork.
3. Cấu hình riêng (thương hiệu, provider, hạn mức) nằm trong `/etc/<bản-cài>/penai.config.json5` trên máy chủ, không nằm trong mã.

## Gói mở rộng (extension)

Máy chủ tự nạp mọi file `apps/server/src/extensions/*.ts` khi khởi động. Tên bắt đầu bằng `_` thì bỏ qua; một gói lỗi khi nạp chỉ ghi nhật ký, không làm hỏng máy chủ.

```ts
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PenaiExtension } from "../extensions.js";

const ext: PenaiExtension = {
  name: "bao-cao-noi-bo",
  // Route API — chạy sau xác thực (req.authCtx có workspace + vai trò)
  routes(app: FastifyInstance) {
    app.get("/v1/ext/bao-cao", async (req) => ({ workspace: req.authCtx.workspaceId }));
  },
  // Tool cho agent (có ở mọi agent; tắt từng agent ở Agents → Sửa)
  tools: [{
    name: "tra_ton_kho",
    description: "Tra tồn kho theo mã hàng trong phần mềm kho nội bộ",
    schema: z.object({ ma: z.string() }),
    async execute(args) { return `Mã ${args.ma}: còn 12`; },
  }],
  // Trang Dashboard (window.PenaiUI: addPage, api, el, esc, page, card, table, toast, state)
  uiScript: `PenaiUI.addPage("bao-cao", "📑", "Báo cáo nội bộ", function () {
    var m = PenaiUI.page("Báo cáo nội bộ");
    PenaiUI.api("/v1/ext/bao-cao").then(function (j) { PenaiUI.card(m, "Kết quả").textContent = JSON.stringify(j); });
  }, { group: "Nội bộ", admin: false });`,
  async start(deps) { /* lịch nền, kết nối ngoài… */ },
};
export default ext;
```

## Dựng fork và cài lên máy chủ

```bash
# 1. Trên máy lập trình: tạo repo riêng tư rồi đẩy mã chính thức lên
git clone https://github.com/dennyducnguyen/penai.git penai-congty && cd penai-congty
git remote rename origin upstream
git remote add origin git@github.com:<công-ty>/penai-congty.git
git push -u origin main --tags

# 2. Thêm tính năng riêng (extensions/, migration 9001_…, internal/), gắn tag
git tag -a v1.18.0-congty.1 -m "Bản nội bộ dựa trên v1.18.0" && git push origin v1.18.0-congty.1
```

Trên máy chủ, tạo khóa SSH chỉ đọc rồi gắn vào repo fork làm **deploy key** (GitHub → Settings → Deploy keys, không tick quyền ghi):

```bash
sudo ssh-keygen -t ed25519 -N "" -f /etc/penai/repo_key -C "penai-deploy"
sudo cat /etc/penai/repo_key.pub          # dán vào Deploy keys của repo fork
```

Cài mới từ fork:

```bash
curl -fsSL https://raw.githubusercontent.com/dennyducnguyen/penai/main/deploy/install.sh | sudo bash -s -- \
  --repo git@github.com:<công-ty>/penai-congty.git --repo-key /etc/penai/repo_key \
  --tags '^v[0-9]+\.[0-9]+\.[0-9]+-congty\.[0-9]+$' --domain ai.congty.vn --email admin@congty.vn --yes
```

Máy đang chạy bản chính thức thì chuyển sang fork:

```bash
sudo penai set-repo git@github.com:<công-ty>/penai-congty.git --key /etc/penai/repo_key --tags '^v[0-9]+\.[0-9]+\.[0-9]+-congty\.[0-9]+$'
sudo penai update --yes
```

`--tags` là mẫu tên tag phát hành của fork. Có mẫu này thì `penai status` / `penai update` hiểu "bản mới nhất" là tag của fork, không phải tag của bản chính thức.

## Nhận bản mới của bản chính thức

```bash
git fetch upstream --tags
git merge v1.19.0            # vùng riêng không đụng file lõi → thường không xung đột
pnpm install && pnpm typecheck && pnpm test
git push origin main
git tag -a v1.19.0-congty.1 -m "Bản nội bộ dựa trên v1.19.0" && git push origin v1.19.0-congty.1
# trên máy chủ
sudo penai update --yes
```
