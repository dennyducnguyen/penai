/**
 * App Meta riêng của người dùng (không qua hub): người dùng tạo app ở developers.facebook.com,
 * dán App ID + App Secret vào PenAI, đăng nhập Facebook → chọn Trang/Instagram → mỗi Trang một kênh.
 * Meta gửi webhook THẲNG tới /webhooks/meta-app/<id> (ký bằng App Secret).
 *
 * Ở chế độ phát triển (Development mode) app dùng được với Trang mà người đăng nhập quản trị,
 * không cần Meta duyệt. Tài liệu: docs/facebook-instagram.md mục 7.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, hasRole, logger, type WorkspaceContext } from "@penai/shared";
import {
  createChannel,
  createMetaApp,
  deleteMetaApp,
  getAgentByKey,
  getChannelById,
  getMetaApp,
  listChannels,
  listMetaApps,
  lookupMetaApp,
  recordAudit,
  updateChannel,
  updateMetaApp,
  type ChannelRow,
  type Db,
  type MetaAppRow,
} from "@penai/db";
import {
  META_GRAPH_BASE,
  MetaPageChannel,
  isMetaChannelKind,
  parseMetaCredentials,
  serializeMetaCredentials,
  verifyMetaAppSignature,
  type MetaChannelKind,
} from "@penai/channels";
import { applyChannelChange, channelHandlers } from "./channels-runtime.js";

/** Quyền xin khi đăng nhập Facebook (người dùng bỏ tick được trên hộp thoại của Facebook). */
const BASE_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_engagement",
  "pages_manage_posts",
  "read_insights",
];
const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_content_publish", "instagram_manage_insights"];
/** Sự kiện Trang đăng ký nhận: tin nhắn, bấm nút, tin dội lại (người trả lời ngoài PenAI), bình luận. */
const PAGE_FIELDS = "messages,messaging_postbacks,message_echoes,feed";

