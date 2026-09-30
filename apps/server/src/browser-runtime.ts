/**
 * Trình duyệt cho agent — phần runtime + API Dashboard → Trình duyệt.
 *
 * - Một BrowserManager dùng chung cả tiến trình (một Chromium, nhiều phiên).
 * - Hồ sơ trình duyệt (bảng browser_profiles): cookie đăng nhập sẵn, mã hóa bằng
 *   PENAI_MASTER_KEY. API không bao giờ trả giá trị cookie — chỉ tên, tên miền, hạn.
 * - Agent được gán hồ sơ (agents.browser_profile_id) → mọi phiên của agent đó mang
 *   cookie của hồ sơ; đóng phiên thì cookie mới (trang web tự làm mới) được lưu lại.
 *
 * Cấu hình qua biến môi trường (penai.env, đều có mặc định):
 *   PENAI_BROWSER_MAX_SESSIONS  số phiên mở cùng lúc (mặc định 2 — mỗi phiên ~150–400 MB RAM)
 *   PENAI_BROWSER_IDLE_MIN      phút rảnh thì tự đóng phiên (mặc định 10)
 *   CHROME_PATH                 dùng Chrome/Chromium có sẵn thay cho bản tự cài
 *   PENAI_BROWSER_ALLOW_PRIVATE=1  cho phép mở địa chỉ mạng nội bộ (mặc định chặn)
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, hasRole, logger, type WorkspaceContext } from "@penai/shared";
import {
  createBrowserProfile,
  deleteBrowserProfile,
  getBrowserProfile,
  listAgents,
  listBrowserProfiles,
  recordAudit,
  setBrowserProfileCookies,
  updateBrowserProfile,
  type BrowserProfileRow,
  type Db,
} from "@penai/db";
import {
  baseDomain,
  BrowserActionError,
  BrowserManager,
  BrowserUnavailableError,
  cookieInDomains,
  cookieMeta,
  CookieParseError,
  dropExpired,
  loadCookieJson,
  mergeCookies,
  mergeSessionCookies,
  parseCookieInput,
  type BrowserCookie,
  type BrowserProfileData,
  type ToolContext,
} from "@penai/tools";

let manager: BrowserManager | null = null;

const envInt = (name: string, def: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};

export function getBrowserManager(): BrowserManager {
  if (!manager) {
    manager = new BrowserManager({
      maxSessions: envInt("PENAI_BROWSER_MAX_SESSIONS", 2, 1, 10),
      idleMs: envInt("PENAI_BROWSER_IDLE_MIN", 10, 1, 240) * 60_000,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      logger,
    });
  }
  return manager;
}

export async function shutdownBrowser(): Promise<void> {
  if (manager) await manager.shutdown().catch(() => {});
}

// ---------------------------------------------------------------- cookie ↔ DB

export function profileCookies(row: Pick<BrowserProfileRow, "cookiesEncrypted">): BrowserCookie[] {
  if (!row.cookiesEncrypted) return [];
  try {
    return loadCookieJson(decryptSecret(row.cookiesEncrypted));
  } catch (e) {
    logger.warn(`Hồ sơ trình duyệt: không giải mã được cookie (${(e as Error).message})`);
    return [];
  }
}

async function saveProfileCookies(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  cookies: BrowserCookie[],
  source: "admin" | "session",
): Promise<BrowserProfileRow | null> {
  return setBrowserProfileCookies(db, ctx, id, {
    cookiesEncrypted: cookies.length ? encryptSecret(JSON.stringify(cookies)) : null,
    cookieCount: cookies.length,
    source,
  });
}

function toProfileData(row: BrowserProfileRow): BrowserProfileData {
  return {
    id: row.id,
    version: String(row.updatedAt.getTime()),
    cookies: dropExpired(profileCookies(row)),
    ...(row.userAgent ? { userAgent: row.userAgent } : {}),
    locale: row.locale || "vi-VN",
    timezone: row.timezone || "Asia/Ho_Chi_Minh",
    autoSave: row.autoSave,
  };
}

/**
 * Trình duyệt cho một lượt chạy agent. Phiên theo agent + người đang chat: cùng
 * người nhắn tiếp thì vẫn ở đúng trang đang mở; người khác có phiên riêng.
 */
