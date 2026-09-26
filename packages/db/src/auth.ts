import { sql } from "drizzle-orm";
import { sha256hex, type WorkspaceRole } from "@penai/shared";
import type { Db } from "./client.js";

export interface ApiKeyAuth {
  /** id của api_keys — khóa cho policy/usage/idempotency (0025). */
  id: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Xác thực API key thô → workspace context, hoặc null nếu không hợp lệ.
 * Đi qua hàm SECURITY DEFINER `auth_lookup_api_key` — lối duy nhất đọc
 * api_keys khi CHƯA có workspace context (mọi truy cập khác bị RLS chặn).
 */
export async function authenticateApiKey(
  db: Db,
  rawKey: string,
): Promise<ApiKeyAuth | null> {
  if (!rawKey.startsWith("psk_")) return null;
  const hash = sha256hex(rawKey);
  const res = await db.execute(
    sql`SELECT id, user_id, workspace_id, role, expires_at, revoked_at FROM auth_lookup_api_key_v2(${hash})`,
  );
  const row = res.rows[0] as
    | {
        id: string;
        user_id: string;
        workspace_id: string;
        role: WorkspaceRole;
        expires_at: string | Date | null;
        revoked_at: string | Date | null;
      }
    | undefined;
  if (!row) return null;
  const auth: ApiKeyAuth = {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
  if (auth.revokedAt) return null;
  if (auth.expiresAt && auth.expiresAt.getTime() < Date.now()) return null;
  return auth;
}

// ===== Phiên web (0024): cookie → WorkspaceContext =====

export interface WebSessionAuth {
  sessionId: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  mustChangePassword: boolean;
}

/**
 * Xác thực token phiên web (từ cookie) → context, hoặc null.
 * Qua SECURITY DEFINER `auth_lookup_web_session` — role đọc sống từ
 * workspace_members nên đổi quyền / xóa membership có hiệu lực ngay.
 */
export async function authenticateWebSession(
  db: Db,
  rawToken: string,
): Promise<WebSessionAuth | null> {
  if (!rawToken.startsWith("pss_")) return null;
  const hash = sha256hex(rawToken);
  const res = await db.execute(
    sql`SELECT session_id, user_id, workspace_id, role, expires_at, revoked_at, user_active, must_change_password
        FROM auth_lookup_web_session(${hash})`,
  );
  const row = res.rows[0] as
    | {
        session_id: string;
        user_id: string;
        workspace_id: string;
        role: string | null;
        expires_at: string | Date;
        revoked_at: string | Date | null;
        user_active: boolean;
        must_change_password: boolean;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.user_active) return null;
  if (!row.role) return null; // membership đã bị xóa
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role as WorkspaceRole,
    mustChangePassword: row.must_change_password,
  };
}

export interface MembershipRow {
  workspaceId: string;
  role: WorkspaceRole;
  slug: string;
  name: string;
}

/** Workspace của user (dùng lúc đăng nhập, chưa có context). */
export async function lookupMemberships(db: Db, userId: string): Promise<MembershipRow[]> {
  const res = await db.execute(
    sql`SELECT workspace_id, role, slug, name FROM auth_lookup_memberships(${userId})`,
  );
  return (res.rows as Array<{ workspace_id: string; role: string; slug: string; name: string }>).map(
    (r) => ({ workspaceId: r.workspace_id, role: r.role as WorkspaceRole, slug: r.slug, name: r.name }),
  );
}
