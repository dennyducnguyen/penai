import { seed } from "./seed.js";

const url =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://postgres@127.0.0.1:5433/penai";

const result = await seed(url);
if (!result.created) {
  console.log("Dữ liệu đã tồn tại — bỏ qua seed.");
} else {
  console.log("Đã tạo dữ liệu mẫu. API keys (CHỈ HIỂN THỊ 1 LẦN — lưu lại ngay):\n");
  for (const k of result.keys) {
    console.log(`  [${k.workspace}] ${k.role.padEnd(9)} ${k.apiKey}`);
  }
}
