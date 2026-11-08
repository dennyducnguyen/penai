import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

// ===== App Meta riêng (0038): kết nối Fanpage/Instagram bằng app của chính người dùng =====

export interface MetaAppRow {
  id: string;
  workspaceId: string;
  name: string;
  appId: string;
  appSecretEncrypted: string;
  verifyToken: string;
  loginConfigId: string;
  userTokenEncrypted: string | null;
  userTokenExpiresAt: string | null;
  fbUserId: string;
  fbUserName: string;
  grantedScopes: string[];
  createdAt: string;
  updatedAt: string;
}

type Raw = Record<string, unknown>;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function map(r: Raw): MetaAppRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name ?? ""),
    appId: String(r.app_id),
    appSecretEncrypted: String(r.app_secret_encrypted),
    verifyToken: String(r.verify_token),
    loginConfigId: String(r.login_config_id ?? ""),
    userTokenEncrypted: (r.user_token_encrypted as string | null) ?? null,
    userTokenExpiresAt: iso(r.user_token_expires_at),
    fbUserId: String(r.fb_user_id ?? ""),
    fbUserName: String(r.fb_user_name ?? ""),
    grantedScopes: Array.isArray(r.granted_scopes) ? (r.granted_scopes as string[]) : [],
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

export async function listMetaApps(db: Db, ctx: WorkspaceContext): Promise<MetaAppRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM meta_apps ORDER BY created_at`);
    return (res.rows as Raw[]).map(map);
  });
}

export async function getMetaApp(db: Db, ctx: WorkspaceContext, id: string): Promise<MetaAppRow | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM meta_apps WHERE id = ${id}`);
    const r = res.rows[0] as Raw | undefined;
    return r ? map(r) : null;
  });
}

export async function createMetaApp(
  db: Db,
  ctx: WorkspaceContext,
  input: { name: string; appId: string; appSecretEncrypted: string; verifyToken: string; loginConfigId?: string },
): Promise<MetaAppRow> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO meta_apps (workspace_id, name, app_id, app_secret_encrypted, verify_token, login_config_id)
      VALUES (${ctx.workspaceId}, ${input.name}, ${input.appId}, ${input.appSecretEncrypted}, ${input.verifyToken}, ${input.loginConfigId ?? ""})
      RETURNING *`);
    return map(res.rows[0] as Raw);
  });
}

/** Mảng quyền Meta (chỉ chữ thường + gạch dưới) → ARRAY[...]::text[] (drizzle trải mảng thành nhiều tham số). */
function scopesArray(scopes: string[]) {
  const safe = scopes.map((x) => x.replace(/[^a-z_]/g, "")).filter(Boolean);
  return sql.raw(`ARRAY[${safe.map((x) => `'${x}'`).join(",")}]::text[]`);
}

export async function updateMetaApp(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: {
    name?: string;
    appSecretEncrypted?: string;
    loginConfigId?: string;
    userTokenEncrypted?: string | null;
    userTokenExpiresAt?: Date | null;
    fbUserId?: string;
    fbUserName?: string;
    grantedScopes?: string[];
  },
): Promise<MetaAppRow | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE meta_apps SET
        name = COALESCE(${patch.name ?? null}, name),
        app_secret_encrypted = COALESCE(${patch.appSecretEncrypted ?? null}, app_secret_encrypted),
        login_config_id = COALESCE(${patch.loginConfigId ?? null}, login_config_id),
        user_token_encrypted = CASE WHEN ${patch.userTokenEncrypted !== undefined} THEN ${patch.userTokenEncrypted ?? null} ELSE user_token_encrypted END,
        user_token_expires_at = CASE WHEN ${patch.userTokenExpiresAt !== undefined} THEN ${patch.userTokenExpiresAt ? patch.userTokenExpiresAt.toISOString() : null}::timestamptz ELSE user_token_expires_at END,
        fb_user_id = COALESCE(${patch.fbUserId ?? null}, fb_user_id),
        fb_user_name = COALESCE(${patch.fbUserName ?? null}, fb_user_name),
        granted_scopes = CASE WHEN ${patch.grantedScopes !== undefined} THEN ${scopesArray(patch.grantedScopes ?? [])} ELSE granted_scopes END,
        updated_at = now()
      WHERE id = ${id}
      RETURNING *`);
    const r = res.rows[0] as Raw | undefined;
    return r ? map(r) : null;
  });
}

export async function deleteMetaApp(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`DELETE FROM meta_apps WHERE id = ${id} RETURNING id`);
    return res.rows.length > 0;
  });
}

/** Webhook của Meta: tra app theo id (không có ngữ cảnh workspace) — qua hàm SECURITY DEFINER. */
export async function lookupMetaApp(
  db: Db,
  id: string,
): Promise<{ id: string; workspaceId: string; appId: string; appSecretEncrypted: string; verifyToken: string } | null> {
  const res = await db.execute(sql`SELECT * FROM lookup_meta_app(${id}::uuid)`);
  const r = res.rows[0] as Raw | undefined;
  return r
    ? { id: String(r.id), workspaceId: String(r.workspace_id), appId: String(r.app_id), appSecretEncrypted: String(r.app_secret_encrypted), verifyToken: String(r.verify_token) }
    : null;
}
