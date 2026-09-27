import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  generateSessionToken,
  hashPassword,
  sha256hex,
  type WorkspaceContext,
  type WorkspaceRole,
} from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { agentUserGrants, agents, users, webSessions, workspaceMembers, workspaces } from "./schema.js";

// ===== Tài khoản người dùng (0024) =====
// `users` là bảng company-level (không RLS); membership + grants đi qua RLS.
// Mọi hàm quản trị nhận ctx của admin đang thao tác; hàm đăng nhập nhận
// tham số thô vì chưa có context.

export type UserRow = typeof users.$inferSelect;

export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceById(
  db: Db,
  id: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const rows = await db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Tạo phiên web sau khi xác thực mật khẩu. Trả token thô (đặt vào cookie). */
export async function createWebSession(
  db: Db,
  input: { userId: string; workspaceId: string; userAgent?: string; ip?: string; ttlMs?: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? WEB_SESSION_TTL_MS));
  await db.insert(webSessions).values({
    tokenHash: sha256hex(token),
    userId: input.userId,
    workspaceId: input.workspaceId,
    expiresAt,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    ip: input.ip ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, input.userId));
  // dọn phiên hết hạn (rẻ, chạy nhân tiện)
  await db.execute(sql`DELETE FROM web_sessions WHERE expires_at < now() - interval '1 day'`);
  return { token, expiresAt };
}

export async function revokeWebSession(db: Db, rawToken: string): Promise<void> {
  await db
    .update(webSessions)
    .set({ revokedAt: new Date() })
    .where(eq(webSessions.tokenHash, sha256hex(rawToken)));
}

/** Thu hồi mọi phiên của user (đổi mật khẩu, khóa tài khoản). */
export async function revokeAllWebSessions(db: Db, userId: string): Promise<void> {
  await db
    .update(webSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(webSessions.userId, userId), sql`${webSessions.revokedAt} IS NULL`));
}

export async function touchWebSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(webSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(webSessions.id, sessionId));
}

export async function setUserPassword(
  db: Db,
  userId: string,
  password: string,
  opts: { mustChange?: boolean } = {},
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: hashPassword(password), mustChangePassword: opts.mustChange ?? false })
    .where(eq(users.id, userId));
}

// ===== Quản trị người dùng trong workspace =====

export interface WorkspaceUser {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  isActive: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** id agent được gán (chỉ có ý nghĩa với role member) */
  agentIds: string[];
}

export async function listWorkspaceUsers(db: Db, ctx: WorkspaceContext): Promise<WorkspaceUser[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: workspaceMembers.role,
        isActive: users.isActive,
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .orderBy(desc(users.createdAt));
    const grants = await tx
      .select({ userId: agentUserGrants.userId, agentId: agentUserGrants.agentId })
      .from(agentUserGrants);
    const byUser = new Map<string, string[]>();
    for (const g of grants) {
      const arr = byUser.get(g.userId) ?? [];
      arr.push(g.agentId);
      byUser.set(g.userId, arr);
    }
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role as WorkspaceRole,
      isActive: r.isActive,
      hasPassword: Boolean(r.passwordHash),
      mustChangePassword: r.mustChangePassword,
      lastLoginAt: r.lastLoginAt,
      createdAt: r.createdAt,
      agentIds: byUser.get(r.id) ?? [],
    }));
  });
}

/**
 * Tạo user + membership trong workspace hiện tại. Email đã tồn tại (thuộc
 * workspace khác) → chỉ thêm membership. Email đã là thành viên → lỗi.
 */
export async function createWorkspaceUser(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    email: string;
    name: string;
    password: string;
    role: WorkspaceRole;
    mustChangePassword?: boolean;
  },
): Promise<{ id: string; reusedExisting: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(db, email);
  let userId: string;
  let reusedExisting = false;
  if (existing) {
    userId = existing.id;
    reusedExisting = true;
    if (!existing.passwordHash) {
      await setUserPassword(db, userId, input.password, {
        ...(input.mustChangePassword !== undefined ? { mustChange: input.mustChangePassword } : {}),
      });
    }
  } else {
    const rows = await db
      .insert(users)
      .values({
        email,
        name: input.name.trim() || email,
        companyRole: "member",
        passwordHash: hashPassword(input.password),
        mustChangePassword: input.mustChangePassword ?? false,
      })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  }
  await withWorkspace(db, ctx, async (tx) => {
    const dup = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    if (dup.length) throw new Error("Email này đã là thành viên của workspace");
    await tx
      .insert(workspaceMembers)
      .values({ userId, workspaceId: ctx.workspaceId, role: input.role });
  });
  return { id: userId, reusedExisting };
}

/** Có phải thành viên workspace hiện tại không (fail-closed cho mọi thao tác admin). */
export async function isWorkspaceMember(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1),
  );
  return rows.length > 0;
}

/**
 * Vai trò HIỆN TẠI của một người trong workspace; null nếu đã bị gỡ khỏi
 * workspace hoặc tài khoản bị khóa. Dùng khi chạy việc thay mặt người đó về sau
 * (lịch hẹn) — quyền phải theo hiện tại, không theo lúc tạo.
 */
export async function getActiveMemberRole(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<WorkspaceRole | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ role: workspaceMembers.role, isActive: users.isActive })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.userId, userId))
      .limit(1),
  );
  const row = rows[0];
  return row && row.isActive !== false ? (row.role as WorkspaceRole) : null;
}

export async function updateMemberRole(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
  role: WorkspaceRole,
): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(workspaceMembers)
      .set({ role })
      .where(eq(workspaceMembers.userId, userId))
      .returning({ userId: workspaceMembers.userId }),
  );
  return rows.length > 0;
}

export async function updateUserProfile(
  db: Db,
  userId: string,
  patch: { name?: string; isActive?: boolean },
): Promise<void> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (Object.keys(set).length === 0) return;
  await db.update(users).set(set).where(eq(users.id, userId));
}

/** Gỡ user khỏi workspace (giữ bản ghi users; phiên web vào workspace này hết hiệu lực vì mất membership). */
export async function removeWorkspaceMember(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<boolean> {
  return withWorkspace(db, ctx, async (tx) => {
    await tx.delete(agentUserGrants).where(eq(agentUserGrants.userId, userId));
    const rows = await tx
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .returning({ userId: workspaceMembers.userId });
    return rows.length > 0;
  });
}

// ===== Gán agent cho member =====

export async function listGrantedAgentIds(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<string[]> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .select({ agentId: agentUserGrants.agentId })
      .from(agentUserGrants)
      .where(eq(agentUserGrants.userId, userId)),
  );
  return rows.map((r) => r.agentId);
}

/** Đặt LẠI toàn bộ danh sách agent của user (thay thế). Agent ngoài workspace bị bỏ qua. */
export async function setUserAgentGrants(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
  agentIds: string[],
): Promise<string[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const valid = agentIds.length
      ? (
          await tx
            .select({ id: agents.id })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        ).map((r) => r.id)
      : [];
    await tx.delete(agentUserGrants).where(eq(agentUserGrants.userId, userId));
    if (valid.length) {
      await tx.insert(agentUserGrants).values(
        valid.map((agentId) => ({
          workspaceId: ctx.workspaceId,
          agentId,
          userId,
          grantedBy: ctx.userId,
        })),
      );
    }
    return valid;
  });
}
