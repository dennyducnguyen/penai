import pg from "pg";
import { generateApiKey, sha256hex } from "@penai/shared";

export interface SeedResult {
  created: boolean;
  keys: Array<{ workspace: string; role: string; apiKey: string }>;
}

/**
 * Tạo dữ liệu mẫu: 1 công ty với 2 bộ phận (kế toán, kinh doanh),
 * users, memberships, agents và API keys.
 * Chạy bằng role admin (postgres — superuser bỏ qua RLS). Idempotent.
 */
export async function seed(adminDatabaseUrl: string): Promise<SeedResult> {
  const c = new pg.Client({ connectionString: adminDatabaseUrl });
  await c.connect();
  try {
    const existing = await c.query("SELECT id FROM workspaces LIMIT 1");
    if (existing.rows.length > 0) return { created: false, keys: [] };

    const owner = (
      await c.query(
        `INSERT INTO users (email, name, company_role)
         VALUES ('giamdoc@congty.local', 'Giám đốc', 'owner') RETURNING id`,
      )
    ).rows[0].id as string;
    const acc = (
      await c.query(
        `INSERT INTO users (email, name, company_role)
         VALUES ('ketoan@congty.local', 'Nhân viên kế toán', 'member') RETURNING id`,
      )
    ).rows[0].id as string;
    const sales = (
      await c.query(
        `INSERT INTO users (email, name, company_role)
         VALUES ('kinhdoanh@congty.local', 'Nhân viên kinh doanh', 'member') RETURNING id`,
      )
    ).rows[0].id as string;

    const keys: SeedResult["keys"] = [];
    const wsDefs = [
      { slug: "ke-toan", name: "Kế toán", member: acc },
      { slug: "kinh-doanh", name: "Kinh doanh", member: sales },
    ];

    for (const ws of wsDefs) {
      const wsId = (
        await c.query(
          `INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id`,
          [ws.slug, ws.name],
        )
      ).rows[0].id as string;

      await c.query(
        `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES
         ($1, $3, 'ws_admin'), ($2, $3, 'operator')`,
        [owner, ws.member, wsId],
      );

      await c.query(
        `INSERT INTO agents (workspace_id, key, name, system_prompt, provider, model)
         VALUES ($1, 'tro-ly', $2, $3, 'default', 'mock-model')`,
        [
          wsId,
          `Trợ lý ${ws.name}`,
          `Bạn là trợ lý AI của bộ phận ${ws.name}. Trả lời ngắn gọn, tiếng Việt.`,
        ],
      );

      for (const [userId, role] of [
        [owner, "ws_admin"],
        [ws.member, "operator"],
        [ws.member, "viewer"],
      ] as const) {
        const raw = generateApiKey();
        await c.query(
          `INSERT INTO api_keys (key_hash, key_prefix, user_id, workspace_id, role, name)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sha256hex(raw), raw.slice(0, 12), userId, wsId, role, `${ws.slug}-${role}`],
        );
        keys.push({ workspace: ws.slug, role, apiKey: raw });
      }
    }
    return { created: true, keys };
  } finally {
    await c.end();
  }
}
