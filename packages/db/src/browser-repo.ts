import { asc, eq } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { browserProfiles } from "./schema.js";

/**
 * Hồ sơ trình duyệt (0033) — cookie lưu ở dạng đã mã hóa; mã hóa/giải mã và
 * kiểm tra định dạng cookie nằm ở tầng ứng dụng (apps/server/browser-runtime.ts).
 */
export type BrowserProfileRow = typeof browserProfiles.$inferSelect;

export async function listBrowserProfiles(db: Db, ctx: WorkspaceContext): Promise<BrowserProfileRow[]> {
  return withWorkspace(db, ctx, (tx) => tx.select().from(browserProfiles).orderBy(asc(browserProfiles.name)));
}

export async function getBrowserProfile(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
): Promise<BrowserProfileRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(browserProfiles).where(eq(browserProfiles.id, id)).limit(1),
  );
  return rows[0] ?? null;
}

export async function createBrowserProfile(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    name: string;
    description?: string;
    userAgent?: string;
    locale?: string;
    timezone?: string;
    autoSave?: boolean;
  },
): Promise<BrowserProfileRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(browserProfiles)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .returning(),
  );
  return rows[0]!;
}

export async function updateBrowserProfile(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    userAgent: string;
    locale: string;
    timezone: string;
    autoSave: boolean;
  }>,
): Promise<BrowserProfileRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(browserProfiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(browserProfiles.id, id))
      .returning(),
  );
  return rows[0] ?? null;
}

/**
 * Thay toàn bộ bộ cookie (đã mã hóa). cookiesEncrypted = null → xóa hết.
 * source "admin" (quản trị viên nhập/xóa) đổi updated_at = phiên bản hồ sơ → các
 * phiên trình duyệt đang mở bằng bản cũ được mở lại; "session" (tự lưu khi đóng
 * phiên) giữ nguyên phiên bản để không làm gián đoạn người khác đang dùng chung hồ sơ.
 */
export async function setBrowserProfileCookies(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  input: { cookiesEncrypted: string | null; cookieCount: number; source: "admin" | "session" },
): Promise<BrowserProfileRow | null> {
  const now = new Date();
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .update(browserProfiles)
      .set({
        cookiesEncrypted: input.cookiesEncrypted,
        cookieCount: input.cookieCount,
        cookiesUpdatedAt: now,
        ...(input.source === "admin" ? { updatedAt: now } : {}),
      })
      .where(eq(browserProfiles.id, id))
      .returning(),
  );
  return rows[0] ?? null;
}

/** Xóa hồ sơ — agent đang gán tự về NULL (FK ON DELETE SET NULL). */
export async function deleteBrowserProfile(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(browserProfiles).where(eq(browserProfiles.id, id)).returning({ id: browserProfiles.id }),
  );
  return rows.length > 0;
}
