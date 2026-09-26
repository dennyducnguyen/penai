import type { Channel, ChannelDeps, InboundMessage, OutboundMessage } from "./types.js";

/**
 * Adapter Zalo Official Account (REST API). token = OA access_token.
 * Inbound qua webhook (server route). chatKey = user_id.
 */
export class ZaloOaChannel implements Channel {
  readonly kind = "zalo";
  readonly id: string;
  readonly name: string;
  private token: string;

  constructor(deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.token = deps.token;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean {
    return true;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const res = await fetch("https://openapi.zalo.me/v3.0/oa/message/cs", {
      method: "POST",
      headers: { "content-type": "application/json", access_token: this.token },
      body: JSON.stringify({
        recipient: { user_id: msg.chatKey },
        message: { text: msg.text.slice(0, 2000) },
      }),
    });
    if (!res.ok) throw new Error(`Zalo send lỗi ${res.status}: ${await res.text()}`);
  }
}

/** Parse webhook Zalo OA → InboundMessage (chỉ tin text từ user). */
export function parseZaloWebhook(channelId: string, payload: unknown): InboundMessage[] {
  const p = payload as {
    event_name?: string;
    sender?: { id?: string };
    message?: { text?: string };
  };
  if (p.event_name !== "user_send_text" || !p.sender?.id || !p.message?.text) return [];
  return [
    {
      channelId,
      channelKind: "zalo",
      chatKey: p.sender.id,
      senderId: p.sender.id,
      text: p.message.text,
      peerKind: "direct",
    },
  ];
}
