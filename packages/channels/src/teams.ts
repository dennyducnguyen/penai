import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { logger } from "@penai/shared";
import type {
  Channel,
  ChannelCallback,
  ChannelDeps,
  InboundMedia,
  InboundMessage,
  OutboundButton,
  OutboundMessage,
} from "./types.js";

/**
 * Adapter Microsoft Teams qua Azure Bot (Bot Framework REST, không SDK).
 * - token (channels.token_encrypted) = client secret của App Registration.
 * - config: { appId, tenantId } — tenantId rỗng = bot Multi Tenant.
 * - Inbound: Teams POST Activity vào /webhooks/teams (server verify JWT rồi
 *   gọi noteActivity + onInbound). Webhook-driven → start/stop no-op.
 * - Outbound: POST {serviceUrl}/v3/conversations/{id}/activities với Bearer
 *   token client_credentials (scope api.botframework.com/.default).
 * - serviceUrl theo region, đến kèm mỗi activity → nhớ theo chatKey (in-memory,
 *   ấm lại ngay ở inbound kế tiếp sau restart) + serviceUrl cuối làm fallback.
 */

interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string; // "msteams"
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; name?: string };
  entities?: Array<{ type?: string; mentioned?: { id?: string; name?: string } }>;
  attachments?: Array<{
    contentType?: string;
    name?: string;
    contentUrl?: string;
    content?: { downloadUrl?: string; fileType?: string };
  }>;
  /** Payload của Action.Submit khi người dùng bấm nút Adaptive Card. */
  value?: Record<string, unknown>;
  replyToId?: string;
}

/** Attachment nào đáng tải về (ảnh hoặc file đính kèm Teams). */
function isMediaAttachment(a: NonNullable<TeamsActivity["attachments"]>[number]): boolean {
  const ct = a.contentType ?? "";
  return (
    (ct.startsWith("image/") && !!a.contentUrl) ||
    (ct === "application/vnd.microsoft.teams.file.download.info" && !!a.content?.downloadUrl)
  );
}

const BOTFRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TOKEN_SCOPE = "https://api.botframework.com/.default";

export class TeamsChannel implements Channel {
  readonly kind = "msteams";
  readonly id: string;
  readonly name: string;
  readonly appId: string;
  readonly tenantId: string;
  private secret: string;
  private accessToken = "";
  private accessTokenExp = 0;
  /** chatKey (conversation.id) → serviceUrl của region tương ứng. */
  private serviceUrls = new Map<string, string>();
  /**
   * senderId ("29:...") → conversation.id chat 1-1 ("a:..."). Cần cho luồng gửi
   * theo NGƯỜI DÙNG (vd tin chào mừng sau duyệt pairing dùng external_user_id):
   * Telegram chatKey == senderId nhưng Teams thì khác hẳn.
   */
  private personalChats = new Map<string, string>();
  private lastServiceUrl = "";

  constructor(deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.secret = deps.token;
    this.appId = String(deps.config.appId ?? "").trim();
    this.tenantId = String(deps.config.tenantId ?? "").trim();
  }

  async start(): Promise<void> {
    if (!this.appId) throw new Error("Teams cần config.appId (Microsoft App ID)");
    if (!this.secret) throw new Error("Teams cần client secret (ô token)");
  }
  async stop(): Promise<void> {
    // webhook-driven
  }
  isRunning(): boolean {
    return true;
  }

  /** Server gọi với MỖI activity inbound (trước onInbound) để nhớ serviceUrl. */
  noteActivity(activity: TeamsActivity): void {
    const convId = activity.conversation?.id;
    if (convId && activity.serviceUrl) {
      this.serviceUrls.set(convId, activity.serviceUrl);
      this.lastServiceUrl = activity.serviceUrl;
    }
    const senderId = activity.from?.id;
    const personal = (activity.conversation?.conversationType ?? "personal") === "personal";
    if (personal && convId && senderId) this.personalChats.set(senderId, convId);
  }

