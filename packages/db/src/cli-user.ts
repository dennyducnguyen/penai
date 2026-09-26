/**
 * Tạo / cập nhật tài khoản đăng nhập Dashboard bằng quyền admin DB
 * (bootstrap admin đầu tiên — sau đó dùng Dashboard → Người dùng).
 *
 *   PENAI_USER_PASSWORD='...' pnpm user:create -- --email a@b.vn --name "Tên" --workspace cong-ty --role ws_admin
 *
 * Mật khẩu đọc từ env PENAI_USER_PASSWORD (tránh lộ trong lịch sử shell);
 * --password cũng được nhận nếu thật sự cần. User đã tồn tại → cập nhật mật khẩu
 * + tên; membership đã có → cập nhật role. Kết nối bằng DATABASE_URL_ADMIN.
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
const name = opt("name")?.trim();
const workspace = opt("workspace")?.trim();
const role = opt("role")?.trim() ?? "ws_admin";
const password = process.env.PENAI_USER_PASSWORD ?? opt("password");
const mustChange = args.includes("--must-change");

if (!email || !workspace || !password) {
  console.error(
    "Cách dùng: PENAI_USER_PASSWORD='...' pnpm user:create -- --email <email> --workspace <slug> [--name <tên>] [--role ws_admin|operator|viewer|member] [--must-change]",
  );
  process.exit(2);
}
if (!["ws_admin", "operator", "viewer", "member"].includes(role)) {
  console.error(`Role không hợp lệ: ${role}`);
  process.exit(2);
}
if (password.length < 8) {
  console.error("Mật khẩu tối thiểu 8 ký tự");
  process.exit(2);
}

const url = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres@127.0.0.1:5433/penai";
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const ws = (await c.query("SELECT id, name FROM workspaces WHERE slug = $1", [workspace])).rows[0] as
    | { id: string; name: string }
    | undefined;
  if (!ws) {
    console.error(`Không thấy workspace slug "${workspace}"`);
    process.exit(1);
  }
  const hash = hashPassword(password);
  const existing = (await c.query("SELECT id FROM users WHERE email = $1", [email])).rows[0] as
    | { id: string }
    | undefined;
  let userId: string;
  if (existing) {
    userId = existing.id;
    await c.query(
      `UPDATE users SET password_hash = $2, must_change_password = $3, is_active = true
         ${name ? ", name = $4" : ""}
       WHERE id = $1`,
      name ? [userId, hash, mustChange, name] : [userId, hash, mustChange],
    );
    console.log(`Đã cập nhật mật khẩu cho ${email}`);
  } else {
    userId = (
      await c.query(
        `INSERT INTO users (email, name, company_role, password_hash, must_change_password)
         VALUES ($1, $2, 'member', $3, $4) RETURNING id`,
        [email, name ?? email, hash, mustChange],
      )
    ).rows[0].id as string;
    console.log(`Đã tạo user ${email}`);
  }
  await c.query(
    `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, ws.id, role],
  );
  // đổi mật khẩu bằng CLI → thu hồi phiên web cũ
  await c.query("UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  console.log(`Membership: ${email} → workspace "${ws.name}" (${workspace}) role ${role}`);
} finally {
  await c.end();
}
