import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/**
 * Chạy migrations còn thiếu, theo thứ tự tên file, mỗi file 1 transaction.
 * Kết nối bằng role admin (postgres) — RLS/GRANT cần quyền owner.
 */
export async function runMigrations(adminDatabaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query("SELECT name FROM schema_migrations")).rows.map(
        (r: { name: string }) => r.name,
      ),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} thất bại: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
