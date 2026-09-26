import pg from "pg";
import { generateApiKey, sha256hex } from "@penai/shared";
import { runMigrations } from "./migrate.js";

const PG_HOST = process.env.PENAI_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = process.env.PENAI_TEST_PG_PORT ?? "5433";

// Override URL đầy đủ qua env — để chạy test trên Postgres có pgvector (VPS)
// khi portable PG local thiếu extension (migration 0022 yêu cầu vector).
export const TEST_ADMIN_MAINT_URL =
  process.env.PENAI_TEST_ADMIN_MAINT_URL ?? `postgres://postgres@${PG_HOST}:${PG_PORT}/postgres`;
export const TEST_ADMIN_URL =
  process.env.PENAI_TEST_ADMIN_URL ?? `postgres://postgres@${PG_HOST}:${PG_PORT}/penai_test`;
export const TEST_APP_URL =
  process.env.PENAI_TEST_APP_URL ?? `postgres://penai_app:penai_app@${PG_HOST}:${PG_PORT}/penai_test`;

/** Drop + create + migrate database penai_test. Gọi trong beforeAll. */
export async function setupTestDatabase(): Promise<void> {
  const maint = new pg.Client({ connectionString: TEST_ADMIN_MAINT_URL });
  await maint.connect();
  try {
    await maint.query("DROP DATABASE IF EXISTS penai_test WITH (FORCE)");
    await maint.query("CREATE DATABASE penai_test");
  } finally {
    await maint.end();
  }
  await runMigrations(TEST_ADMIN_URL);
}

export interface TestFixtures {
  wsA: string;
  wsB: string;
  userId: string;
  agentA: string;
  agentB: string;
  /** API key thô theo (workspace, role) */
  keys: {
    aAdmin: string;
    aOperator: string;
    aViewer: string;
    bOperator: string;
  };
}

/** Tạo 2 workspace A/B + agents + API keys bằng quyền admin (bypass RLS). */
export async function createTestFixtures(): Promise<TestFixtures> {
  const c = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c.connect();
  try {
    const userId = (
      await c.query(
        `INSERT INTO users (email, name, company_role)
         VALUES ('test@test.local', 'Test User', 'owner') RETURNING id`,
      )
    ).rows[0].id as string;

    const mkWs = async (slug: string) =>
      (
        await c.query(
          `INSERT INTO workspaces (slug, name) VALUES ($1, $1) RETURNING id`,
          [slug],
        )
      ).rows[0].id as string;
    const wsA = await mkWs("ws-a");
    const wsB = await mkWs("ws-b");

    const mkAgent = async (wsId: string) =>
      (
        await c.query(
          `INSERT INTO agents (workspace_id, key, name, system_prompt, provider, model)
           VALUES ($1, 'tro-ly', 'Trợ lý test', 'Bạn là trợ lý test.', 'default', 'mock-model')
           RETURNING id`,
          [wsId],
        )
      ).rows[0].id as string;
    const agentA = await mkAgent(wsA);
    const agentB = await mkAgent(wsB);

    const mkKey = async (wsId: string, role: string) => {
      const raw = generateApiKey();
      await c.query(
        `INSERT INTO api_keys (key_hash, key_prefix, user_id, workspace_id, role, name)
         VALUES ($1, $2, $3, $4, $5, 'test-key')`,
        [sha256hex(raw), raw.slice(0, 12), userId, wsId, role],
      );
      return raw;
    };

    return {
      wsA,
      wsB,
      userId,
      agentA,
      agentB,
      keys: {
        aAdmin: await mkKey(wsA, "ws_admin"),
        aOperator: await mkKey(wsA, "operator"),
        aViewer: await mkKey(wsA, "viewer"),
        bOperator: await mkKey(wsB, "operator"),
      },
    };
  } finally {
    await c.end();
  }
}

/** Query tự do bằng quyền admin — dùng để xác minh dữ liệu trong test. */
export async function adminQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
