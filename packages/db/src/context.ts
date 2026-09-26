import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";

/**
 * Transaction có workspace context (lớp cách ly số 2 + 3).
 * `set_config(..., true)` = SET LOCAL: chỉ hiệu lực trong transaction này.
 * RLS policy so `workspace_id = current_setting('app.workspace_id')` —
 * connection không SET → policy không match → 0 dòng (fail-closed).
 */
export async function withWorkspace<T>(
  db: Db,
  ctx: WorkspaceContext,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    await rawTx.execute(
      sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`,
    );
    return fn(rawTx as unknown as Db);
  });
}
