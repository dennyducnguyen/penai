/**
 * Kênh Trang Meta (Facebook Fanpage, Instagram Business) nối qua hub (mặc định chat.hoiai.vn).
 *
 * - POST /v1/channels/meta/connect: nhận mã kết nối hfb_/hig_ (popup 1 chạm hoặc dán tay)
 *   → tạo/cập nhật kênh → đăng ký địa chỉ nhận tin của kênh trên hub.
 * - POST /webhooks/meta/:channelId: hub chuyển tin của Meta tới, kèm chữ ký HMAC trên body gốc.
 * - Mỗi Trang/tài khoản Instagram = 1 kênh, gắn agent riêng.
 *
 * Tài liệu: docs/facebook-instagram.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, hasRole, logger, type WorkspaceContext } from "@penai/shared";
import {
  createChannel,
  deleteChannel,
  getAgentByKey,
  getChannelById,
  listChannels,
  recordAudit,
  updateChannel,
  type ChannelRow,
  type Db,
} from "@penai/db";
import {
  DEFAULT_META_HUB_URL,
  MetaConnectCodeError,
  MetaPageChannel,
  isMetaChannelKind,
  parseHoiaiConnectCode,
  parseExchangeCode,
  exchangeHubCode,
  parseMetaCredentials,
  readMetaConfig,
  registerHubWebhook,
  sameOrigin,
  serializeMetaCredentials,
  type HoiaiConnectPayload,
  type MetaChannelKind,
} from "@penai/channels";
import { applyChannelChange, channelHandlers } from "./channels-runtime.js";
import { resubscribeAppChannel } from "./meta-apps.js";

/** Hub giữ Meta App — đổi bằng PENAI_META_HUB_URL (bản fork tự dựng hub riêng). */
export function metaHubUrl(): string {
  return (process.env.PENAI_META_HUB_URL || DEFAULT_META_HUB_URL).trim().replace(/\/+$/, "");
}