  /**
   * Đổi "đích gửi" thành conversation.id thật: nhận nguyên conversation id,
   * hoặc senderId (map từ inbound), hoặc tạo conversation 1-1 chủ động qua
   * Bot Connector (proactive) khi map đã mất sau restart.
   */
  private async resolveConversation(target: string): Promise<string> {
    if (this.serviceUrls.has(target)) return target;
    const mapped = this.personalChats.get(target);
    if (mapped) return mapped;
    const serviceUrl = this.lastServiceUrl.replace(/\/$/, "");
    if (!serviceUrl || !target.startsWith("29:")) return target;
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`${serviceUrl}/v3/conversations`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          bot: { id: `28:${this.appId}` },
          members: [{ id: target }],
          isGroup: false,
          ...(this.tenantId
            ? { tenantId: this.tenantId, channelData: { tenant: { id: this.tenantId } } }
            : {}),
        }),
      });
      if (!res.ok) return target;
      const data = (await res.json()) as { id?: string };
      if (data.id) {
        this.personalChats.set(target, data.id);
        this.serviceUrls.set(data.id, serviceUrl);
        return data.id;
      }
    } catch {
      /* rơi về target — postActivity sẽ báo lỗi rõ ràng */
    }
    return target;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExp - 60_000) return this.accessToken;
    // Bot Single Tenant lấy token từ tenant của mình; Multi Tenant dùng tenant chung
    const tenant = this.tenantId || "botframework.com";
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.appId,
        client_secret: this.secret,
        scope: TOKEN_SCOPE,
      }),
    });
    if (!res.ok) {
      throw new Error(`Teams token lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Teams token: phản hồi thiếu access_token");
    this.accessToken = data.access_token;
    this.accessTokenExp = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  /** POST một activity vào hội thoại; trả về id activity (dùng làm streamId). */
  async postActivity(chatKey: string, activity: Record<string, unknown>): Promise<string | null> {
    // Debug outbound: soi mọi activity gửi đi (truy nguồn bubble "(không có nội dung)")
    logger.info(
      `Teams OUT type=${String(activity.type)} text=${JSON.stringify(String(activity.text ?? "").slice(0, 60))} att=${Array.isArray(activity.attachments) ? activity.attachments.length : 0} cd=${activity.channelData ? "y" : "n"}`,
    );
    const serviceUrl = (this.serviceUrls.get(chatKey) ?? this.lastServiceUrl).replace(/\/$/, "");
    if (!serviceUrl) {
      throw new Error(
        "Teams chưa biết serviceUrl của hội thoại này (chưa có tin inbound nào sau khi khởi động)",
      );
    }
    const token = await this.getAccessToken();
    const res = await fetch(
      `${serviceUrl}/v3/conversations/${encodeURIComponent(chatKey)}/activities`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(activity),
      },
    );
    if (!res.ok) {
      throw new Error(`Teams post lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return data.id ?? null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Agent trả lời trọn qua thẻ/tool → text rỗng; gửi đi Teams sẽ render
    // bubble "(không có nội dung)" — bỏ qua.
    if (!msg.text.trim()) return;
    const conv = await this.resolveConversation(msg.chatKey);
    await this.postActivity(conv, {
      type: "message",
      textFormat: "markdown",
      text: msg.text.slice(0, 25_000),
    });
  }

  /** Chấm "đang soạn..." — dùng được cả group (fire-and-forget ở caller). */
  async postTyping(chatKey: string): Promise<void> {
    await this.postActivity(chatKey, { type: "typing" });
  }

  /**
   * Tải media đính kèm của activity về dạng InboundMedia:
   * - ảnh (contentUrl trên Bot Connector — cần Bearer token của bot);
   * - file chat 1-1 (file.download.info — downloadUrl SharePoint đã ký sẵn).
   * Lỗi/quá 10MB → media kèm note để LLM biết mà báo người dùng.
   */
  async extractMedia(activity: TeamsActivity): Promise<InboundMedia[]> {
    const out: InboundMedia[] = [];
    for (const a of activity.attachments ?? []) {
      if (!isMediaAttachment(a)) continue;
      const isImage = (a.contentType ?? "").startsWith("image/");
      const name =
        a.name ?? (isImage ? `anh-teams.${(a.contentType ?? "image/png").split("/")[1]}` : "file-teams");
      try {
        const url = isImage ? a.contentUrl! : a.content!.downloadUrl!;
        const headers: Record<string, string> = {};
        if (isImage) headers.authorization = `Bearer ${await this.getAccessToken()}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 10 * 1024 * 1024) {
          out.push({ kind: "document", name, note: `File "${name}" vượt 10MB — chưa hỗ trợ tải về` });
          continue;
        }
        if (isImage) {
          out.push({
            kind: "photo",
            name,
            dataUrl: `data:${a.contentType};base64,${buf.toString("base64")}`,
          });
        } else {
          out.push({ kind: "document", name, dataB64: buf.toString("base64") });
        }
      } catch (err) {
        logger.warn(`Teams tải attachment "${name}" lỗi: ${(err as Error).message}`);
        out.push({ kind: "document", name, note: `Không tải được file "${name}" từ Teams` });
      }
    }
    return out;
  }

  /**
   * Gửi file/ảnh RA cho người dùng. Teams không cho bot đính file trực tiếp
   * (cần OneDrive consent) → dùng link công khai có hạn của PenAI (publish_file):
   * ảnh gửi dạng attachment contentUrl (hiển thị inline), file khác gửi link tải.
   */
  async sendMedia(
    chatKey: string,
    items: Array<{ name: string; url: string; contentType: string }>,
  ): Promise<void> {
    if (!items.length) return;
    const conv = await this.resolveConversation(chatKey);
    const images = items.filter((i) => i.contentType.startsWith("image/"));
    const files = items.filter((i) => !i.contentType.startsWith("image/"));
    for (const img of images) {
      await this.postActivity(conv, {
        type: "message",
        attachments: [{ contentType: img.contentType, contentUrl: img.url, name: img.name }],
      });
    }
    if (files.length) {
      await this.postActivity(conv, {
        type: "message",
        textFormat: "markdown",
        text:
          "📎 **File đính kèm** (link tải, hết hạn sau 7 ngày):\n" +
          files.map((f) => `- [${f.name}](${f.url})`).join("\n"),
      });
    }
  }

  /** Dựng attachment Adaptive Card từ text + hàng nút. */
  private static adaptiveCard(text: string, buttons: OutboundButton[][]) {
    return {
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [{ type: "TextBlock", text, wrap: true }],
        actions: buttons.flat().map((b) => ({
          type: "Action.Submit",
          title: b.text,
          data: { penaiData: b.data },
        })),
      },
    };
  }

  /** Gửi thẻ có nút bấm (Adaptive Card). Trả activity id để sửa thẻ sau. */
  async sendCard(
    chatKey: string,
    text: string,
    buttons: OutboundButton[][],
  ): Promise<string | null> {
    const conv = await this.resolveConversation(chatKey);
    return this.postActivity(conv, {
      type: "message",
      attachments: [TeamsChannel.adaptiveCard(text, buttons)],
    });
  }

  /** Sửa thẻ đã gửi (PUT activity) — bỏ nút để chống bấm trùng. */
  async updateCard(chatKey: string, activityId: string, text: string): Promise<void> {
    const conv = await this.resolveConversation(chatKey);
    const serviceUrl = (this.serviceUrls.get(conv) ?? this.lastServiceUrl).replace(/\/$/, "");
    if (!serviceUrl) throw new Error("Teams chưa biết serviceUrl để sửa thẻ");
    const token = await this.getAccessToken();
    const res = await fetch(
      `${serviceUrl}/v3/conversations/${encodeURIComponent(conv)}/activities/${encodeURIComponent(activityId)}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "message",
          id: activityId,
          attachments: [TeamsChannel.adaptiveCard(text, [])],
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Teams sửa thẻ lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  /** Phiên stream tin nhắn (giao thức streaming chính thức của Teams — chat 1-1). */
  createStream(chatKey: string): TeamsStream {
    return new TeamsStream(this, chatKey);
  }
}

/** Người dùng bấm nút Adaptive Card → ChannelCallback (giống callback_query Telegram). */
export function parseTeamsCardAction(
  channelId: string,
  activity: TeamsActivity,
): ChannelCallback | null {
  if (activity.type !== "message") return null;
  const data = activity.value?.["penaiData"];
  const convId = activity.conversation?.id;
  const senderId = activity.from?.id;
  if (typeof data !== "string" || !data || !convId || !senderId) return null;
  return {
    channelId,
    channelKind: "msteams",
    chatKey: convId,
    senderId,
    ...(activity.from?.name ? { senderName: activity.from.name } : {}),
    data,
    messageId: activity.replyToId ?? "",
  };
}

/**
 * Streaming bot message của Teams: các update `type:"typing"` mang text lũy tiến
 * + entity streaminfo (streamType "streaming", streamSequence tăng dần, streamId
 * từ update đầu), chốt bằng `type:"message"` streamType "final". Teams giới hạn
 * ~1 update/giây → gộp delta theo nhịp 1,2s. Chỉ hỗ trợ chat cá nhân; mọi lỗi
 * (group, tenant tắt tính năng...) → stream "chết" và caller gửi tin thường.
 */
export class TeamsStream {
  private buffer = "";
  private lastSent = "";
  private seq = 0;
  private streamId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private dead = false;

  constructor(
    private ch: TeamsChannel,
    private chatKey: string,
  ) {}

  push(delta: string): void {
    if (this.dead || !delta) return;
    this.buffer += delta;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1200);
      this.timer.unref?.();
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.dead || this.inflight) return;
    const text = this.buffer;
    if (!text || text === this.lastSent) return;
    this.inflight = true;
    try {
      this.seq += 1;
      // Teams nhận stream metadata qua channelData (REST docs) HOẶC entity
      // streaminfo (Teams AI SDK) — gửi cả hai cho chắc mọi phiên bản client.
      const meta: Record<string, unknown> = {
        streamType: "streaming",
        streamSequence: this.seq,
        ...(this.streamId ? { streamId: this.streamId } : {}),
      };
      const id = await this.ch.postActivity(this.chatKey, {
        type: "typing",
        text: text.slice(0, 25_000),
        channelData: meta,
        entities: [{ type: "streaminfo", ...meta }],
      });
      if (!this.streamId && id) this.streamId = id;
      this.lastSent = text;
    } catch (err) {
      logger.warn(`Teams stream update lỗi (seq ${this.seq}) — chuyển gửi thường: ${(err as Error).message}`);
      this.dead = true; // fallback: caller gửi tin thường ở finish()
    } finally {
      this.inflight = false;
    }
  }

  /** Chốt stream bằng bản final. Trả false nếu stream chưa mở/đã chết → caller tự send. */
  async finish(finalText: string): Promise<boolean> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (let i = 0; i < 30 && this.inflight; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.dead || !this.streamId) return false;
    try {
      // Teams BẮT BUỘC bản final chứa trọn nội dung đã stream (403
      // ContentStreamNotAllowed nếu thiếu). Khi run có tool xen giữa,
      // finalText của loop chỉ là ĐOẠN CUỐI còn buffer chứa cả câu dẫn
      // trước tool → lấy buffer làm nền, nối thêm finalText nếu chưa nằm trong.
      const trimmedFinal = finalText.trim();
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      let text: string;
      if (trimmedFinal.includes(this.buffer.trim())) {
        text = trimmedFinal; // final đã bao trọn phần stream (run không có tool)
      } else if (norm(this.buffer).includes(norm(trimmedFinal))) {
        text = this.buffer; // phần stream đã chứa final
      } else {
        text = `${this.buffer}\n\n${trimmedFinal}`;
      }
      const meta = { streamType: "final", streamId: this.streamId };
      await this.ch.postActivity(this.chatKey, {
        type: "message",
        textFormat: "markdown",
        text: text.slice(0, 25_000),
        channelData: meta,
        entities: [{ type: "streaminfo", ...meta }],
      });
      logger.info(`Teams stream OK: ${this.seq} update, streamId ${this.streamId}`);
      return true;
    } catch (err) {
      logger.warn(`Teams stream final lỗi — chuyển gửi thường: ${(err as Error).message}`);
      return false;
    }
  }

  abort(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.dead = true;
  }
}

