import type { Channel, ChannelDeps, InboundMessage, OutboundMessage } from "./types.js";

/**
 * Adapter Feishu/Lark (REST API). token = tenant_access_token.
 * Inbound qua webhook event. chatKey = chat_id.
 */
export class FeishuChannel implements Channel {
  readonly kind = "feishu";
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
    const res = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          receive_id: msg.chatKey,
          msg_type: "text",
          content: JSON.stringify({ text: msg.text }),
        }),
      },
    );
    if (!res.ok) throw new Error(`Feishu send lỗi ${res.status}: ${await res.text()}`);
  }
}

/** Parse webhook event Feishu (im.message.receive_v1) → InboundMessage. */
export function parseFeishuWebhook(channelId: string, payload: unknown): InboundMessage[] {
  const p = payload as {
    header?: { event_type?: string };
    event?: {
      message?: { chat_id?: string; message_type?: string; content?: string };
      sender?: { sender_id?: { open_id?: string } };
    };
  };
  if (p.header?.event_type !== "im.message.receive_v1") return [];
  const m = p.event?.message;
  if (m?.message_type !== "text" || !m.chat_id || !m.content) return [];
  let text = "";
  try {
    text = (JSON.parse(m.content) as { text?: string }).text ?? "";
  } catch {
    return [];
  }
  if (!text) return [];
  return [
    {
      channelId,
      channelKind: "feishu",
      chatKey: m.chat_id,
      senderId: p.event?.sender?.sender_id?.open_id ?? m.chat_id,
      text,
      peerKind: "group",
    },
  ];
}
