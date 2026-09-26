import type { AgentStatus } from "./types.js";

/**
 * Emoji "thả cảm xúc" lên tin nhắn của người dùng để họ biết agent đang làm gì:
 * đã nhận → đang nghĩ → đang dùng công cụ → xong / lỗi, và báo khi im lặng lâu.
 *
 * - Trạng thái trung gian đổi liên tục trong một lượt chạy → chỉ hiện trạng thái
 *   mới nhất khi nó đứng yên đủ REACTION_DEBOUNCE_MS (đỡ gọi API dồn dập).
 * - Kết thúc (done / error) hiện ngay và khóa lại, không đổi nữa.
 * - Không có tín hiệu mới sau STALL_SOFT_MS rồi STALL_HARD_MS → emoji "chờ lâu".
 */
export const REACTION_DEBOUNCE_MS = 700;
export const STALL_SOFT_MS = 10_000;
export const STALL_HARD_MS = 30_000;

type ReactionStatus = AgentStatus | "stallSoft" | "stallHard";

/** Emoji Telegram cho phép dùng làm reaction (theo tài liệu Bot API). */
export const TELEGRAM_REACTIONS: ReadonlySet<string> = new Set(
  (
    "❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ " +
    "🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 " +
    "🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡"
  ).split(" "),
);

/** Mỗi trạng thái một emoji và một dòng giải thích (dùng cho lệnh /reactions). */
const STATUS_TABLE: Array<{ status: ReactionStatus; emoji: string; desc: string }> = [
  { status: "queued", emoji: "👀", desc: "Đã nhận — chờ xử lý" },
  { status: "thinking", emoji: "🤔", desc: "Đang suy nghĩ" },
  { status: "tool", emoji: "✍", desc: "Đang chạy tool" },
  { status: "coding", emoji: "👨‍💻", desc: "Đang chạy code" },
  { status: "web", emoji: "⚡", desc: "Đang truy cập web/API" },
  { status: "done", emoji: "👍", desc: "Hoàn thành" },
  { status: "error", emoji: "💔", desc: "Có lỗi xảy ra" },
  { status: "stallSoft", emoji: "🥱", desc: "Không hoạt động 10s" },
  { status: "stallHard", emoji: "😨", desc: "Không hoạt động 30s" },
];

const EMOJI_BY_STATUS = new Map(STATUS_TABLE.map((r) => [r.status, r.emoji]));

/** Chú giải emoji cho lệnh /reactions. */
export const REACTION_LEGEND: ReadonlyArray<{ status: string; emoji: string; desc: string }> = STATUS_TABLE;

/** Emoji của một trạng thái; "" nếu không có hoặc Telegram không cho phép. */
export function resolveReactionEmoji(status: ReactionStatus): string {
  const emoji = EMOJI_BY_STATUS.get(status) ?? "";
  return TELEGRAM_REACTIONS.has(emoji) ? emoji : "";
}

type Timer = ReturnType<typeof setTimeout>;

/** Emoji trạng thái trên MỘT tin nhắn người dùng, suốt một lượt agent chạy. */
export class StatusReactionController {
  /** Emoji đang hiện — tránh gọi API lặp lại cùng một emoji. */
  private shown = "";
  /** done/error đã hiện → bỏ qua mọi trạng thái đến sau. */
  private locked = false;
  private pending: Timer | undefined;
  private idle: Timer | undefined;

  constructor(
    /** Gọi API đặt reaction (emoji rỗng = gỡ reaction). */
    private readonly apply: (emoji: string) => Promise<void>,
  ) {}

  setStatus(status: ReactionStatus): void {
    if (this.locked) return;
    this.armIdleWatch();
    clearTimeout(this.pending);
    this.pending = undefined;
    if (status === "done" || status === "error") {
      this.locked = true;
      clearTimeout(this.idle);
      this.show(resolveReactionEmoji(status));
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!this.locked) this.show(resolveReactionEmoji(status));
    }, REACTION_DEBOUNCE_MS);
  }

  /** Hủy mọi hẹn giờ khi lượt chạy đã xong hẳn. */
  stop(): void {
    clearTimeout(this.pending);
    clearTimeout(this.idle);
    this.pending = this.idle = undefined;
  }

  /** Mỗi tín hiệu mới đặt lại đồng hồ im lặng: mốc 1 → emoji chờ, mốc 2 → emoji lo. */
  private armIdleWatch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.locked) return;
      this.show(resolveReactionEmoji("stallSoft"));
      this.idle = setTimeout(() => {
        if (!this.locked) this.show(resolveReactionEmoji("stallHard"));
      }, STALL_HARD_MS - STALL_SOFT_MS);
    }, STALL_SOFT_MS);
  }

  private show(emoji: string): void {
    if (!emoji || emoji === this.shown) return;
    this.apply(emoji).then(
      () => {
        this.shown = emoji;
      },
      () => {
        // chat cấm reaction, tin đã bị xóa... — không được làm hỏng lượt trả lời
      },
    );
  }
}
