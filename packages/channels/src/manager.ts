import { logger } from "@penai/shared";
import type { Channel, ChannelDeps } from "./types.js";
import { TelegramChannel } from "./telegram.js";
import { DiscordChannel } from "./discord.js";
import { SlackChannel } from "./slack.js";
import { WhatsappChannel } from "./whatsapp.js";
import { ZaloOaChannel } from "./zalo.js";
import { ZaloPersonalChannel } from "./zalo-personal.js";
import { FeishuChannel } from "./feishu.js";
import { TeamsChannel } from "./teams.js";

export type ChannelFactory = (deps: ChannelDeps) => Channel;

/** Đăng ký factory theo kind. Thêm kênh mới = thêm 1 dòng ở đây. */
const FACTORIES: Record<string, ChannelFactory> = {
  telegram: (d) => new TelegramChannel(d),
  discord: (d) => new DiscordChannel(d),
  slack: (d) => new SlackChannel(d),
  whatsapp: (d) => new WhatsappChannel(d),
  zalo: (d) => new ZaloOaChannel(d),
  zalo_personal: (d) => new ZaloPersonalChannel(d),
  feishu: (d) => new FeishuChannel(d),
  msteams: (d) => new TeamsChannel(d),
};

export function isChannelKindSupported(kind: string): boolean {
  return kind in FACTORIES;
}

export function supportedChannelKinds(): string[] {
  return Object.keys(FACTORIES);
}

/**
 * Quản lý vòng đời các channel đang chạy trong process.
 * Server nạp channel enabled từ DB → addChannel() cho từng cái → startAll().
 */
export class ChannelManager {
  private channels = new Map<string, Channel>();

  add(kind: string, deps: ChannelDeps): Channel {
    const factory = FACTORIES[kind];
    if (!factory) throw new Error(`Channel kind chưa hỗ trợ: ${kind}`);
    const ch = factory(deps);
    this.channels.set(ch.id, ch);
    return ch;
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  list(): Channel[] {
    return [...this.channels.values()];
  }

  /**
   * Khởi động mọi channel song song. Một channel treo/lỗi KHÔNG được chặn
   * phần còn lại của server (cron, orchestrator...): quá hạn thì log cảnh báo
   * và tiếp tục — channel đó vẫn chạy nền, xong lúc nào ghi log lúc đó.
   */
  async startAll(timeoutMs = 60_000): Promise<void> {
    await Promise.all(
      this.list().map((c) => {
        const started = c
          .start()
          .then(() => {
            logger.info(`Channel "${c.name}" (${c.kind}) đã khởi động`);
            return true;
          })
          .catch((e) => {
            logger.error(
              `Không khởi động được channel ${c.name}: ${(e as Error).message}`,
            );
            return false;
          });
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(
              `Channel "${c.name}" (${c.kind}) chưa khởi động xong sau ${Math.round(timeoutMs / 1000)}s — server tiếp tục, channel chạy nền`,
            );
            resolve();
          }, timeoutMs);
          timer.unref?.();
        });
        return Promise.race([started.then(() => clearTimeout(timer)), deadline]);
      }),
    );
  }

  /** Dừng + gỡ 1 channel (cho sửa/tắt channel không cần restart server). */
  async remove(id: string): Promise<void> {
    const c = this.channels.get(id);
    if (!c) return;
    this.channels.delete(id);
    await c.stop().catch(() => {});
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((c) => c.stop()));
    this.channels.clear();
  }
}
