import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Channel, ChannelDeps, OutboundMessage } from "./types.js";
import { chunkText } from "./telegram.js";

const DISCORD_MAX = 2000;

/**
 * Adapter Discord (discord.js gateway). chatKey = channel_id.
 * Bỏ qua tin của bot. Reply theo channel.
 */
export class DiscordChannel implements Channel {
  readonly kind = "discord";
  readonly id: string;
  readonly name: string;
  private client: Client;
  private running = false;

  constructor(private deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot || !msg.content) return;
      const isDm = !msg.guild;
      try {
        const res = await this.deps.onInbound({
          channelId: this.id,
          channelKind: this.kind,
          chatKey: msg.channelId,
          senderId: msg.author.id,
          senderName: msg.author.username,
          text: msg.content,
          peerKind: isDm ? "direct" : "group",
        });
        if (res.kind === "reply" || res.kind === "pairing") {
          for (const part of chunkText(res.text, DISCORD_MAX)) {
            await msg.reply(part);
          }
        }
      } catch (err) {
        this.deps.onError?.(err as Error);
      }
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.deps.token);
    this.running = true;
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    this.running = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const ch = await this.client.channels.fetch(msg.chatKey);
    if (ch && ch.isTextBased() && "send" in ch) {
      for (const part of chunkText(msg.text, DISCORD_MAX)) {
        await (ch as { send: (t: string) => Promise<unknown> }).send(part);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
