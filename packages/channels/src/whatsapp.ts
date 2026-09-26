import type { Channel, ChannelDeps, InboundMessage, OutboundMessage } from "./types.js";

/**
 * Adapter WhatsApp Cloud API (chính thức của Meta — HTTP, không lo ban).
 * token = access token; config.phoneNumberId = ID số gửi.
 * Inbound đến qua webhook (server route gọi parseWebhook + onInbound).
 * start/stop là no-op vì đây là webhook-driven, không phải gateway.
 */
export class WhatsappChannel implements Channel {
  readonly kind = "whatsapp";
  readonly id: string;
  readonly name: string;
  private phoneNumberId: string;

  constructor(deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.phoneNumberId = String(deps.config.phoneNumberId ?? "");
    this.token = deps.token;
  }

  private token: string;

  async start(): Promise<void> {
    // webhook-driven
  }
  async stop(): Promise<void> {
    // no-op
  }
  isRunning(): boolean {
    return true;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.phoneNumberId) throw new Error("WhatsApp cần config.phoneNumberId");
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: msg.chatKey,
          type: "text",
          text: { body: msg.text.slice(0, 4096) },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp send lỗi ${res.status}: ${await res.text()}`);
    }
  }
}

/**
 * Parse payload webhook WhatsApp Cloud API → danh sách InboundMessage.
 * (Server gọi khi nhận POST /webhooks/whatsapp/:channelId.)
 */
export function parseWhatsappWebhook(
  channelId: string,
  payload: unknown,
): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Array<{ changes?: unknown[] }>) {
    for (const change of entry.changes ?? []) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      const contacts = (value.contacts as Array<{ profile?: { name?: string }; wa_id?: string }>) ?? [];
      const nameById = new Map<string, string>();
      for (const c of contacts) if (c.wa_id && c.profile?.name) nameById.set(c.wa_id, c.profile.name);
      const messages = (value.messages as Array<{ from?: string; type?: string; text?: { body?: string } }>) ?? [];
      for (const m of messages) {
        if (m.type !== "text" || !m.from || !m.text?.body) continue;
        out.push({
          channelId,
          channelKind: "whatsapp",
          chatKey: m.from,
          senderId: m.from,
          ...(nameById.get(m.from) ? { senderName: nameById.get(m.from)! } : {}),
          text: m.text.body,
          peerKind: "direct",
        });
      }
    }
  }
  return out;
}