/** Parse Activity Teams → InboundMessage (message có text HOẶC media đính kèm). */
export function parseTeamsActivity(channelId: string, activity: TeamsActivity): InboundMessage | null {
  if (activity.type !== "message") return null;
  const convId = activity.conversation?.id;
  const senderId = activity.from?.id;
  // Bỏ tag mention <at>Tên bot</at> khỏi text
  const text = (activity.text ?? "").replace(/<at>[^<]*<\/at>/g, "").trim();
  if (!convId || !senderId) return null;
  const personal = (activity.conversation?.conversationType ?? "personal") === "personal";
  const botId = activity.recipient?.id ?? "";
  const mentioned =
    personal ||
    (activity.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === botId);
  // Tin chỉ gửi ảnh/file (không text) vẫn phải nhận — runtime lưu file + ack
  if (!text && !(activity.attachments ?? []).some(isMediaAttachment)) return null;
  return {
    channelId,
    channelKind: "msteams",
    chatKey: convId,
    senderId,
    ...(activity.from?.name ? { senderName: activity.from.name } : {}),
    text,
    peerKind: personal ? "direct" : "group",
    mentioned,
  };
}

// ===== Verify JWT inbound (endpoint public — bắt buộc xác thực) =====

interface JwksCache {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}
let jwksCache: JwksCache | null = null;

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseJwtPart<T>(part: string): T | null {
  try {
    return JSON.parse(b64urlToBuffer(part).toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function fetchJwks(tenantId: string): Promise<Map<string, JsonWebKey>> {
  const keys = new Map<string, JsonWebKey>();
  const sources = [BOTFRAMEWORK_OPENID];
  // Bot Single Tenant: token do AAD tenant phát — thêm bộ key của tenant
  if (tenantId) {
    sources.push(
      `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
    );
  }
  for (const src of sources) {
    try {
      const conf = (await (await fetch(src)).json()) as { jwks_uri?: string };
      if (!conf.jwks_uri) continue;
      const jwks = (await (await fetch(conf.jwks_uri)).json()) as {
        keys?: Array<JsonWebKey & { kid?: string }>;
      };
      for (const k of jwks.keys ?? []) {
        if (k.kid) keys.set(k.kid, k);
      }
    } catch {
      // nguồn lỗi thì bỏ qua — nguồn còn lại vẫn dùng được
    }
  }
  return keys;
}

async function getJwk(kid: string, tenantId: string): Promise<JsonWebKey | null> {
  let cache = jwksCache;
  const fresh = cache && Date.now() - cache.fetchedAt < 24 * 3600_000;
  if (!cache || !fresh || !cache.keys.has(kid)) {
    cache = { keys: await fetchJwks(tenantId), fetchedAt: Date.now() };
    jwksCache = cache;
  }
  return cache.keys.get(kid) ?? null;
}

/**
 * Verify JWT của Bot Framework/AAD gửi kèm activity (fail-closed).
 * Chấp nhận issuer api.botframework.com (Multi Tenant) hoặc
 * login.microsoftonline.com/<tenant>/v2.0 (Single Tenant); audience = appId.
 */
export async function verifyTeamsJwt(
  authHeader: string | undefined,
  appId: string,
  tenantId: string,
): Promise<boolean> {
  try {
    if (!authHeader?.startsWith("Bearer ")) return false;
    const [h, p, sig] = authHeader.slice(7).trim().split(".");
    if (!h || !p || !sig) return false;
    const head = parseJwtPart<{ alg?: string; kid?: string }>(h);
    const payload = parseJwtPart<{ aud?: string; iss?: string; exp?: number; nbf?: number }>(p);
    if (!head?.kid || head.alg !== "RS256" || !payload) return false;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now - 300) return false;
    if (payload.nbf && payload.nbf > now + 300) return false;
    if (payload.aud !== appId) return false;
    const allowedIss = new Set([
      "https://api.botframework.com",
      // Bot Single Tenant: AAD phát token issuer v2 hoặc v1 (sts.windows.net)
      ...(tenantId
        ? [
            `https://login.microsoftonline.com/${tenantId}/v2.0`,
            `https://sts.windows.net/${tenantId}/`,
          ]
        : []),
    ]);
    if (!payload.iss || !allowedIss.has(payload.iss)) return false;
    const jwk = await getJwk(head.kid, tenantId);
    if (!jwk) return false;
    const pub = createPublicKey({ key: jwk, format: "jwk" });
    return cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, b64urlToBuffer(sig));
  } catch {
    return false;
  }
}
