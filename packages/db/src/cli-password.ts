/**
 * Đặt lại mật khẩu đăng nhập Dashboard cho một tài khoản ĐÃ CÓ (không đổi quyền,
 * không đụng workspace) và thu hồi mọi phiên đăng nhập cũ. Lệnh `penai
 * reset-password <email>` trên máy chủ gọi file này.
 *
 *   PENAI_USER_PASSWORD='...' tsx packages/db/src/cli-password.ts --email a@b.vn
 *
 * Kết nối bằng DATABASE_URL_ADMIN (role sở hữu database, bỏ qua RLS).
 */
import pg from "pg";
import { hashPassword } from "@penai/shared";

const args = process.argv.slice(2);
const i = args.indexOf("--email");
const email = (i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--email="))?.slice(8))?.trim().toLowerCase();
const password = process.env.PENAI_USER_PASSWORD;

if (!email || !password) {
  console.error("Cách dùng: PENAI_USER_PASSWORD='...' tsx packages/db/src/cli-password.ts --email <email>");
  process.exit(2);
}
if (password.length < 8) {
  console.error("Mật khẩu tối thiểu 8 ký tự");
  process.exit(2);
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN ?? "postgres://postgres@127.0.0.1:5433/penai" });
await c.connect();
try {
  const row = (await c.query("SELECT id FROM users WHERE email = $1", [email])).rows[0] as { id: string } | undefined;
  if (!row) {
    const known = (await c.query("SELECT email FROM users WHERE password_hash IS NOT NULL ORDER BY created_at LIMIT 10"))
      .rows as Array<{ email: string }>;
    console.error(`Không có tài khoản ${email}.` + (known.length ? ` Tài khoản đang có: ${known.map((r) => r.email).join(", ")}` : ""));
    process.exitCode = 1;
  } else {
    await c.query(
      "UPDATE users SET password_hash = $2, must_change_password = false, is_active = true WHERE id = $1",
      [row.id, hashPassword(password)],
    );
    await c.query("UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [row.id]);
    console.log(`Đã đặt lại mật khẩu cho ${email} và đăng xuất mọi phiên cũ.`);
  }
} finally {
  await c.end();
}