function publicBase(): string {
  return (process.env.PENAI_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
}

export function metaWebhookUrl(channelId: string): string {
  return `${publicBase()}/webhooks/meta/${channelId}`;
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

/** Thông tin Trang từ mã kết nối → config kênh (không chứa bí mật). */
function configFromCode(p: HoiaiConnectPayload): Record<string, unknown> {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    platform: p.platform,
    mode: "hub",
    metaAppId: "",
    pageId: p.page_id,
    pageName: p.page_name,
    pageAvatar: s(p.avatar_url),
    igAccountId: s(p.ig_account_id),
    igUsername: s(p.ig_username),
    igName: s(p.ig_name),
    igAvatar: s(p.ig_avatar_url),
    hubUrl: metaHubUrl(),
    registerEndpoint: p.register_webhook_endpoint,
    refreshEndpoint: p.refresh_token_endpoint,
  };
}

function defaultName(p: HoiaiConnectPayload): string {
  if (p.platform === "instagram") return p.ig_username ? `@${p.ig_username}` : p.ig_name || p.page_name || "Instagram";
  return p.page_name || "Fanpage";
}

interface RegisterOutcome {
  ok: boolean;
  rejected: boolean;
  message: string;
  /** Trang đang gửi tin về địa chỉ khác (bản PenAI khác) trước khi chuyển về đây */
  previousUrl?: string;
}

/**
 * Đăng ký Trang gửi sự kiện (tin nhắn, tin dội lại, bấm nút; thêm bình luận nếu token có quyền) cho app
 * đã cấp token — với kênh qua hub là app của hub. Hub có thể quên bước này → Meta không gửi gì.
 * Thử kèm "feed" trước, thiếu quyền thì đăng ký phần tin nhắn.
 */
async function subscribePageForToken(pageId: string, pageToken: string): Promise<string | null> {
  let lastErr = "";
  for (const fields of ["messages,messaging_postbacks,message_echoes,feed", "messages,messaging_postbacks,message_echoes"]) {
    try {
      const url = new URL(`https://graph.facebook.com/v22.0/${pageId}/subscribed_apps`);
      url.searchParams.set("access_token", pageToken);
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ subscribed_fields: fields }), signal: AbortSignal.timeout(15_000) });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
      if (res.ok && j.success) return null;
      lastErr = j.error?.message ?? `HTTP ${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  return lastErr || "không đăng ký được";
}

/** Trạng thái Trang phía hub (đang bật? địa chỉ đang trỏ về) — qua API làm mới token của hub. */
async function hubPageStatus(row: ChannelRow): Promise<{ isActive: boolean | null; webhookUrl: string | null; error?: string } | null> {
  const cfg = readMetaConfig(row.kind as MetaChannelKind, (row.config as Record<string, unknown>) ?? {});
  if (!cfg.refreshEndpoint || !sameOrigin(cfg.refreshEndpoint, metaHubUrl())) return null;
  const creds = parseMetaCredentials(row.tokenEncrypted ? decryptSecret(row.tokenEncrypted) : "");
  try {
    const res = await fetch(cfg.refreshEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-penai-secret": creds.penaiSecret },
      body: JSON.stringify({ page_id: cfg.pageId, ...(cfg.igAccountId ? { ig_account_id: cfg.igAccountId } : {}), penai_secret: creds.penaiSecret }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: Record<string, unknown> };
    if (!res.ok || j.success === false) return { isActive: null, webhookUrl: null, error: j.message || `HTTP ${res.status}` };
    const d = j.data ?? {};
    const url = row.kind === "instagram" ? d["penai_ig_webhook_url"] : d["penai_webhook_url"];
    return { isActive: typeof d["is_active"] === "boolean" ? (d["is_active"] as boolean) : d["is_active"] == null ? null : !!d["is_active"], webhookUrl: typeof url === "string" ? url : null };
  } catch (err) {
    return { isActive: null, webhookUrl: null, error: (err as Error).message };
  }
}

/** Đăng ký địa chỉ nhận tin của kênh trên hub, ghi kết quả vào config kênh. */
export async function registerMetaWebhook(db: Db, ctx: WorkspaceContext, row: ChannelRow): Promise<RegisterOutcome> {
  const kind = row.kind as MetaChannelKind;
  const cfg = readMetaConfig(kind, (row.config as Record<string, unknown>) ?? {});
  const creds = parseMetaCredentials(row.tokenEncrypted ? decryptSecret(row.tokenEncrypted) : "");
  if (!publicBase()) {
    return { ok: false, rejected: true, message: "Máy chủ thiếu PENAI_PUBLIC_URL trong penai.env — hub không biết gửi tin về đâu." };
  }
  if (!cfg.registerEndpoint || !sameOrigin(cfg.registerEndpoint, metaHubUrl())) {
    return { ok: false, rejected: true, message: "Địa chỉ đăng ký của hub không hợp lệ — kết nối lại bằng mã mới." };
  }
  const webhookUrl = metaWebhookUrl(row.id);
  const res = await registerHubWebhook(cfg.registerEndpoint, {
    pageId: cfg.pageId,
    ...(kind === "instagram" && cfg.igAccountId ? { igAccountId: cfg.igAccountId } : {}),
    penaiSecret: creds.penaiSecret,
    platform: kind,
    webhookUrl,
  });
  const previous = typeof res.data.previous_webhook_url === "string" ? res.data.previous_webhook_url : "";
  // Bảo đảm Trang gửi sự kiện cho app của hub (không thì Meta không gửi gì tới hub)
  const subscribeError = res.ok && creds.pageAccessToken ? await subscribePageForToken(cfg.pageId, creds.pageAccessToken) : null;
  if (subscribeError) logger.warn(`meta.subscribe_page (${row.name}): ${subscribeError}`);
  const config = {
    ...((row.config as Record<string, unknown>) ?? {}),
    webhookUrl: res.ok ? webhookUrl : ((row.config as Record<string, unknown>)?.["webhookUrl"] ?? ""),
    webhookRegisteredAt: res.ok ? new Date().toISOString() : ((row.config as Record<string, unknown>)?.["webhookRegisteredAt"] ?? null),
    webhookError: res.ok ? null : res.message,
    subscribeError,
    // Hub hỗ trợ gỡ có điều kiện (expected_webhook_url) → xóa kênh thì gỡ đăng ký an toàn
    hubConditionalUnregister: res.ok ? res.data.supports_expected_webhook_url === true : ((row.config as Record<string, unknown>)?.["hubConditionalUnregister"] ?? false),
  };
  await updateChannel(db, ctx, row.id, { config });
  if (!res.ok) logger.warn(`meta.register_webhook (${row.name}): ${res.status} ${res.message}`);
  return {
    ok: res.ok,
    rejected: res.rejected,
    message: res.message,
    ...(previous && previous !== webhookUrl ? { previousUrl: previous } : {}),
  };
}

/**
 * Xóa kênh → báo hub thôi gửi tin. Chỉ làm khi hub hỗ trợ gỡ có điều kiện
 * (chỉ gỡ nếu hub vẫn đang trỏ đúng về kênh này) — tránh cắt mất Trang đã chuyển sang bản PenAI khác.
 */
export async function unregisterMetaWebhook(row: ChannelRow): Promise<void> {
  if (!isMetaChannelKind(row.kind)) return;
  const raw = (row.config as Record<string, unknown>) ?? {};
  if (raw["hubConditionalUnregister"] !== true) return;
  const cfg = readMetaConfig(row.kind, raw);
  if (!cfg.registerEndpoint || !sameOrigin(cfg.registerEndpoint, metaHubUrl())) return;
  const creds = parseMetaCredentials(row.tokenEncrypted ? decryptSecret(row.tokenEncrypted) : "");
  const res = await registerHubWebhook(cfg.registerEndpoint, {
    pageId: cfg.pageId,
    ...(row.kind === "instagram" && cfg.igAccountId ? { igAccountId: cfg.igAccountId } : {}),
    penaiSecret: creds.penaiSecret,
    platform: row.kind,
    webhookUrl: "",
    expectedWebhookUrl: metaWebhookUrl(row.id),
  });
  if (!res.ok) logger.warn(`meta.unregister_webhook (${row.name}): ${res.status} ${res.message}`);
}

const ConnectBody = z.object({
  code: z.string().min(10).max(20_000),
  agentKey: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  requirePairing: z.boolean().optional(),
  agentReply: z.boolean().optional(),
  /** Kết nối lại đúng kênh này (thay token/secret) */
  channelId: z.string().uuid().optional(),
});

export function registerMetaRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  function admin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!hasRole(req.authCtx.role, "ws_admin")) {
      void reply.code(403).send({ error: "Cần quyền quản trị workspace" });
      return false;
    }
    return true;
  }

  // Hub + điều kiện để kết nối (Dashboard dùng mở popup)
  app.get("/v1/channels/meta/hub", async () => {
    const hub = metaHubUrl();
    return {
      hubUrl: hub,
      connectUrl: `${hub}/facebook/penai-connect`,
      manageUrl: `${hub}/facebook`,
      publicUrl: publicBase() || null,
      ready: !!publicBase(),
    };
  });

  app.post("/v1/channels/meta/connect", async (req, reply) => {
    if (!admin(req, reply)) return;
    const parsed = ConnectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const b = parsed.data;
    const hub = metaHubUrl();
    let p: HoiaiConnectPayload;
    try {
      // hfbx_/higx_: mã dùng một lần (hub bản 2) → đổi lấy thông tin qua API; hfb_/hig_: thông tin nằm trong mã
      p = parseExchangeCode(b.code) ? await exchangeHubCode(hub, b.code) : parseHoiaiConnectCode(b.code);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!sameOrigin(p.register_webhook_endpoint, hub) || !sameOrigin(p.refresh_token_endpoint, hub)) {
      return reply.code(400).send({ error: `Mã kết nối không do hub ${hub} cấp. Lấy mã tại ${hub}/facebook (hoặc đổi PENAI_META_HUB_URL nếu dùng hub riêng).` });
    }
    if (!publicBase()) {
      return reply.code(400).send({ error: "Máy chủ thiếu PENAI_PUBLIC_URL trong penai.env — hub không biết gửi tin về đâu. Thêm biến này rồi sudo penai restart." });
    }
    const kind = p.platform;
    const creds = encryptSecret(serializeMetaCredentials({ pageAccessToken: p.page_access_token, penaiSecret: p.penai_secret }));
    const all = await listChannels(db, req.authCtx);
    let existing: ChannelRow | undefined;
    if (b.channelId) {
      existing = all.find((c) => c.id === b.channelId);
      if (!existing) return reply.code(404).send({ error: "Kênh không tồn tại" });
      if (existing.kind !== kind) return reply.code(400).send({ error: `Mã này dành cho ${kind === "instagram" ? "Instagram" : "Facebook"}, kênh đang sửa là ${existing.kind}.` });
    } else {
      existing = all.find((c) => {
        if (c.kind !== kind) return false;
        const cfg = (c.config as Record<string, unknown>) ?? {};
        return kind === "instagram" ? cfg["igAccountId"] === p.ig_account_id : cfg["pageId"] === p.page_id;
      });
    }
    if (existing) {
      const cfg = (existing.config as Record<string, unknown>) ?? {};
      if (String(cfg["pageId"] ?? "") && String(cfg["pageId"]) !== p.page_id) {
        return reply.code(400).send({ error: "Mã này của Trang khác — tạo kênh mới thay vì kết nối lại kênh này." });
      }
    }

    let agentId: string | undefined;
    if (b.agentKey) {
      const agent = await getAgentByKey(db, req.authCtx, b.agentKey);
      if (!agent) return reply.code(404).send({ error: `Agent "${b.agentKey}" không tồn tại` });
      agentId = agent.id;
    } else if (!existing) {
      return reply.code(400).send({ error: "Chọn agent trả lời cho Trang này" });
    }

    const created = !existing;
    let row: ChannelRow;
    if (existing) {
      const updated = await updateChannel(db, req.authCtx, existing.id, {
        tokenEncrypted: creds,
        config: { ...((existing.config as Record<string, unknown>) ?? {}), ...configFromCode(p), ...(b.agentReply !== undefined ? { agent_reply: b.agentReply } : {}) },
        ...(agentId ? { agentId } : {}),
        ...(b.name?.trim() ? { name: b.name.trim() } : {}),
        ...(b.requirePairing !== undefined ? { requirePairing: b.requirePairing } : {}),
      });
      if (!updated) return reply.code(404).send({ error: "Kênh không tồn tại" });
      row = updated;
    } else {
      row = await createChannel(db, req.authCtx, {
        kind,
        name: b.name?.trim() || defaultName(p),
        agentId: agentId!,
        tokenEncrypted: creds,
        // Fanpage là kênh khách lạ nhắn tới → mặc định không bắt duyệt mã pairing
        requirePairing: b.requirePairing ?? false,
        config: { ...configFromCode(p), agent_reply: b.agentReply ?? true },
      });
    }

    const reg = await registerMetaWebhook(db, req.authCtx, row);
    if (!reg.ok && reg.rejected && created) {
      await deleteChannel(db, req.authCtx, row.id).catch(() => false);
      return reply.code(400).send({ error: `Hub từ chối đăng ký: ${reg.message}` });
    }
    const fresh = (await getChannelById(db, req.authCtx, row.id)) ?? row;
    const note = await applyChannelChange(row.id, fresh.enabled ? toEnabledChannel(fresh) : null);
    await recordAudit(db, req.authCtx, created ? "channel.meta_connect" : "channel.meta_reconnect", {
      channelId: row.id,
      kind,
      pageId: p.page_id,
      ...(p.ig_account_id ? { igAccountId: p.ig_account_id } : {}),
      registered: reg.ok,
    });
    const warnings: string[] = [];
    if (!reg.ok) warnings.push(`Chưa đăng ký được với hub (${reg.message}) — vào Channels → Kết nối Trang → Đăng ký lại.`);
    if (reg.previousUrl) warnings.push(`Trang này trước đó gửi tin về ${reg.previousUrl} — từ giờ chuyển về đây.`);
    return reply.code(created ? 201 : 200).send({
      channel: { id: row.id, kind: row.kind, name: fresh.name },
      created,
      registered: reg.ok,
      note,
      warnings,
    });
  });

  app.get("/v1/channels/:id/meta", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getChannelById(db, req.authCtx, id);
    if (!row || !isMetaChannelKind(row.kind)) return reply.code(404).send({ error: "Không có kênh Facebook/Instagram này" });
    const rt = channelHandlers.get(id)?.channel;
    const cfg = (row.config as Record<string, unknown>) ?? {};
    if (cfg["mode"] === "app") {
      return {
        kind: row.kind,
        mode: "app",
        metaAppId: cfg["metaAppId"] ?? "",
        page: { id: cfg["pageId"] ?? "", name: cfg["pageName"] ?? "", avatar: cfg["pageAvatar"] ?? "", igAccountId: cfg["igAccountId"] ?? "", igUsername: cfg["igUsername"] ?? "" },
        registeredAt: cfg["subscribedAt"] ?? null,
        registerError: cfg["subscribeError"] ?? null,
        status: rt instanceof MetaPageChannel ? rt.status() : { running: false, connected: false, error: null, authError: null, lastWebhookAt: null, account: null },
      };
    }
    return {
      kind: row.kind,
      mode: "hub",
      page: {
        id: cfg["pageId"] ?? "",
        name: cfg["pageName"] ?? "",
        avatar: cfg["pageAvatar"] ?? "",
        igAccountId: cfg["igAccountId"] ?? "",
        igUsername: cfg["igUsername"] ?? "",
      },
      hubUrl: metaHubUrl(),
      webhookUrl: metaWebhookUrl(row.id),
      registeredUrl: cfg["webhookUrl"] ?? "",
      registeredAt: cfg["webhookRegisteredAt"] ?? null,
      registerError: cfg["webhookError"] ?? null,
      subscribeError: cfg["subscribeError"] ?? null,
      hub: await hubPageStatus(row),
      status: rt instanceof MetaPageChannel ? rt.status() : { running: false, connected: false, error: null, authError: null, lastWebhookAt: null, account: null },
    };
  });

  app.post("/v1/channels/:id/meta/register", async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = await getChannelById(db, req.authCtx, id);
    if (!row || !isMetaChannelKind(row.kind)) return reply.code(404).send({ error: "Không có kênh Facebook/Instagram này" });
    if ((row.config as Record<string, unknown>)?.["mode"] === "app") {
      const r = await resubscribeAppChannel(db, req.authCtx, row);
      await recordAudit(db, req.authCtx, "channel.meta_register", { channelId: id, ok: r.ok, mode: "app" });
      if (!r.ok) return reply.code(502).send({ error: r.message });
      return { registered: true };
    }
    const reg = await registerMetaWebhook(db, req.authCtx, row);
    await recordAudit(db, req.authCtx, "channel.meta_register", { channelId: id, ok: reg.ok });
    if (!reg.ok) return reply.code(reg.rejected ? 400 : 502).send({ error: reg.message });
    return { registered: true, ...(reg.previousUrl ? { warning: `Trang này trước đó gửi tin về ${reg.previousUrl} — từ giờ chuyển về đây.` } : {}) };
  });

  // Webhook từ hub: cần body GỐC để kiểm chữ ký → bộ đọc body riêng cho route này
  void app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scoped.addContentTypeParser("*", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scoped.post("/webhooks/meta/:channelId", async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const rt = channelHandlers.get(channelId)?.channel;
      if (!(rt instanceof MetaPageChannel)) return reply.code(404).send({ error: "Kênh không tồn tại hoặc đang tắt" });
      const h = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      const res = rt.handleWebhook(raw, {
        signature: h("x-penai-signature"),
        signatureV2: h("x-hoiai-signature"),
        timestamp: h("x-hoiai-timestamp"),
      });
      if (res.status !== 200) {
        logger.warn(`meta.webhook (${rt.name}): từ chối ${res.status} ${res.error ?? ""}`);
        return reply.code(res.status).send({ error: res.error });
      }
      return reply.send({ ok: true, events: res.events ?? 0 });
    });
  });
}
