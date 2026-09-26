import App from "@slack/bolt";
import type { Channel, ChannelDeps, OutboundMessage } from "./types.js";

/**
 * Adapter Slack (Socket Mode — không cần public URL).
 * config.appToken = App-Level Token (xapp-...); token = Bot Token (xoxb-...).
 * chatKey = channel id. Bỏ qua tin bot.
 */
export class SlackChannel implements Channel {
  readonly kind = "slack";
  readonly id: string;
  readonly name: string;
  private app: InstanceType<typeof App>;
  private running = false;

  constructor(private deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    const appToken = String(deps.config.appToken ?? "");
    if (!appToken) throw new Error("Slack cần config.appToken (xapp-...)");

    this.app = new App({
      token: deps.token,
      appToken,
      socketMode: true,
    });

    this.app.message(async ({ message, say }: { message: unknown; say: (t: string) => Promise<unknown> }) => {
      const m = message as {
        subtype?: string;
        bot_id?: string;
        text?: string;
        user?: string;
        channel?: string;
        channel_type?: string;
      };
      if (m.subtype || m.bot_id || !m.text || !m.user) return;
      try {
        const res = await this.deps.onInbound({
          channelId: this.id,
          channelKind: this.kind,
          chatKey: m.channel ?? "",
          senderId: m.user,
          text: m.text,
          peerKind: m.channel_type === "im" ? "direct" : "group",
        });
        if (res.kind === "reply" || res.kind === "pairing") {
          await say(res.text);
        }
      } catch (err) {
        this.deps.onError?.(err as Error);
      }
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.running = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: msg.chatKey,
      text: msg.text,
    });
  }

  isRunning(): boolean {
    return this.running;
  }
}