export function browserForRun(
  db: Db,
  ctx: WorkspaceContext,
  opts: { agentId?: string; userKey?: string; profileId?: string | null },
): NonNullable<ToolContext["browser"]> {
  const owner = {
    key: `${ctx.workspaceId}:${opts.agentId ?? "-"}:${opts.userKey ?? "operator"}`,
    loadProfile: async () => {
      if (!opts.profileId) return null;
      const row = await getBrowserProfile(db, ctx, opts.profileId);
      return row ? toProfileData(row) : null;
    },
    saveCookies: async (profileId: string, fromSession: BrowserCookie[]) => {
      const row = await getBrowserProfile(db, ctx, profileId);
      if (!row || !row.autoSave) return;
      await saveProfileCookies(db, ctx, profileId, mergeSessionCookies(profileCookies(row), fromSession), "session");
    },
  };
  return {
    act: async (action) => {
      try {
        return await getBrowserManager().act(owner, action);
      } catch (e) {
        if (e instanceof BrowserActionError || e instanceof BrowserUnavailableError) throw e;
        throw new Error(`Trình duyệt lỗi: ${(e as Error).message.split("\n")[0]}`);
      }
    },
  };
}

// ---------------------------------------------------------------- trạng thái cài đặt

/** File trạng thái do `penai install-browser` ghi (thư mục nhà của user dịch vụ). */
async function setupStatus(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(homedir(), "browser-setup.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- API Dashboard

const ProfileBody = z.object({
  name: z.string().trim().min(1, "Chưa nhập tên hồ sơ").max(80),
  description: z.string().max(500).optional(),
  userAgent: z.string().trim().max(400).optional(),
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "Ngôn ngữ dạng vi-VN, en-US")
    .optional(),
  timezone: z.string().trim().min(1).max(60).optional(),
  autoSave: z.boolean().optional(),
});

const ImportBody = z.object({
  content: z.string().min(1, "Chưa dán nội dung cookie").max(500_000),
  domain: z.string().trim().max(200).optional(),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

const DeleteCookiesBody = z.object({
  all: z.boolean().optional(),
  domain: z.string().trim().max(200).optional(),
  items: z
    .array(z.object({ name: z.string(), domain: z.string(), path: z.string().default("/") }))
    .max(500)
    .optional(),
});

const TestBody = z.object({ url: z.string().trim().url("Địa chỉ không hợp lệ").max(2000) });

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zodMsg(e: z.ZodError): string {
  return e.issues.map((i) => i.message).join("; ");
}

export function registerBrowserRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!hasRole(req.authCtx.role, "ws_admin")) {
      void reply.code(403).send({ error: "Chỉ quản trị viên (ws_admin) quản lý trình duyệt" });
      return false;
    }
    return true;
  };

  const view = (row: BrowserProfileRow, agents: Array<{ id: string; key: string; name: string; browserProfileId: string | null }>) => {
    const cookies = profileCookies(row);
    const now = Date.now() / 1000;
    const domains = new Map<string, { count: number; expired: number; soonest: number | null }>();
    for (const c of cookies) {
      const d = baseDomain(c.domain);
      const x = domains.get(d) ?? { count: 0, expired: 0, soonest: null };
      x.count += 1;
      if (c.expires !== -1 && c.expires <= now) x.expired += 1;
      else if (c.expires !== -1 && (x.soonest === null || c.expires < x.soonest)) x.soonest = c.expires;
      domains.set(d, x);
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      userAgent: row.userAgent,
      locale: row.locale,
      timezone: row.timezone,
      autoSave: row.autoSave,
      cookieCount: cookies.length,
      cookiesUpdatedAt: row.cookiesUpdatedAt,
      updatedAt: row.updatedAt,
      domains: [...domains.entries()].map(([domain, v]) => ({ domain, ...v })),
      agents: agents.filter((a) => a.browserProfileId === row.id).map((a) => ({ id: a.id, key: a.key, name: a.name })),
    };
  };

  app.get("/v1/browser", async (req, reply) => {
    if (!guard(req, reply)) return;
    const ctx = req.authCtx;
    const [rows, agents, inst, setup] = await Promise.all([
      listBrowserProfiles(db, ctx),
      listAgents(db, ctx),
      BrowserManager.installed(process.env.CHROME_PATH),
      setupStatus(),
    ]);
    const m = getBrowserManager();
    const st = m.stats();
    const agentRefs = agents.map((a) => ({ id: a.id, key: a.key, name: a.name, browserProfileId: a.browserProfileId ?? null }));
    return {
      status: {
        installed: inst.ok,
        setup,
        running: st.running,
        maxSessions: m.maxSessions,
        idleMin: Math.round(m.idleMs / 60_000),
        // Chỉ phiên của workspace này; khóa phiên nội bộ không trả ra
        sessions: st.sessions
          .filter((s) => s.key.startsWith(`${ctx.workspaceId}:`))
          .map((s) => {
            const parts = s.key.split(":");
            const agentId = parts[1] ?? "";
            const a = agents.find((x) => x.id === agentId);
            const agent = a ? a.name : agentId.startsWith("test-") ? "(thử truy cập)" : agentId;
            return { agent, user: parts.slice(2).join(":"), url: s.url, idleSec: s.idleSec };
          }),
      },
      profiles: rows.map((r) => view(r, agentRefs)),
    };
  });

  app.post("/v1/browser/profiles", async (req, reply) => {
    if (!guard(req, reply)) return;
    const p = ProfileBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: zodMsg(p.error) });
    if (p.data.timezone && !validTimezone(p.data.timezone)) return reply.code(400).send({ error: "Múi giờ không hợp lệ (vd Asia/Ho_Chi_Minh)" });
    try {
      const row = await createBrowserProfile(db, req.authCtx, p.data);
      await recordAudit(db, req.authCtx, "browser.profile_create", { profileId: row.id, name: row.name });
      return reply.code(201).send({ profile: { id: row.id, name: row.name } });
    } catch (e) {
      if (/browser_profiles_ws_name_uq|duplicate key/i.test((e as Error).message)) {
        return reply.code(409).send({ error: "Đã có hồ sơ trùng tên" });
      }
      throw e;
    }
  });

  app.patch("/v1/browser/profiles/:id", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = ProfileBody.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: zodMsg(p.error) });
    if (p.data.timezone && !validTimezone(p.data.timezone)) return reply.code(400).send({ error: "Múi giờ không hợp lệ (vd Asia/Ho_Chi_Minh)" });
    const clean = Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined));
    let row: BrowserProfileRow | null;
    try {
      row = await updateBrowserProfile(db, req.authCtx, id, clean);
    } catch (e) {
      if (/browser_profiles_ws_name_uq|duplicate key/i.test((e as Error).message)) {
        return reply.code(409).send({ error: "Đã có hồ sơ trùng tên" });
      }
      throw e;
    }
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    await getBrowserManager().closeProfileSessions(id);
    await recordAudit(db, req.authCtx, "browser.profile_update", { profileId: id, fields: Object.keys(clean) });
    return { ok: true };
  });

  app.delete("/v1/browser/profiles/:id", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getBrowserProfile(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    await getBrowserManager().closeProfileSessions(id);
    await deleteBrowserProfile(db, req.authCtx, id);
    await recordAudit(db, req.authCtx, "browser.profile_delete", { profileId: id, name: row.name });
    return { ok: true };
  });

  // Danh sách cookie — KHÔNG có giá trị
  app.get("/v1/browser/profiles/:id/cookies", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getBrowserProfile(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    return { cookies: cookieMeta(profileCookies(row)) };
  });

  app.post("/v1/browser/profiles/:id/cookies", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = ImportBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: zodMsg(p.error) });
    const row = await getBrowserProfile(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    let incoming: BrowserCookie[];
    try {
      incoming = parseCookieInput(p.data.content, p.data.domain ? { defaultDomain: p.data.domain } : {});
    } catch (e) {
      if (e instanceof CookieParseError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const expired = incoming.length - dropExpired(incoming).length;
    const base = p.data.mode === "replace" ? [] : profileCookies(row);
    const next = dropExpired(mergeCookies(base, incoming));
    await saveProfileCookies(db, req.authCtx, id, next, "admin");
    const closed = await getBrowserManager().closeProfileSessions(id);
    const domains = [...new Set(incoming.map((c) => baseDomain(c.domain)))];
    await recordAudit(db, req.authCtx, "browser.cookies_import", {
      profileId: id,
      mode: p.data.mode,
      count: incoming.length,
      domains,
    });
    return { imported: incoming.length, expiredSkipped: expired, total: next.length, domains, closedSessions: closed };
  });

  app.post("/v1/browser/profiles/:id/cookies/delete", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = DeleteCookiesBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: zodMsg(p.error) });
    const row = await getBrowserProfile(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    const cur = profileCookies(row);
    let next: BrowserCookie[];
    if (p.data.all) next = [];
    else if (p.data.domain) next = cur.filter((c) => !cookieInDomains(c, [p.data.domain!]));
    else if (p.data.items?.length) {
      const drop = new Set(p.data.items.map((i) => `${i.name}\u0000${i.domain}\u0000${i.path}`));
      next = cur.filter((c) => !drop.has(`${c.name}\u0000${c.domain}\u0000${c.path}`));
    } else return reply.code(400).send({ error: "Chọn cookie cần xóa (items), một tên miền (domain) hoặc all" });
    await saveProfileCookies(db, req.authCtx, id, next, "admin");
    await getBrowserManager().closeProfileSessions(id);
    await recordAudit(db, req.authCtx, "browser.cookies_delete", {
      profileId: id,
      removed: cur.length - next.length,
      ...(p.data.all ? { all: true } : {}),
      ...(p.data.domain ? { domain: p.data.domain } : {}),
    });
    return { removed: cur.length - next.length, total: next.length };
  });

  // Thử truy cập bằng hồ sơ: mở trang, chụp màn hình, đóng phiên thử (không lưu cookie)
  app.post("/v1/browser/profiles/:id/test", async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = TestBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: zodMsg(p.error) });
    const row = await getBrowserProfile(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Hồ sơ không tồn tại" });
    const m = getBrowserManager();
    const owner = {
      key: `${req.authCtx.workspaceId}:test-${id}:${req.authCtx.userId}`,
      loadProfile: async () => toProfileData(row),
    };
    try {
      const opened = await m.act(owner, { action: "open", url: p.data.url });
      const shot = await m.act(owner, { action: "screenshot" });
      const head = opened.text.split("\n");
      return {
        title: (head.find((l) => l.startsWith("Trang: ")) ?? "").slice(7),
        url: (head.find((l) => l.startsWith("URL: ")) ?? "").slice(5),
        notes: head.filter((l) => l.startsWith("⚠️")),
        image: shot.image ? `data:image/jpeg;base64,${shot.image.toString("base64")}` : null,
        text: opened.text.slice(opened.text.indexOf("--- Nội dung chữ")).slice(0, 1500),
      };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message.split("\n\n")[0] });
    } finally {
      await m.closeSession(owner.key, false);
    }
  });

  // Đóng mọi phiên đang mở của workspace (vd trang bị kẹt) — cookie được lưu lại
  app.post("/v1/browser/sessions/close", async (req, reply) => {
    if (!guard(req, reply)) return;
    const m = getBrowserManager();
    const keys = m.stats().sessions.map((s) => s.key).filter((k) => k.startsWith(`${req.authCtx.workspaceId}:`));
    for (const k of keys) await m.closeSession(k, true);
    return { closed: keys.length };
  });
}
