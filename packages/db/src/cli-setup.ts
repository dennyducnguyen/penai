/**
 * Khởi tạo lần đầu sau khi cài (deploy/install.sh gọi): workspace mặc định,
 * tài khoản quản trị Dashboard và một agent mẫu. Chạy lại an toàn:
 * workspace/agent đã có thì giữ nguyên, tài khoản đã có thì chỉ đặt lại mật khẩu.
 *
 *   PENAI_USER_PASSWORD='...' pnpm setup:admin -- --email admin@congty.vn \
 *     [--name "Quản trị"] [--workspace cong-ty] [--workspace-name "Công ty"]
 *
 * Mật khẩu đọc từ env PENAI_USER_PASSWORD (không để lộ trong lịch sử shell).
 * Kết nối bằng DATABASE_URL_ADMIN (role sở hữu database, bỏ qua RLS).
 */
import pg from "pg";
import { hashPassword } from "@penai/shared";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const kv = args.find((a) => a.startsWith(`--${name}=`));
  return kv ? kv.slice(name.length + 3) : undefined;
}

const email = opt("email")?.trim().toLowerCase();
const name = opt("name")?.trim() || "Quản trị viên";
const wsSlug = opt("workspace")?.trim() || "cong-ty";
const wsName = opt("workspace-name")?.trim() || "Công ty";
const password = process.env.PENAI_USER_PASSWORD ?? opt("password");

if (!email || !password) {
  console.error(
    "Cách dùng: PENAI_USER_PASSWORD='...' pnpm setup:admin -- --email <email> [--name <tên>] [--workspace <slug>] [--workspace-name <tên>]",
  );
  process.exit(2);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(`Email không hợp lệ: ${email}`);
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(wsSlug)) {
  console.error(`Slug workspace chỉ gồm chữ thường không dấu, số và gạch ngang: ${wsSlug}`);
  process.exit(2);
}
if (password.length < 8) {
  console.error("Mật khẩu tối thiểu 8 ký tự");
  process.exit(2);
}

/** Agent mẫu: dùng ChatGPT (codex) vì không tốn RAM như provider chạy CLI. */
const SAMPLE_AGENT = {
  key: "tro-ly",
  name: "Trợ lý",
  provider: "codex",
  model: "gpt-5.5",
  prompt:
    "Bạn là trợ lý AI của công ty. Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng và lịch sự. " +
    "Không chắc thì hỏi lại, không bịa thông tin.",
};

const url = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres@127.0.0.1:5433/penai";
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query("BEGIN");
  let ws = (await c.query("SELECT id, name FROM workspaces WHERE slug = $1", [wsSlug])).rows[0] as
    | { id: string; name: string }
    | undefined;
  if (!ws) {
    ws = (
      await c.query("INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id, name", [wsSlug, wsName])
    ).rows[0] as { id: string; name: string };
    console.log(`Đã tạo workspace "${ws.name}" (${wsSlug})`);
  } else {
    console.log(`Workspace "${ws.name}" (${wsSlug}) đã có — giữ nguyên`);
  }

  const hash = hashPassword(password);
  const existing = (await c.query("SELECT id FROM users WHERE email = $1", [email])).rows[0] as
    | { id: string }
    | undefined;
  let userId: string;
  if (existing) {
    userId = existing.id;
    await c.query(
      "UPDATE users SET password_hash = $2, must_change_password = false, is_active = true WHERE id = $1",
      [userId, hash],
    );
    // đặt lại mật khẩu → thu hồi phiên web cũ
    await c.query("UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    console.log(`Tài khoản ${email} đã có — đã đặt lại mật khẩu`);
  } else {
    userId = (
      await c.query(
        `INSERT INTO users (email, name, company_role, password_hash, must_change_password)
         VALUES ($1, $2, 'owner', $3, false) RETURNING id`,
        [email, name, hash],
      )
    ).rows[0].id as string;
    console.log(`Đã tạo tài khoản quản trị ${email}`);
  }
  await c.query(
    `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'ws_admin')
     ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = 'ws_admin'`,
    [userId, ws.id],
  );

  const hasAgent = (await c.query("SELECT 1 FROM agents WHERE workspace_id = $1 LIMIT 1", [ws.id])).rows.length > 0;
  if (!hasAgent) {
    await c.query(
      `INSERT INTO agents (workspace_id, key, name, system_prompt, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ws.id, SAMPLE_AGENT.key, SAMPLE_AGENT.name, SAMPLE_AGENT.prompt, SAMPLE_AGENT.provider, SAMPLE_AGENT.model],
    );
    console.log(`Đã tạo agent mẫu "${SAMPLE_AGENT.name}" (${SAMPLE_AGENT.provider}/${SAMPLE_AGENT.model})`);
  }
  await c.query("COMMIT");
} catch (err) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`Khởi tạo thất bại: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
