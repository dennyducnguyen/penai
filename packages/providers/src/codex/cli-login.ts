import { DEFAULT_AUTH_FILE } from "./oauth.js";
import { startLoginFlow } from "./login-flow.js";

const authFile = process.env.CODEX_AUTH_FILE ?? DEFAULT_AUTH_FILE;

const flow = startLoginFlow({ authFile });
console.log("Đăng nhập ChatGPT (gói Plus/Pro) — mở URL sau nếu trình duyệt không tự bật:\n");
console.log(flow.url + "\n");
console.log("Đang chờ đăng nhập (tối đa 10 phút)...");

try {
  const auth = await flow.done;
  console.log(`\n✅ Đăng nhập thành công: ${auth.email ?? auth.accountId}`);
  console.log(`Token đã lưu tại ${authFile}`);
  process.exit(0);
} catch (e) {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
}
