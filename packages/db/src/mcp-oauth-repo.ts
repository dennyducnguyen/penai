import { sql } from "drizzle-orm";
import { sha256hex, type WorkspaceRole } from "@penai/shared";
import type { Db } from "./client.js";

// ===== OAuth cho PenAI MCP server (0031) =====
// Bảng company-level (không RLS) như web_sessions: tra token trước khi có
// workspace context. Token/code/secret chỉ lưu sha256.

type Raw = Record<string, unknown>;

export interface McpOauthGrant {
  id: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
  passwordVersion: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapGrant(r: Raw): McpOauthGrant {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    workspaceId: String(r.workspace_id),
    scopes: (r.scopes as string[]) ?? [],
    passwordVersion: String(r.password_version),
    createdAt: iso(r.created_at) ?? "",
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  };
}

export async function countMcpOauthClients(db: Db): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM mcp_oauth_clients`);
  return Number((res.rows[0] as Raw | undefined)?.n ?? 0);
}

export async function insertMcpOauthClient(db: Db, id: string, metadata: Record<string, unknown>): Promise<void> {
  await db.execute(sql`INSERT INTO mcp_oauth_clients (id, metadata) VALUES (${id}, ${JSON.stringify(metadata)}::jsonb)`);
}

export async function getMcpOauthClient(db: Db, id: string): Promise<Record<string, unknown> | null> {
  const res = await db.execute(sql`SELECT metadata FROM mcp_oauth_clients WHERE id = ${id}`);
  return ((res.rows[0] as Raw | undefined)?.metadata as Record<string, unknown> | undefined) ?? null;
}

export async function insertMcpOauthPending(
  db: Db,
  input: { id: string; clientId: string; params: Record<string, unknown>; csrfHash: string; expiresAt: Date },
): Promise<void> {
  await db.execute(sql`DELETE FROM mcp_oauth_pending WHERE expires_at < now()`);
  await db.execute(sql`INSERT INTO mcp_oauth_pending (id, client_id, params, csrf_hash, expires_at)
    VALUES (${input.id}, ${input.clientId}, ${JSON.stringify(input.params)}::jsonb, ${input.csrfHash}, ${input.expiresAt.toISOString()})`);
}

export async function getMcpOauthPending(
  db: Db,
  id: string,
): Promise<{ id: string; clientId: string; params: Record<string, unknown>; csrfHash: string } | null> {
  const res = await db.execute(sql`SELECT * FROM mcp_oauth_pending WHERE id = ${id} AND expires_at > now()`);
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    params: r.params as Record<string, unknown>,
    csrfHash: String(r.csrf_hash),
  };
}

export async function deleteMcpOauthPending(db: Db, id: string): Promise<boolean> {
  const res = await db.execute(sql`DELETE FROM mcp_oauth_pending WHERE id = ${id} AND expires_at > now() RETURNING id`);
  return res.rows.length > 0;
}

/**
 * Tiêu thụ pending (một lần) + tạo grant + mã code trong 1 giao dịch.
 * Trả false nếu pending đã dùng/hết hạn.
 */
export async function approveMcpOauthPending(
  db: Db,
  input: {
    pendingId: string;
    clientId: string;
    userId: string;
    workspaceId: string;
    scopes: string[];
    passwordVersion: string;
    codeHash: string;
    challenge: string;
    redirectUri: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const del = await tx.execute(
      sql`DELETE FROM mcp_oauth_pending WHERE id = ${input.pendingId} AND expires_at > now() RETURNING id`,
    );
    if (!del.rows.length) return false;
    const g = await tx.execute(sql`INSERT INTO mcp_oauth_grants (client_id, user_id, workspace_id, scopes, password_version)
      VALUES (${input.clientId}, ${input.userId}, ${input.workspaceId},
        ${sql.raw(`ARRAY[${input.scopes.map((s) => `'${s.replace(/'/g, "")}'`).join(",")}]::text[]`)},
        ${input.passwordVersion}) RETURNING id`);
    const grantId = String((g.rows[0] as Raw).id);
    await tx.execute(sql`INSERT INTO mcp_oauth_codes (hash, grant_id, challenge, redirect_uri, expires_at)
      VALUES (${input.codeHash}, ${grantId}, ${input.challenge}, ${input.redirectUri}, now() + interval '5 minutes')`);
    return true;
  });
}

export async function getMcpOauthGrant(db: Db, id: string): Promise<McpOauthGrant | null> {
  const res = await db.execute(sql`SELECT * FROM mcp_oauth_grants WHERE id = ${id}`);
  const r = res.rows[0] as Raw | undefined;
  return r ? mapGrant(r) : null;
}

/** Tiêu thụ code (một lần). */
export async function consumeMcpOauthCode(
  db: Db,
  codeHash: string,
): Promise<{ grantId: string; challenge: string; redirectUri: string } | null> {
  const res = await db.execute(
    sql`DELETE FROM mcp_oauth_codes WHERE hash = ${codeHash} AND expires_at > now() RETURNING grant_id, challenge, redirect_uri`,
  );
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  return { grantId: String(r.grant_id), challenge: String(r.challenge), redirectUri: String(r.redirect_uri) };
}

export async function peekMcpOauthCode(
  db: Db,
  codeHash: string,
): Promise<{ grantId: string } | null> {
  const res = await db.execute(sql`SELECT grant_id FROM mcp_oauth_codes WHERE hash = ${codeHash} AND expires_at > now()`);
  const r = res.rows[0] as Raw | undefined;
  return r ? { grantId: String(r.grant_id) } : null;
}

export async function insertMcpOauthTokens(
  db: Db,
  input: { grantId: string; scopes: string[]; accessHash: string; accessExpires: Date; refreshHash: string; refreshExpires: Date },
): Promise<void> {
  const arr = sql.raw(`ARRAY[${input.scopes.map((s) => `'${s.replace(/'/g, "")}'`).join(",")}]::text[]`);
  await db.execute(sql`INSERT INTO mcp_oauth_tokens (hash, grant_id, kind, scopes, expires_at) VALUES
    (${input.accessHash}, ${input.grantId}, 'access', ${arr}, ${input.accessExpires.toISOString()}),
    (${input.refreshHash}, ${input.grantId}, 'refresh', ${arr}, ${input.refreshExpires.toISOString()})`);
}

export async function getMcpOauthToken(
  db: Db,
  hash: string,
): Promise<{ grantId: string; kind: "access" | "refresh"; scopes: string[]; expiresAt: Date; usedAt: Date | null } | null> {
  const res = await db.execute(sql`SELECT * FROM mcp_oauth_tokens WHERE hash = ${hash}`);
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  return {
    grantId: String(r.grant_id),
    kind: r.kind === "refresh" ? "refresh" : "access",
    scopes: (r.scopes as string[]) ?? [],
    expiresAt: new Date(String(r.expires_at)),
    usedAt: r.used_at ? new Date(String(r.used_at)) : null,
  };
}

/** Đánh dấu refresh token đã dùng. Trả false nếu đã bị dùng trước đó (cạnh tranh/phát lại). */
export async function markMcpRefreshUsed(db: Db, hash: string): Promise<boolean> {
  const res = await db.execute(
    sql`UPDATE mcp_oauth_tokens SET used_at = now() WHERE hash = ${hash} AND kind = 'refresh' AND used_at IS NULL RETURNING hash`,
  );
  return res.rows.length > 0;
}

export async function touchMcpOauthGrant(db: Db, id: string): Promise<void> {
  await db.execute(sql`UPDATE mcp_oauth_grants SET last_used_at = now() WHERE id = ${id}
    AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`);
}

export async function revokeMcpOauthGrant(db: Db, id: string, opts: { userId?: string; workspaceId?: string } = {}): Promise<boolean> {
  const byUser = opts.userId ? sql`AND user_id = ${opts.userId}` : sql``;
  const byWs = opts.workspaceId ? sql`AND workspace_id = ${opts.workspaceId}` : sql``;
  const res = await db.execute(
    sql`UPDATE mcp_oauth_grants SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL ${byUser} ${byWs} RETURNING id`,
  );
  return res.rows.length > 0;
}

export async function listMcpOauthGrants(
  db: Db,
  opts: { workspaceId: string; userId?: string },
): Promise<Array<McpOauthGrant & { clientName: string; redirectOrigins: string[]; userName: string; userEmail: string }>> {
  const byUser = opts.userId ? sql`AND g.user_id = ${opts.userId}` : sql``;
  const res = await db.execute(sql`SELECT g.*, c.metadata, u.name AS user_name, u.email AS user_email
    FROM mcp_oauth_grants g
    JOIN mcp_oauth_clients c ON c.id = g.client_id
    JOIN users u ON u.id = g.user_id
    WHERE g.workspace_id = ${opts.workspaceId} ${byUser}
    ORDER BY g.created_at DESC LIMIT 200`);
  return (res.rows as Raw[]).map((r) => {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const uris = Array.isArray(meta.redirect_uris) ? (meta.redirect_uris as string[]) : [];
    const origins = [
      ...new Set(
        uris.map((u) => {
          try {
            return new URL(u).origin;
          } catch {
            return "";
          }
        }),
      ),
    ].filter(Boolean);
    return {
      ...mapGrant(r),
      clientName: String(meta.client_name ?? "Ứng dụng AI"),
      redirectOrigins: origins,
      userName: String(r.user_name ?? ""),
      userEmail: String(r.user_email ?? ""),
    };
  });
}

/** Vai trò hiện tại + trạng thái tài khoản — quyền theo HIỆN TẠI, không theo lúc cấp. */
export async function lookupMcpGrantPrincipal(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<{ role: WorkspaceRole; isActive: boolean; passwordVersion: string } | null> {
  const users = await db.execute(sql`SELECT is_active, password_hash FROM users WHERE id = ${userId}`);
  const u = users.rows[0] as Raw | undefined;
  if (!u) return null;
  const m = await db.execute(sql`SELECT workspace_id, role FROM auth_lookup_memberships(${userId})`);
  const row = (m.rows as Raw[]).find((r) => String(r.workspace_id) === workspaceId);
  if (!row) return null;
  return {
    role: row.role as WorkspaceRole,
    isActive: u.is_active !== false,
    passwordVersion: sha256hex(String(u.password_hash ?? "")),
  };
}

export async function cleanupMcpOauth(db: Db): Promise<void> {
  await db.execute(sql`DELETE FROM mcp_oauth_pending WHERE expires_at < now()`);
  await db.execute(sql`DELETE FROM mcp_oauth_codes WHERE expires_at < now()`);
  await db.execute(sql`DELETE FROM mcp_oauth_tokens WHERE expires_at < now()`);
}
