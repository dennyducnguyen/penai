/**
 * Đăng nhập Dashboard bằng tài khoản (0024).
 *
 * Hai loại danh tính vào cùng một `authCtx`:
 *   - API key `psk_…` qua header Authorization: Bearer — máy gọi máy (giữ nguyên).
 *   - Phiên web `pss_…` trong cookie httpOnly — người dùng đăng nhập email + mật khẩu.
 *
 * Role `member`: chỉ chat với agent được gán; mọi route khác bị chặn ở đây
 * (allowlist fail-closed) — không phụ thuộc vào việc UI có ẩn menu hay không.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ROLE_LABELS,
  WORKSPACE_ROLES,
  hasRole,
  verifyPassword,
  type WorkspaceContext,
  type WorkspaceRole,
} from "@penai/shared";
import {
  authenticateApiKey,
  authenticateWebSession,
  createWebSession,
  createWorkspaceUser,
  findUserByEmail,
  findUserById,
  isWorkspaceMember,
  listAgents,
  listWorkspaceUsers,
  lookupMemberships,
  recordAudit,
  removeWorkspaceMember,
  revokeAllWebSessions,
  revokeWebSession,
  setUserAgentGrants,
  setUserPassword,
  touchWebSession,
  updateMemberRole,
  updateUserProfile,
  getWorkspaceById,
  type Db,
} from "@penai/db";

export const SESSION_COOKIE = "penai_session";
const MIN_PASSWORD = 8;

export type AuthKind = "apikey" | "web";

export interface ResolvedAuth {
  ctx: WorkspaceContext;
  kind: AuthKind;
  /** id của api_keys — chỉ với kind=apikey (dùng cho policy/usage API 0025). */
  apiKeyId?: string;
  /** chỉ với kind=web */
  webSessionId?: string;
  webToken?: string;
  mustChangePassword?: boolean;
}

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth }
  | { ok: false; status: number; error: string };

// ===== Cookie =====

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecure(req: FastifyRequest): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  if (proto === "https") return true;
  return (process.env.PENAI_PUBLIC_URL ?? "").startsWith("https://");
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expiresAt: Date): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isSecure(req)) parts.push("Secure");
  reply.header("set-cookie", parts.join("; "));
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) parts.push("Secure");
  reply.header("set-cookie", parts.join("; "));
}

export function clientIp(req: FastifyRequest): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xff || req.ip || "";
}

// ===== Xác thực request =====

export async function resolveRequestAuth(db: Db, req: FastifyRequest): Promise<AuthResolution> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && header.length > "Bearer ".length) {
    const auth = await authenticateApiKey(db, header.slice("Bearer ".length));
    if (!auth) return { ok: false, status: 401, error: "API key không hợp lệ" };
    return {
      ok: true,
      auth: {
        kind: "apikey",
        apiKeyId: auth.id,
        ctx: { workspaceId: auth.workspaceId, userId: auth.userId, role: auth.role },
      },
    };
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const auth = await authenticateWebSession(db, token);
    if (!auth) return { ok: false, status: 401, error: "Phiên đăng nhập hết hạn — hãy đăng nhập lại" };
    return {
      ok: true,
      auth: {
        kind: "web",
        ctx: { workspaceId: auth.workspaceId, userId: auth.userId, role: auth.role },
        webSessionId: auth.sessionId,
        webToken: token,
        mustChangePassword: auth.mustChangePassword,
      },
    };
  }
  return { ok: false, status: 401, error: "Thiếu Authorization Bearer" };
}

/**
 * Chống CSRF cho request dùng cookie: cookie SameSite=Lax đã chặn POST
 * cross-site từ trình duyệt hiện đại; thêm lớp kiểm tra Sec-Fetch-Site/Origin.
 */
