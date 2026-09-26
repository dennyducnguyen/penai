import { runMigrations } from "./migrate.js";

const url =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://postgres@127.0.0.1:5433/penai";

const applied = await runMigrations(url);
console.log(
  applied.length > 0
    ? `Đã chạy ${applied.length} migration: ${applied.join(", ")}`
    : "Schema đã mới nhất, không có migration nào cần chạy.",
);
