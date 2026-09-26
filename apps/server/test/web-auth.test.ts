/**
 * Đăng nhập Dashboard bằng tài khoản + role member + gán agent (0024).
 * Chạy trên Postgres thật (như e2e.test.ts).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, hashPassword } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;

const ADMIN_EMAIL = "admin@test.local";
const ADMIN_PASS = "matkhau-admin-123";

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const sc = res.headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : String(sc ?? "");
  return raw.split(";")[0] ?? "";
};
const withCookie = (cookie: string) => ({ cookie });

async function login(email: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  return { res, cookie: res.statusCode === 200 ? cookieOf(res) : "" };
}

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  const dataDir = await mkdtemp(join(tmpdir(), "penai-webauth-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
  // Admin đầu tiên (bootstrap như cli-user.ts)
  const [u] = await adminQuery<{ id: string }>(
    `INSERT INTO users (email, name, company_role, password_hash)
     VALUES ($1, 'Admin Test', 'owner', $2) RETURNING id`,
    [ADMIN_EMAIL, hashPassword(ADMIN_PASS)],
  );
  await adminQuery(
    `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'ws_admin')`,
    [u!.id, fx.wsA],
  );
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Đăng nhập web (cookie) + role member + agent grants", () => {
  let adminCookie = "";
  let memberId = "";
  let memberCookie = "";
  const MEMBER_EMAIL = "nv@test.local";
  const MEMBER_PASS = "matkhau-nv-123";

  it("sai mật khẩu → 401; đúng → 200 + cookie httpOnly; /auth/me trả role", async () => {
    const bad = await login(ADMIN_EMAIL, "sai-roi-nhe");
    expect(bad.res.statusCode).toBe(401);

    const ok = await login(ADMIN_EMAIL, ADMIN_PASS);
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.json()).toMatchObject({ role: "ws_admin", user: { email: ADMIN_EMAIL } });
    const sc = String(ok.res.headers["set-cookie"]);
    expect(sc).toContain("penai_session=pss_");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    adminCookie = ok.cookie;

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: withCookie(adminCookie) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "ws_admin", authKind: "web", workspace: { slug: "ws-a" } });
  });

  it("API key vẫn dùng được song song (authKind=apikey)", async () => {
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(fx.keys.aOperator) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "operator", authKind: "apikey" });
  });

  it("cookie + Sec-Fetch-Site: cross-site trên POST → 403 (CSRF)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...withCookie(adminCookie), "sec-fetch-site": "cross-site" },
      payload: { agentKey: "tro-ly" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ws_admin tạo member + gán agent; operator không được tạo user", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: bearer(fx.keys.aOperator),
      payload: { email: MEMBER_EMAIL, password: MEMBER_PASS },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: withCookie(adminCookie),
      payload: {
        email: MEMBER_EMAIL,
        name: "Nhân viên",
        password: MEMBER_PASS,
        role: "member",
        agentIds: [fx.agentA],
      },
    });
    expect(res.statusCode).toBe(201);
    memberId = (res.json() as { id: string }).id;

    const list = await app.inject({ method: "GET", url: "/v1/users", headers: withCookie(adminCookie) });
    expect(list.statusCode).toBe(200);
    const users = (list.json() as { users: Array<{ email: string; role: string; agentIds: string[] }> }).users;
    const nv = users.find((u) => u.email === MEMBER_EMAIL);
    expect(nv).toMatchObject({ role: "member", agentIds: [fx.agentA] });
  });

  it("member: chỉ thấy agent được gán (không lộ systemPrompt), bị chặn mọi route khác", async () => {
    const l = await login(MEMBER_EMAIL, MEMBER_PASS);
    expect(l.res.statusCode).toBe(200);
    memberCookie = l.cookie;

    // Tạo thêm agent thứ 2 trong ws A (không gán cho member)
    const a2 = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: bearer(fx.keys.aAdmin),
      payload: { key: "agent-khac", name: "Agent khác", provider: "default", model: "mock-model" },
    });
    expect(a2.statusCode).toBe(201);

    const agents = await app.inject({ method: "GET", url: "/v1/agents", headers: withCookie(memberCookie) });
    expect(agents.statusCode).toBe(200);
    const arr = (agents.json() as { agents: Array<Record<string, unknown>> }).agents;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.key).toBe("tro-ly");
    expect(arr[0]!.systemPrompt).toBeUndefined();

    for (const url of ["/v1/users", "/v1/api-keys", "/v1/channels", "/v1/vault", "/v1/traces"]) {
      const r = await app.inject({ method: "GET", url, headers: withCookie(memberCookie) });
      expect(r.statusCode, url).toBe(403);
    }
    const create = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: withCookie(memberCookie),
      payload: { key: "x", name: "x", provider: "default", model: "m" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("member: tạo phiên với agent được gán OK, agent không được gán → 404; chỉ thấy phiên của mình", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: withCookie(memberCookie),
      payload: { agentKey: "tro-ly" },
    });
    expect(ok.statusCode).toBe(201);
    const mine = (ok.json() as { session: { id: string } }).session.id;

    const denied = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: withCookie(memberCookie),
      payload: { agentKey: "agent-khac" },
    });
    expect(denied.statusCode).toBe(404);

    // Phiên của admin — member không thấy, không đọc được, không xóa được
    const adminSess = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: withCookie(adminCookie),
      payload: { agentKey: "tro-ly" },
    });
    const other = (adminSess.json() as { session: { id: string } }).session.id;

    const list = await app.inject({ method: "GET", url: "/v1/sessions", headers: withCookie(memberCookie) });
    const ids = (list.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);

    const msgs = await app.inject({ method: "GET", url: `/v1/sessions/${other}/messages`, headers: withCookie(memberCookie) });
    expect(msgs.statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: `/v1/sessions/${other}`, headers: withCookie(memberCookie) });
    expect(del.statusCode).toBe(404);

    // Chat thật qua mock LLM với phiên của mình
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: withCookie(memberCookie),
      payload: { sessionId: mine, message: "xin chào", stream: false },
    });
    expect(chat.statusCode).toBe(200);
    const chatOther = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: withCookie(memberCookie),
      payload: { sessionId: other, message: "xin chào", stream: false },
    });
    expect(chatOther.statusCode).toBe(404);
  });

  it("đổi role có hiệu lực ngay ở request kế (viewer không được chat)", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { role: "viewer" },
    });
    expect(patch.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: withCookie(memberCookie) });
    expect(me.json()).toMatchObject({ role: "viewer" });
    const sess = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: withCookie(memberCookie),
      payload: { agentKey: "tro-ly" },
    });
    expect(sess.statusCode).toBe(403);
    // trả về member
    await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { role: "member" },
    });
  });

  it("admin không tự hạ quyền / tự khóa; gỡ agent grant → member hết thấy agent", async () => {
    const meRes = await app.inject({ method: "GET", url: "/auth/me", headers: withCookie(adminCookie) });
    const adminId = (meRes.json() as { user: { id: string } }).user.id;
    const demote = await app.inject({
      method: "PATCH",
      url: `/v1/users/${adminId}`,
      headers: withCookie(adminCookie),
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(400);
    const lock = await app.inject({
      method: "PATCH",
      url: `/v1/users/${adminId}`,
      headers: withCookie(adminCookie),
      payload: { isActive: false },
    });
    expect(lock.statusCode).toBe(400);

    await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { agentIds: [] },
    });
    const agents = await app.inject({ method: "GET", url: "/v1/agents", headers: withCookie(memberCookie) });
    expect((agents.json() as { agents: unknown[] }).agents).toHaveLength(0);
    await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { agentIds: [fx.agentA] },
    });
  });

  it("đặt lại mật khẩu bởi admin → phiên cũ bị thu hồi; bắt đổi mật khẩu chặn mọi route trừ /auth/*", async () => {
    const reset = await app.inject({
      method: "POST",
      url: `/v1/users/${memberId}/password`,
      headers: withCookie(adminCookie),
      payload: { password: "mat-khau-tam-999", mustChange: true },
    });
    expect(reset.statusCode).toBe(200);
    const dead = await app.inject({ method: "GET", url: "/auth/me", headers: withCookie(memberCookie) });
    expect(dead.statusCode).toBe(401);

    const l = await login(MEMBER_EMAIL, "mat-khau-tam-999");
    expect(l.res.statusCode).toBe(200);
    expect(l.res.json()).toMatchObject({ mustChangePassword: true });
    const blocked = await app.inject({ method: "GET", url: "/v1/agents", headers: withCookie(l.cookie) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "must_change_password" });

    const weak = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: withCookie(l.cookie),
      payload: { currentPassword: "mat-khau-tam-999", newPassword: "ngan" },
    });
    expect(weak.statusCode).toBe(400);
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: withCookie(l.cookie),
      payload: { currentPassword: "mat-khau-tam-999", newPassword: MEMBER_PASS },
    });
    expect(changed.statusCode).toBe(200);
    memberCookie = cookieOf(changed);
    const agents = await app.inject({ method: "GET", url: "/v1/agents", headers: withCookie(memberCookie) });
    expect(agents.statusCode).toBe(200);
  });

  it("khóa tài khoản → không đăng nhập được; đăng xuất → cookie hết hiệu lực", async () => {
    await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { isActive: false },
    });
    const l = await login(MEMBER_EMAIL, MEMBER_PASS);
    expect(l.res.statusCode).toBe(403);
    await app.inject({
      method: "PATCH",
      url: `/v1/users/${memberId}`,
      headers: withCookie(adminCookie),
      payload: { isActive: true },
    });

    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: withCookie(adminCookie) });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/auth/me", headers: withCookie(adminCookie) });
    expect(after.statusCode).toBe(401);
  });

  it("gỡ khỏi workspace → không đăng nhập được (không còn workspace)", async () => {
    const l0 = await login(ADMIN_EMAIL, ADMIN_PASS);
    const rm = await app.inject({ method: "DELETE", url: `/v1/users/${memberId}`, headers: withCookie(l0.cookie) });
    expect(rm.statusCode).toBe(200);
    const l = await login(MEMBER_EMAIL, MEMBER_PASS);
    expect(l.res.statusCode).toBe(403);
  });
});