export function isCrossSiteMutation(req: FastifyRequest): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const sfs = String(req.headers["sec-fetch-site"] ?? "");
  if (sfs === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    const reqHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
    return Boolean(reqHost) && host !== reqHost;
  } catch {
    return true;
  }
}

// ===== Allowlist cho role member (fail-closed) =====

const MEMBER_ALLOW: Array<{ methods: string[]; path: RegExp }> = [
  { methods: ["GET", "POST"], path: /^\/auth\/(me|logout|change-password)$/ },
  { methods: ["GET"], path: /^\/v1\/agents$/ },
  { methods: ["GET", "POST"], path: /^\/v1\/sessions$/ },
  { methods: ["GET"], path: /^\/v1\/sessions\/[^/]+\/messages$/ },
  { methods: ["DELETE"], path: /^\/v1\/sessions\/[^/]+$/ },
  { methods: ["POST"], path: /^\/v1\/chat$/ },
  { methods: ["GET"], path: /^\/v1\/chat\/files$/ },
];

export function memberAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return MEMBER_ALLOW.some((r) => r.methods.includes(m) && r.path.test(path));
}

/** Khi bắt đổi mật khẩu, chỉ cho vài route. */
export function allowedWhileMustChange(path: string): boolean {
  return path === "/auth/me" || path === "/auth/logout" || path === "/auth/change-password";
}

// ===== Giới hạn tốc độ đăng nhập (in-memory) =====

const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { fails: number; first: number; lockedUntil: number }>();

function loginKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

function checkLocked(key: string): number {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.lockedUntil > Date.now()) return a.lockedUntil;
  if (Date.now() - a.first > LOGIN_WINDOW_MS) attempts.delete(key);
  return 0;
}

function noteFail(key: string): void {
  const now = Date.now();
  const a = attempts.get(key) ?? { fails: 0, first: now, lockedUntil: 0 };
  if (now - a.first > LOGIN_WINDOW_MS) {
    a.fails = 0;
    a.first = now;
  }
  a.fails += 1;
  if (a.fails >= LOGIN_MAX_FAILS) a.lockedUntil = now + LOGIN_WINDOW_MS;
  attempts.set(key, a);
}

function noteSuccess(key: string): void {
  attempts.delete(key);
}

// ===== Routes =====

export interface AuthRouteDeps {
  db: Db;
  /** đọc auth đã resolve trong hook */
  getAuth: (req: FastifyRequest) => ResolvedAuth | undefined;
}

function requireRole(req: FastifyRequest, reply: FastifyReply, min: WorkspaceRole): boolean {
  if (!hasRole(req.authCtx.role, min)) {
    void reply.code(403).send({ error: `Cần quyền ${min} trở lên` });
    return false;
  }
  return true;
}

function isRole(v: unknown): v is WorkspaceRole {
  return typeof v === "string" && (WORKSPACE_ROLES as readonly string[]).includes(v);
}

function validEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.length <= 200;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, getAuth } = deps;

  // ----- Đăng nhập (public) -----
  app.post("/auth/login", async (req, reply) => {
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!email || !password) return reply.code(400).send({ error: "Nhập email và mật khẩu" });

    const key = loginKey(clientIp(req), email);
    const lockedUntil = checkLocked(key);
    if (lockedUntil) {
      const mins = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
      return reply.code(429).send({ error: `Sai quá nhiều lần — thử lại sau ${mins} phút` });
    }

    const user = await findUserByEmail(db, email);
    // verify luôn chạy (kể cả user không tồn tại) để thời gian phản hồi đồng đều
    const ok = verifyPassword(password, user?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA==");
    if (!user || !ok) {
      noteFail(key);
      return reply.code(401).send({ error: "Email hoặc mật khẩu không đúng" });
    }
    if (!user.isActive) return reply.code(403).send({ error: "Tài khoản đã bị khóa" });

    const memberships = await lookupMemberships(db, user.id);
    const ws = memberships[0];
    if (!ws) return reply.code(403).send({ error: "Tài khoản chưa thuộc workspace nào" });

    noteSuccess(key);
    const s = await createWebSession(db, {
      userId: user.id,
      workspaceId: ws.workspaceId,
      ip: clientIp(req),
      ...(req.headers["user-agent"] ? { userAgent: String(req.headers["user-agent"]) } : {}),
    });
    setSessionCookie(req, reply, s.token, s.expiresAt);
    await recordAudit(
      db,
      { workspaceId: ws.workspaceId, userId: user.id, role: ws.role },
      "auth.login",
      { email, ip: clientIp(req) },
    );
    return {
      user: { id: user.id, email: user.email, name: user.name },
      workspace: { id: ws.workspaceId, slug: ws.slug, name: ws.name },
      role: ws.role,
      roleLabel: ROLE_LABELS[ws.role],
      mustChangePassword: user.mustChangePassword,
    };
  });

  // ----- Đăng xuất (public: tự đọc cookie) -----
  app.post("/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await revokeWebSession(db, token);
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  // ----- Tôi là ai -----
  app.get("/auth/me", async (req) => {
    const auth = getAuth(req);
    const ctx = req.authCtx;
    const user = await findUserById(db, ctx.userId);
    const ws = await getWorkspaceById(db, ctx.workspaceId);
    if (auth?.webSessionId) touchWebSession(db, auth.webSessionId).catch(() => {});
    return {
      user: user ? { id: user.id, email: user.email, name: user.name } : { id: ctx.userId },
      workspace: ws ?? { id: ctx.workspaceId },
      role: ctx.role,
      roleLabel: ROLE_LABELS[ctx.role],
      authKind: auth?.kind ?? "apikey",
      mustChangePassword: auth?.mustChangePassword ?? false,
    };
  });

  // ----- Đổi mật khẩu của chính mình (chỉ phiên web) -----
  app.post("/auth/change-password", async (req, reply) => {
    const auth = getAuth(req);
    if (!auth || auth.kind !== "web") {
      return reply.code(400).send({ error: "Chỉ đổi mật khẩu khi đăng nhập bằng tài khoản" });
    }
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const cur = typeof b.currentPassword === "string" ? b.currentPassword : "";
    const next = typeof b.newPassword === "string" ? b.newPassword : "";
    if (next.length < MIN_PASSWORD) {
      return reply.code(400).send({ error: `Mật khẩu mới tối thiểu ${MIN_PASSWORD} ký tự` });
    }
    const user = await findUserById(db, req.authCtx.userId);
    if (!user || !verifyPassword(cur, user.passwordHash)) {
      return reply.code(401).send({ error: "Mật khẩu hiện tại không đúng" });
    }
    await setUserPassword(db, user.id, next, { mustChange: false });
    // Thu hồi mọi phiên cũ (kể cả phiên này) rồi cấp phiên mới cho trình duyệt hiện tại
    await revokeAllWebSessions(db, user.id);
    const s = await createWebSession(db, {
      userId: user.id,
      workspaceId: req.authCtx.workspaceId,
      ip: clientIp(req),
      ...(req.headers["user-agent"] ? { userAgent: String(req.headers["user-agent"]) } : {}),
    });
    setSessionCookie(req, reply, s.token, s.expiresAt);
    await recordAudit(db, req.authCtx, "auth.password_changed", {});
    return { ok: true };
  });

  // ===== Quản trị người dùng (ws_admin) =====

  app.get("/v1/users", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const [users, agents] = await Promise.all([
      listWorkspaceUsers(db, req.authCtx),
      listAgents(db, req.authCtx),
    ]);
    return {
      users,
      agents: agents.map((a) => ({ id: a.id, key: a.key, name: a.name })),
      roles: WORKSPACE_ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })),
    };
  });

  app.post("/v1/users", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = (req.body ?? {}) as {
      email?: unknown;
      name?: unknown;
      password?: unknown;
      role?: unknown;
      agentIds?: unknown;
      mustChangePassword?: unknown;
    };
    if (!validEmail(b.email)) return reply.code(400).send({ error: "Email không hợp lệ" });
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < MIN_PASSWORD) {
      return reply.code(400).send({ error: `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự` });
    }
    const role: WorkspaceRole = isRole(b.role) ? b.role : "member";
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : b.email.trim();
    let created: { id: string; reusedExisting: boolean };
    try {
      created = await createWorkspaceUser(db, req.authCtx, {
        email: b.email,
        name,
        password,
        role,
        mustChangePassword: b.mustChangePassword === true,
      });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    const agentIds = Array.isArray(b.agentIds) ? b.agentIds.filter((x): x is string => typeof x === "string") : [];
    if (role === "member" && agentIds.length) {
      await setUserAgentGrants(db, req.authCtx, created.id, agentIds);
    }
    await recordAudit(db, req.authCtx, "user.create", { userId: created.id, email: b.email, role });
    return reply.code(201).send({ id: created.id, reusedExisting: created.reusedExisting });
  });

  app.patch("/v1/users/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    if (!(await isWorkspaceMember(db, req.authCtx, id))) {
      return reply.code(404).send({ error: "Người dùng không thuộc workspace" });
    }
    const b = (req.body ?? {}) as { name?: unknown; role?: unknown; isActive?: unknown; agentIds?: unknown };
    const self = id === req.authCtx.userId;
    if (b.role !== undefined) {
      if (!isRole(b.role)) return reply.code(400).send({ error: "Role không hợp lệ" });
      if (self && b.role !== "ws_admin") {
        return reply.code(400).send({ error: "Không thể tự hạ quyền quản trị của chính mình" });
      }
      await updateMemberRole(db, req.authCtx, id, b.role);
    }
    const profile: { name?: string; isActive?: boolean } = {};
    if (typeof b.name === "string" && b.name.trim()) profile.name = b.name.trim();
    if (typeof b.isActive === "boolean") {
      if (self && !b.isActive) return reply.code(400).send({ error: "Không thể tự khóa tài khoản của chính mình" });
      profile.isActive = b.isActive;
    }
    await updateUserProfile(db, id, profile);
    if (profile.isActive === false) await revokeAllWebSessions(db, id);
    if (Array.isArray(b.agentIds)) {
      await setUserAgentGrants(
        db,
        req.authCtx,
        id,
        b.agentIds.filter((x): x is string => typeof x === "string"),
      );
    }
    await recordAudit(db, req.authCtx, "user.update", {
      userId: id,
      ...(b.role !== undefined ? { role: b.role } : {}),
      ...(profile.isActive !== undefined ? { isActive: profile.isActive } : {}),
      ...(Array.isArray(b.agentIds) ? { agentCount: b.agentIds.length } : {}),
    });
    return { ok: true };
  });

  app.post("/v1/users/:id/password", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    if (!(await isWorkspaceMember(db, req.authCtx, id))) {
      return reply.code(404).send({ error: "Người dùng không thuộc workspace" });
    }
    const b = (req.body ?? {}) as { password?: unknown; mustChange?: unknown };
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < MIN_PASSWORD) {
      return reply.code(400).send({ error: `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự` });
    }
    await setUserPassword(db, id, password, { mustChange: b.mustChange === true });
    await revokeAllWebSessions(db, id);
    await recordAudit(db, req.authCtx, "user.password_reset", { userId: id });
    return { ok: true };
  });

  app.delete("/v1/users/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    if (id === req.authCtx.userId) return reply.code(400).send({ error: "Không thể xóa chính mình" });
    const ok = await removeWorkspaceMember(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Người dùng không thuộc workspace" });
    await revokeAllWebSessions(db, id);
    await recordAudit(db, req.authCtx, "user.remove", { userId: id });
    return { removed: true };
  });
}