function publicBase(): string {
  return (process.env.PENAI_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
}
export function metaAppRedirectUri(): string {
  return `${publicBase()}/oauth/meta/callback`;
}
export function metaAppWebhookUrl(appRowId: string): string {
  return `${publicBase()}/webhooks/meta-app/${appRowId}`;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const proof = (secret: string, token: string) => createHmac("sha256", secret).update(token).digest("hex");

/** GET Graph API bằng token người dùng/Trang (kèm appsecret_proof). Lỗi → Error có thông báo của Meta. */
async function graphGet(path: string, token: string, appSecret: string, query: Record<string, string> = {}): Promise<Obj> {
  const url = new URL(path.startsWith("http") ? path : `${META_GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  url.searchParams.set("appsecret_proof", proof(appSecret, token));
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const j = obj(await res.json().catch(() => ({})));
  if (!res.ok || j.error) throw new Error(str(obj(j.error).message) || `Graph API lỗi HTTP ${res.status}`);
  return j;
}

async function graphPost(path: string, token: string, appSecret: string, body: Record<string, string>): Promise<Obj> {
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("appsecret_proof", proof(appSecret, token));
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const j = obj(await res.json().catch(() => ({})));
  if (!res.ok || j.error) throw new Error(str(obj(j.error).message) || `Graph API lỗi HTTP ${res.status}`);
  return j;
}

interface MetaPageItem {
  id: string;
  name: string;
  accessToken: string;
  avatar: string;
  instagram: { id: string; username: string; name: string; avatar: string } | null;
}

/** Trang người đăng nhập quản trị (kèm Instagram Business liên kết). */
async function listUserPages(userToken: string, appSecret: string): Promise<MetaPageItem[]> {
  const out: MetaPageItem[] = [];
  let next: string | null = `${META_GRAPH_BASE}/me/accounts`;
  let query: Record<string, string> = { fields: "id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}", limit: "100" };
  for (let i = 0; next && i < 10; i++) {
    const j = await graphGet(next, userToken, appSecret, query);
    for (const x of Array.isArray(j.data) ? j.data : []) {
      const o = obj(x);
      const ig = obj(o.instagram_business_account);
      out.push({
        id: str(o.id),
        name: str(o.name),
        accessToken: str(o.access_token),
        avatar: str(obj(obj(o.picture).data).url),
        instagram: str(ig.id) ? { id: str(ig.id), username: str(ig.username), name: str(ig.name), avatar: str(ig.profile_picture_url) } : null,
      });
    }
    next = str(obj(j.paging).next) || null;
    query = {};
  }
  return out;
}

/** Đăng ký Trang gửi sự kiện cho app (tin nhắn, tin dội lại, bình luận). */
async function subscribePage(pageId: string, pageToken: string, appSecret: string): Promise<string | null> {
  try {
    await graphPost(`/${pageId}/subscribed_apps`, pageToken, appSecret, { subscribed_fields: PAGE_FIELDS });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function toEnabledChannel(c: ChannelRow) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    kind: c.kind,
    name: c.name,
    agentId: c.agentId,
    tokenEncrypted: c.tokenEncrypted,
    config: (c.config as Record<string, unknown>) ?? {},
    requirePairing: c.requirePairing,
  };
}

const appChannels = async (db: Db, ctx: WorkspaceContext, appRowId: string) =>
  (await listChannels(db, ctx)).filter((c) => isMetaChannelKind(c.kind) && (c.config as Obj)?.["mode"] === "app" && (c.config as Obj)?.["metaAppId"] === appRowId);

/** Đăng ký lại Trang của một kênh app riêng (nút "Đăng ký lại" trên Dashboard). */
export async function resubscribeAppChannel(db: Db, ctx: WorkspaceContext, row: ChannelRow): Promise<{ ok: boolean; message: string }> {
  const cfg = (row.config as Obj) ?? {};
  const app = await getMetaApp(db, ctx, str(cfg["metaAppId"]));
  if (!app) return { ok: false, message: "App Meta của kênh này đã bị xóa — kết nối lại Trang bằng app khác." };
  const creds = parseMetaCredentials(row.tokenEncrypted ? decryptSecret(row.tokenEncrypted) : "");
  const err = await subscribePage(str(cfg["pageId"]), creds.pageAccessToken, decryptSecret(app.appSecretEncrypted));
  await updateChannel(db, ctx, row.id, { config: { ...cfg, subscribeError: err, subscribedAt: err ? (cfg["subscribedAt"] ?? null) : new Date().toISOString() } });
  return err ? { ok: false, message: err } : { ok: true, message: "OK" };
}

function publicApp(a: MetaAppRow, channels: number) {
  const expires = a.userTokenExpiresAt ? new Date(a.userTokenExpiresAt) : null;
  return {
    id: a.id,
    name: a.name,
    appId: a.appId,
    loginConfigId: a.loginConfigId,
    verifyToken: a.verifyToken,
    redirectUri: metaAppRedirectUri(),
    webhookUrl: metaAppWebhookUrl(a.id),
    loggedIn: !!a.userTokenEncrypted,
    fbUserName: a.fbUserName,
    tokenExpiresAt: a.userTokenExpiresAt,
    tokenExpired: !!expires && expires.getTime() < Date.now(),
    grantedScopes: a.grantedScopes,
    channels,
  };
}

/** Đăng nhập đang chờ Facebook chuyển về (state → ngữ cảnh), 10 phút. */
const pendingLogins = new Map<string, { workspaceId: string; userId: string; role: WorkspaceContext["role"]; appRowId: string; at: number }>();

const AppBody = z.object({
  name: z.string().max(100).optional(),
  appId: z.string().regex(/^\d{5,25}$/, "App ID là dãy số (lấy ở App settings → Basic)"),
  appSecret: z.string().regex(/^[a-f0-9]{16,64}$/i, "App Secret là chuỗi chữ-số hex (App settings → Basic → Show)"),
  loginConfigId: z.string().regex(/^\d{0,25}$/).optional(),
});
const AppPatch = z.object({
  name: z.string().max(100).optional(),
  appSecret: z.string().regex(/^[a-f0-9]{16,64}$/i).optional(),
  loginConfigId: z.string().regex(/^\d{0,25}$/).optional(),
});
const ConnectBody = z.object({
  pageId: z.string().regex(/^\d{3,30}$/),
  platform: z.enum(["facebook", "instagram"]),
  agentKey: z.string().max(100),
  name: z.string().max(200).optional(),
  requirePairing: z.boolean().optional(),
  agentReply: z.boolean().optional(),
});

export function registerMetaAppRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  function admin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!hasRole(req.authCtx.role, "ws_admin")) {
      void reply.code(403).send({ error: "Cần quyền quản trị workspace" });
      return false;
    }
    return true;
  }

  app.get("/v1/meta-apps", async (req, reply) => {
    if (!admin(req, reply)) return;
    const [apps, channels] = await Promise.all([listMetaApps(db, req.authCtx), listChannels(db, req.authCtx)]);
    const count = (id: string) => channels.filter((c) => (c.config as Obj)?.["metaAppId"] === id).length;
    return { apps: apps.map((a) => publicApp(a, count(a.id))), redirectUri: metaAppRedirectUri(), ready: !!publicBase() };
  });

  app.post("/v1/meta-apps", async (req, reply) => {
    if (!admin(req, reply)) return;
    if (!publicBase()) return reply.code(400).send({ error: "Máy chủ thiếu PENAI_PUBLIC_URL trong penai.env — Meta không gửi tin về được." });
    const parsed = AppBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const b = parsed.data;
    if ((await listMetaApps(db, req.authCtx)).some((a) => a.appId === b.appId)) return reply.code(409).send({ error: "App ID này đã được thêm" });
    const row = await createMetaApp(db, req.authCtx, {
      name: b.name?.trim() || `App ${b.appId}`,
      appId: b.appId,
      appSecretEncrypted: encryptSecret(b.appSecret),
      verifyToken: `pvt_${randomBytes(18).toString("base64url")}`,
      loginConfigId: b.loginConfigId ?? "",
    });
    await recordAudit(db, req.authCtx, "meta_app.create", { id: row.id, appId: row.appId });
    return reply.code(201).send({ app: publicApp(row, 0) });
  });

  app.patch("/v1/meta-apps/:id", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = AppPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const b = parsed.data;
    const row = await updateMetaApp(db, req.authCtx, id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.appSecret ? { appSecretEncrypted: encryptSecret(b.appSecret) } : {}),
      ...(b.loginConfigId !== undefined ? { loginConfigId: b.loginConfigId } : {}),
    });
    if (!row) return reply.code(404).send({ error: "Không có app này" });
    if (b.appSecret) {
      // App Secret đổi → cập nhật cho mọi kênh của app (ký appsecret_proof)
      for (const ch of await appChannels(db, req.authCtx, id)) {
        const creds = parseMetaCredentials(ch.tokenEncrypted ? decryptSecret(ch.tokenEncrypted) : "");
        const updated = await updateChannel(db, req.authCtx, ch.id, { tokenEncrypted: encryptSecret(serializeMetaCredentials({ ...creds, appSecret: b.appSecret })) });
        if (updated?.enabled) await applyChannelChange(ch.id, toEnabledChannel(updated));
      }
    }
    await recordAudit(db, req.authCtx, "meta_app.update", { id, secret: !!b.appSecret });
    return { app: publicApp(row, (await appChannels(db, req.authCtx, id)).length) };
  });

  app.delete("/v1/meta-apps/:id", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const used = await appChannels(db, req.authCtx, id);
    if (used.length) return reply.code(409).send({ error: `App đang dùng cho ${used.length} kênh — xóa các kênh đó trước.` });
    if (!(await deleteMetaApp(db, req.authCtx, id))) return reply.code(404).send({ error: "Không có app này" });
    await recordAudit(db, req.authCtx, "meta_app.delete", { id });
    return { deleted: true };
  });

  // Bắt đầu đăng nhập Facebook → trả URL hộp thoại cấp quyền của Facebook
  app.post("/v1/meta-apps/:id/login", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const a = await getMetaApp(db, req.authCtx, id);
    if (!a) return reply.code(404).send({ error: "Không có app này" });
    const instagram = (req.body as { instagram?: boolean } | undefined)?.instagram !== false;
    const state = randomBytes(24).toString("base64url");
    pendingLogins.set(state, { workspaceId: req.authCtx.workspaceId, userId: req.authCtx.userId, role: req.authCtx.role, appRowId: id, at: Date.now() });
    for (const [k, v] of pendingLogins) if (Date.now() - v.at > 10 * 60_000) pendingLogins.delete(k);
    const url = new URL("https://www.facebook.com/v22.0/dialog/oauth");
    url.searchParams.set("client_id", a.appId);
    url.searchParams.set("redirect_uri", metaAppRedirectUri());
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    if (a.loginConfigId) url.searchParams.set("config_id", a.loginConfigId);
    else url.searchParams.set("scope", [...BASE_SCOPES, ...(instagram ? INSTAGRAM_SCOPES : [])].join(","));
    return { url: url.toString() };
  });

  // Facebook chuyển về sau khi người dùng cấp quyền (đường dẫn công khai — xác thực bằng state)
  app.get("/oauth/meta/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (ok: boolean, msg: string, appId = "") =>
      reply.redirect(`/#/channels?metaApp=${encodeURIComponent(appId)}&login=${ok ? "ok" : "error"}&msg=${encodeURIComponent(msg.slice(0, 300))}`);
    const pending = q.state ? pendingLogins.get(q.state) : undefined;
    if (!pending) return back(false, "Phiên đăng nhập hết hạn hoặc không hợp lệ — bấm Đăng nhập Facebook lại.");
    pendingLogins.delete(q.state!);
    const ctx: WorkspaceContext = { workspaceId: pending.workspaceId, userId: pending.userId, role: pending.role };
    if (q.error || !q.code) return back(false, q.error_description || "Bạn đã hủy đăng nhập Facebook.", pending.appRowId);
    const a = await getMetaApp(db, ctx, pending.appRowId);
    if (!a) return back(false, "App không còn tồn tại.");
    const secret = decryptSecret(a.appSecretEncrypted);
    try {
      const tokenUrl = new URL(`${META_GRAPH_BASE}/oauth/access_token`);
      tokenUrl.searchParams.set("client_id", a.appId);
      tokenUrl.searchParams.set("redirect_uri", metaAppRedirectUri());
      tokenUrl.searchParams.set("client_secret", secret);
      tokenUrl.searchParams.set("code", q.code);
      const shortRes = obj(await (await fetch(tokenUrl, { signal: AbortSignal.timeout(20_000) })).json());
      const short = str(shortRes.access_token);
      if (!short) throw new Error(str(obj(shortRes.error).message) || "Facebook không trả token");
      const longUrl = new URL(`${META_GRAPH_BASE}/oauth/access_token`);
      longUrl.searchParams.set("grant_type", "fb_exchange_token");
      longUrl.searchParams.set("client_id", a.appId);
      longUrl.searchParams.set("client_secret", secret);
      longUrl.searchParams.set("fb_exchange_token", short);
      const longRes = obj(await (await fetch(longUrl, { signal: AbortSignal.timeout(20_000) })).json());
      const userToken = str(longRes.access_token) || short;
      const expiresIn = Number(longRes.expires_in) || 60 * 86400;
      const me = await graphGet("/me", userToken, secret, { fields: "id,name" });
      const perms = await graphGet("/me/permissions", userToken, secret);
      const granted = (Array.isArray(perms.data) ? perms.data : []).map(obj).filter((p) => p.status === "granted").map((p) => str(p.permission));
      await updateMetaApp(db, ctx, a.id, {
        userTokenEncrypted: encryptSecret(userToken),
        userTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        fbUserId: str(me.id),
        fbUserName: str(me.name),
        grantedScopes: granted,
      });
      // Đăng nhập lại → làm mới token Trang cho các kênh đang dùng app này
      const pages = await listUserPages(userToken, secret).catch(() => [] as MetaPageItem[]);
      for (const ch of await appChannels(db, ctx, a.id)) {
        const page = pages.find((p) => p.id === str((ch.config as Obj)?.["pageId"]));
        if (!page?.accessToken) continue;
        const updated = await updateChannel(db, ctx, ch.id, { tokenEncrypted: encryptSecret(serializeMetaCredentials({ pageAccessToken: page.accessToken, penaiSecret: "", appSecret: secret })) });
        if (updated?.enabled) await applyChannelChange(ch.id, toEnabledChannel(updated));
      }
      await recordAudit(db, ctx, "meta_app.login", { id: a.id, fbUser: str(me.name), scopes: granted.length });
      return back(true, `Đã đăng nhập bằng ${str(me.name)}`, a.id);
    } catch (err) {
      logger.warn(`meta_app.callback (${a.appId}): ${(err as Error).message}`);
      return back(false, `Facebook từ chối: ${(err as Error).message}`, a.id);
    }
  });

  // Trang (và Instagram) người đăng nhập quản trị — để chọn tạo kênh
  app.get("/v1/meta-apps/:id/pages", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const a = await getMetaApp(db, req.authCtx, id);
    if (!a) return reply.code(404).send({ error: "Không có app này" });
    if (!a.userTokenEncrypted) return reply.code(409).send({ error: "Chưa đăng nhập Facebook cho app này" });
    try {
      const pages = await listUserPages(decryptSecret(a.userTokenEncrypted), decryptSecret(a.appSecretEncrypted));
      const channels = await listChannels(db, req.authCtx);
      const linked = (kind: string, pid: string) =>
        channels.find((c) => c.kind === kind && str((c.config as Obj)?.["pageId"]) === pid)?.id ?? null;
      return {
        pages: pages.map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          facebookChannelId: linked("facebook", p.id),
          instagram: p.instagram ? { ...p.instagram, channelId: linked("instagram", p.id) } : null,
        })),
      };
    } catch (err) {
      return reply.code(502).send({ error: `Facebook: ${(err as Error).message} — thử Đăng nhập Facebook lại.` });
    }
  });

  // Tạo (hoặc chuyển sang app riêng) kênh cho một Trang / Instagram của Trang đó
  app.post("/v1/meta-apps/:id/connect", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = ConnectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const b = parsed.data;
    const a = await getMetaApp(db, req.authCtx, id);
    if (!a?.userTokenEncrypted) return reply.code(409).send({ error: "Chưa đăng nhập Facebook cho app này" });
    const agent = await getAgentByKey(db, req.authCtx, b.agentKey);
    if (!agent) return reply.code(404).send({ error: `Agent "${b.agentKey}" không tồn tại` });
    const secret = decryptSecret(a.appSecretEncrypted);
    let page: MetaPageItem | undefined;
    try {
      page = (await listUserPages(decryptSecret(a.userTokenEncrypted), secret)).find((p) => p.id === b.pageId);
    } catch (err) {
      return reply.code(502).send({ error: `Facebook: ${(err as Error).message}` });
    }
    if (!page?.accessToken) return reply.code(404).send({ error: "Tài khoản Facebook đã đăng nhập không quản trị Trang này (hoặc chưa cấp quyền Trang khi đăng nhập)." });
    const kind: MetaChannelKind = b.platform;
    if (kind === "instagram" && !page.instagram) return reply.code(400).send({ error: "Trang này chưa liên kết tài khoản Instagram Business." });
    const config: Obj = {
      platform: kind,
      mode: "app",
      metaAppId: a.id,
      pageId: page.id,
      pageName: page.name,
      pageAvatar: page.avatar,
      igAccountId: page.instagram?.id ?? "",
      igUsername: page.instagram?.username ?? "",
      igName: page.instagram?.name ?? "",
      igAvatar: page.instagram?.avatar ?? "",
      hubUrl: "",
      registerEndpoint: "",
      refreshEndpoint: "",
    };
    const tokenEncrypted = encryptSecret(serializeMetaCredentials({ pageAccessToken: page.accessToken, penaiSecret: "", appSecret: secret }));
    const existing = (await listChannels(db, req.authCtx)).find((c) => c.kind === kind && str((c.config as Obj)?.["pageId"]) === page!.id);
    let row: ChannelRow;
    if (existing) {
      const updated = await updateChannel(db, req.authCtx, existing.id, {
        tokenEncrypted,
        agentId: agent.id,
        config: { ...((existing.config as Obj) ?? {}), ...config, ...(b.agentReply !== undefined ? { agent_reply: b.agentReply } : {}) },
        ...(b.name?.trim() ? { name: b.name.trim() } : {}),
        ...(b.requirePairing !== undefined ? { requirePairing: b.requirePairing } : {}),
      });
      if (!updated) return reply.code(404).send({ error: "Kênh không tồn tại" });
      row = updated;
    } else {
      row = await createChannel(db, req.authCtx, {
        kind,
        name: b.name?.trim() || (kind === "instagram" ? `@${page.instagram!.username || page.instagram!.name}` : page.name),
        agentId: agent.id,
        tokenEncrypted,
        requirePairing: b.requirePairing ?? false,
        config: { ...config, agent_reply: b.agentReply ?? true },
      });
    }
    const subErr = await subscribePage(page.id, page.accessToken, secret);
    const fresh = (await updateChannel(db, req.authCtx, row.id, {
      config: { ...((row.config as Obj) ?? {}), subscribeError: subErr, subscribedAt: subErr ? null : new Date().toISOString() },
    })) ?? row;
    const note = await applyChannelChange(row.id, fresh.enabled ? toEnabledChannel(fresh) : null);
    await recordAudit(db, req.authCtx, existing ? "channel.meta_app_reconnect" : "channel.meta_app_connect", { channelId: row.id, kind, pageId: page.id, appRowId: a.id });
    return reply.code(existing ? 200 : 201).send({
      channel: { id: row.id, kind, name: fresh.name },
      created: !existing,
      subscribed: !subErr,
      note,
      warnings: subErr ? [`Chưa đăng ký nhận tin cho Trang: ${subErr}`] : [],
    });
  });

  // Webhook THẲNG từ Meta (cần body gốc để kiểm chữ ký)
  void app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    // Meta kiểm địa chỉ: trả lại hub.challenge khi verify token khớp
    scoped.get("/webhooks/meta-app/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string | undefined>;
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send("not found");
      const a = await lookupMetaApp(db, id).catch(() => null);
      if (!a || q["hub.mode"] !== "subscribe" || q["hub.verify_token"] !== a.verifyToken) return reply.code(403).send("forbidden");
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    });
    scoped.post("/webhooks/meta-app/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: "not found" });
      const a = await lookupMetaApp(db, id).catch(() => null);
      if (!a) return reply.code(404).send({ error: "App không tồn tại" });
      const raw = typeof req.body === "string" ? req.body : "";
      const sig = req.headers["x-hub-signature-256"];
      if (!verifyMetaAppSignature(raw, Array.isArray(sig) ? sig[0] : sig, decryptSecret(a.appSecretEncrypted))) {
        logger.warn(`meta_app.webhook (${a.appId}): sai chữ ký`);
        return reply.code(401).send({ error: "Sai chữ ký" });
      }
      let payload: Obj;
      try {
        payload = obj(JSON.parse(raw));
      } catch {
        return reply.code(400).send({ error: "Body không phải JSON" });
      }
      const object = str(payload.object);
      let routed = 0;
      for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
        const entryId = str(obj(entry).id);
        for (const { channel } of channelHandlers.values()) {
          if (!(channel instanceof MetaPageChannel)) continue;
          const info = channel.pageInfo();
          if (info.mode !== "app" || info.metaAppId !== id) continue;
          const match = object === "instagram" ? channel.kind === "instagram" && info.igAccountId === entryId : channel.kind === "facebook" && info.pageId === entryId;
          if (match) routed += channel.ingest({ object, entry: [entry] });
        }
      }
      return reply.send({ ok: true, events: routed });
    });
  });
}

