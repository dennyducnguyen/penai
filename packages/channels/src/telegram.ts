import { Bot, InputFile, type Context } from "grammy";
import type {
  AgentStatus,
  Channel,
  ChannelDeps,
  InboundMedia,
  OutboundButton,
  OutboundMessage,
} from "./types.js";
import { StatusReactionController, REACTION_LEGEND } from "./status-reactions.js";
import { BoundedRunner } from "./bounded-runner.js";
import { TypingController } from "./typing.js";
import { markdownToTelegramHtml, chunkHtml, stripToPlain } from "./format.js";

const TELEGRAM_MAX = 4096;
const STREAM_EDIT_THROTTLE_MS = 1000;
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DOC_TEXT_MAX_BYTES = 200 * 1024;
// Album Telegram: mỗi ảnh là 1 message riêng (cùng media_group_id) đến cách
// nhau vài trăm ms — gom lại thành 1 lượt xử lý, tránh bot trả lời 5 lần.
const ALBUM_BUFFER_MS = 1500;

/** Chia text dài thành nhiều đoạn <= 4096 ký tự (ưu tiên cắt theo dòng). */
export function chunkText(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

const MENU_COMMANDS = [
  { command: "start", description: "Bắt đầu" },
  { command: "help", description: "Trợ giúp" },
  { command: "new", description: "Cuộc trò chuyện mới" },
  { command: "reset", description: "Xóa lịch sử, bắt đầu lại" },
  { command: "stop", description: "Dừng câu trả lời đang chạy" },
  { command: "status", description: "Trạng thái bot" },
  { command: "reactions", description: "Chú giải emoji trạng thái" },
];

const TEXT_MIMES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|toml))/;

/**
 * Adapter Telegram (grammY, long polling) với hiệu ứng chat:
 * - Reaction emoji trạng thái trên tin nhắn user (👀→🤔→✍/⚡/👨‍💻→👍)
 * - Typing indicator keepalive
 * - Stream draft: gửi sớm rồi edit dần (DM), chốt bằng bản HTML định dạng
 * - Markdown→HTML + chunk an toàn, fallback plain khi Telegram từ chối
 * - require_mention trong group, nhận ảnh/document
 */
export class TelegramChannel implements Channel {
  readonly kind = "telegram";
  readonly id: string;
  readonly name: string;
  private bot: Bot;
  private running = false;
  private botUsername = "";
  private requireMention: boolean;
  private dmStream: boolean;
  private groupStream: boolean;
  private reactionLevel: "off" | "minimal" | "full";
  private albumBuffers = new Map<
    string,
    { ctxs: Context[]; texts: string[]; timer: ReturnType<typeof setTimeout> | null }
  >();
  // Mỗi update xử lý nền, tối đa 20 đồng thời:
  // agent của người này chạy lâu KHÔNG chặn tin nhắn người khác.
  private runner: BoundedRunner;

  constructor(private deps: ChannelDeps) {
    this.id = deps.id;
    this.name = deps.name;
    // timeoutSeconds mặc định của grammY là 500s — một request treo (getMe lúc
    // boot) sẽ chặn start() rất lâu. 30s là quá đủ cho api.telegram.org.
    this.bot = new Bot(deps.token, { client: { timeoutSeconds: 30 } });
    const cfg = deps.config;
    this.requireMention = cfg["require_mention"] !== false;
    this.dmStream = cfg["dm_stream"] !== false;
    this.groupStream = cfg["group_stream"] === true;
    const lvl = cfg["reaction_level"];
    this.reactionLevel =
      lvl === "off" || lvl === "minimal" ? lvl : "full";

    this.runner = new BoundedRunner(20, (err) => deps.onError?.(err));
    // KHÔNG await handleMessage trong middleware — grammY long-poll xử lý update
    // tuần tự, await ở đây nghĩa là 1 lượt agent chạy lâu chặn MỌI người dùng khác.
    this.bot.on("message", (grctx) => {
      this.runner.run(() => this.handleMessage(grctx));
    });
    // Nút inline (approval card...) — xử lý nền như message
    this.bot.on("callback_query:data", (grctx) => {
      this.runner.run(() => this.handleCallback(grctx));
    });
  }

  /** Người dùng bấm nút inline → chuyển cho runtime, trả toast/alert. */
  private async handleCallback(grctx: Context): Promise<void> {
    const cq = grctx.callbackQuery;
    if (!cq?.data) return;
    const msg = cq.message;
    const chat = msg?.chat;
    let result: { text?: string; showAlert?: boolean } | undefined | void;
    try {
      if (this.deps.onCallback && chat && msg) {
        const topicId = msg.message_thread_id;
        const chatKey =
          msg.is_topic_message && topicId
            ? `${chat.id}:topic:${topicId}`
            : String(chat.id);
        result = await this.deps.onCallback({
          channelId: this.id,
          channelKind: this.kind,
          chatKey,
          senderId: String(cq.from.id),
          senderName:
            [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") ||
            cq.from.username ||
            String(cq.from.id),
          data: cq.data,
          messageId: String(msg.message_id),
        });
      }
    } catch (err) {
      this.deps.onError?.(err as Error);
      result = { text: "⚠️ Có lỗi khi xử lý thao tác. Vui lòng thử lại.", showAlert: true };
    }
    try {
      await this.bot.api.answerCallbackQuery(cq.id, {
        ...(result?.text ? { text: result.text.slice(0, 200) } : {}),
        ...(result?.showAlert ? { show_alert: true } : {}),
      });
    } catch {
      // callback quá hạn (>15s) Telegram từ chối answer — bỏ qua
    }
  }

  private static inlineKeyboard(buttons: OutboundButton[][]) {
    return {
      inline_keyboard: buttons.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) })),
      ),
    };
  }

  /**
   * Gửi tin chủ động kèm nút inline, trả message_id (để edit thẻ về sau).
   * Text phải gọn trong 1 tin nhắn Telegram (thẻ approval luôn < 4096).
   */
  async sendWithButtons(
    chatKey: string,
    text: string,
    buttons: OutboundButton[][],
  ): Promise<string> {
    const [chatId, , topicId] = chatKey.split(":");
    const opts = {
      ...(topicId ? { message_thread_id: Number(topicId) } : {}),
      reply_markup: TelegramChannel.inlineKeyboard(buttons),
      link_preview_options: { is_disabled: true },
    };
    const html = markdownToTelegramHtml(text);
    try {
      const sent = await this.bot.api.sendMessage(Number(chatId), html, {
        parse_mode: "HTML",
        ...opts,
      });
      return String(sent.message_id);
    } catch {
      const sent = await this.bot.api.sendMessage(
        Number(chatId),
        stripToPlain(text),
        opts,
      );
      return String(sent.message_id);
    }
  }

  /**
   * Sửa nội dung + nút của tin nhắn đã gửi (thẻ approval sau khi quyết định).
   * buttons = [] → gỡ hết nút (thẻ trở thành read-only).
   */
  async editMessage(
    chatKey: string,
    messageId: string,
    text: string,
    buttons: OutboundButton[][] = [],
  ): Promise<void> {
    const [chatId] = chatKey.split(":");
    const markup = { reply_markup: TelegramChannel.inlineKeyboard(buttons) };
    const html = markdownToTelegramHtml(text);
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), html, {
        parse_mode: "HTML",
        ...markup,
      });
    } catch (err) {
      if (/not modified/i.test((err as Error).message ?? "")) return;
      await this.bot.api
        .editMessageText(Number(chatId), Number(messageId), stripToPlain(text), markup)
        .catch((e: unknown) => this.deps.onError?.(e as Error));
    }
  }

  // ---- inbound ----

  private async handleMessage(grctx: Context): Promise<void> {
    const msg = grctx.message;
    const chat = grctx.chat;
    const from = grctx.from;
    if (!msg || !chat || !from || from.is_bot) return;
    // bỏ qua service message (join/leave/đổi tên nhóm...)
    if (
      "new_chat_members" in msg ||
      "left_chat_member" in msg ||
      "new_chat_title" in msg ||
      "pinned_message" in msg
    ) {
      return;
    }

    const topicId = msg.message_thread_id;
    const isForumTopic = Boolean(msg.is_topic_message && topicId);
    const chatKey = isForumTopic
      ? `${chat.id}:topic:${topicId}`
      : String(chat.id);
    const peerKind = chat.type === "private" ? "direct" : "group";
    let text = msg.text ?? msg.caption ?? "";

    // Group: chỉ trả lời khi được nhắc tên hoặc reply vào tin của bot
    if (peerKind === "group" && this.requireMention) {
      const mentioned =
        this.botUsername &&
        text.toLowerCase().includes("@" + this.botUsername.toLowerCase());
      const replyToBot =
        msg.reply_to_message?.from?.is_bot &&
        msg.reply_to_message.from.username?.toLowerCase() ===
          this.botUsername.toLowerCase();
      const isCommand = /^\/[a-z]/i.test(text.trim());
      if (!mentioned && !replyToBot && !isCommand) return;
    }
    // gỡ @mention của chính bot khỏi text
    if (this.botUsername) {
      text = text.replace(new RegExp("@" + this.botUsername, "gi"), "").trim();
    }

    // lệnh nội bộ /reactions — trả chú giải ngay, không qua agent
    if (text.trim().toLowerCase().split("@")[0] === "/reactions") {
      const legend = REACTION_LEGEND.map(
        (r) => `${r.emoji} — ${r.desc}`,
      ).join("\n");
      await this.replySafe(grctx, "Chú giải emoji trạng thái:\n" + legend, topicId);
      return;
    }

    // Album (media_group): buffer các message cùng nhóm rồi xử lý 1 lần
    if (msg.media_group_id) {
      const key = `${chat.id}:${msg.media_group_id}`;
      let buf = this.albumBuffers.get(key);
      if (!buf) {
        buf = { ctxs: [], texts: [], timer: null };
        this.albumBuffers.set(key, buf);
      }
      buf.ctxs.push(grctx);
      if (text) buf.texts.push(text);
      if (buf.timer) clearTimeout(buf.timer);
      const found = buf;
      buf.timer = setTimeout(() => {
        this.albumBuffers.delete(key);
        void this.flushAlbum(found).catch((err) => this.deps.onError?.(err as Error));
      }, ALBUM_BUFFER_MS);
      return;
    }

    const media = await this.collectMedia(grctx);
    if (!text && media.length === 0) return;
    await this.dispatch(grctx, text, media);
  }

  /** Gom media của cả album rồi xử lý như 1 tin nhắn duy nhất. */
  private async flushAlbum(buf: { ctxs: Context[]; texts: string[] }): Promise<void> {
    const first = buf.ctxs[0];
    if (!first) return;
    const media: InboundMedia[] = [];
    for (const c of buf.ctxs) {
      media.push(...(await this.collectMedia(c)));
    }
    const text = buf.texts.join("\n").trim();
    if (!text && media.length === 0) return;
    await this.dispatch(first, text, media);
  }

  /** Chạy hiệu ứng + gọi runtime cho 1 lượt tin nhắn (đã gom media). */
  private async dispatch(grctx: Context, text: string, media: InboundMedia[]): Promise<void> {
    const msg = grctx.message;
    const chat = grctx.chat;
    const from = grctx.from;
    if (!msg || !chat || !from) return;
    const topicId = msg.message_thread_id;
    const isForumTopic = Boolean(msg.is_topic_message && topicId);
    const chatKey = isForumTopic ? `${chat.id}:topic:${topicId}` : String(chat.id);
    const peerKind = chat.type === "private" ? "direct" : "group";

    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    // ---- hiệu ứng: reaction + typing + stream draft ----
    const rc =
      this.reactionLevel === "off"
        ? null
        : new StatusReactionController(async (emoji) => {
            await this.bot.api.setMessageReaction(
              chat.id,
              msg.message_id,
              emoji ? [{ type: "emoji", emoji: emoji as never }] : [],
            );
          });
    const typing = new TypingController({
      keepaliveMs: 4000,
      start: () =>
        this.bot.api.sendChatAction(chat.id, "typing", {
          ...(topicId ? { message_thread_id: topicId } : {}),
        }),
    });

    const streamEnabled = peerKind === "direct" ? this.dmStream : this.groupStream;
    let draftId: number | null = null;
    let draftText = "";
    let lastEdit = 0;
    let editChain: Promise<void> = Promise.resolve();

    const pushDraft = (force = false) => {
      if (!streamEnabled) return;
      // marker nội bộ [[media:...]] không được hiện ra bản nháp người dùng thấy
      const snapshot = draftText.replace(/\[\[media:[^\]]*\]?\]?/g, "");
      if (!snapshot.trim() || snapshot.length > TELEGRAM_MAX - 96) return;
      const now = Date.now();
      if (!force && now - lastEdit < STREAM_EDIT_THROTTLE_MS) return;
      lastEdit = now;
      editChain = editChain
        .then(async () => {
          if (draftId === null) {
            const sent = await this.bot.api.sendMessage(chat.id, snapshot, replyOpts);
            draftId = sent.message_id;
          } else {
            await this.bot.api.editMessageText(chat.id, draftId, snapshot);
          }
        })
        .catch(() => {});
    };

    const setStatus = (s: AgentStatus) => {
      if (rc) {
        if (this.reactionLevel === "minimal" && s !== "done" && s !== "error") {
          // minimal: chỉ reaction terminal
        } else {
          rc.setStatus(s);
        }
      }
      if (s === "queued" || s === "thinking") typing.start();
      if (s === "done" || s === "error") typing.markRunComplete();
    };

    const hooks = {
      onStatus: setStatus,
      onTextDelta: (delta: string) => {
        draftText += delta;
        pushDraft();
      },
      onBlockReply: (t: string) => {
        // Câu dẫn trước tool → chốt draft hiện tại thành bubble riêng.
        // Phải nối vào editChain, nếu không một lần edit đang xếp hàng có thể
        // chạy SAU finalize và ghi đè bubble đã chốt bằng bản nháp cũ.
        const idAtCall = draftId;
        draftId = null;
        draftText = "";
        editChain = editChain
          .then(() => this.finalizeDraft(chat.id, idAtCall, t, replyOpts))
          .catch((err: unknown) => this.deps.onError?.(err as Error));
      },
    };

    try {
      const res = await this.deps.onInbound(
        {
          channelId: this.id,
          channelKind: this.kind,
          chatKey,
          senderId: String(from.id),
          senderName:
            [from.first_name, from.last_name].filter(Boolean).join(" ") ||
            from.username ||
            String(from.id),
          text,
          peerKind,
          ...(media.length ? { media } : {}),
        },
        hooks,
      );

      await editChain; // chờ mọi edit draft đang bay xong

      if (res.kind === "reply" || res.kind === "pairing") {
        if (res.text.trim()) {
          await this.deliverFinal(chat.id, draftId, res.text, replyOpts);
        } else if (draftId !== null) {
          await this.bot.api.deleteMessage(chat.id, draftId).catch(() => {});
        }
        if (res.kind === "reply" && res.media?.length) {
          await this.sendMediaFiles(chat.id, res.media, replyOpts);
        }
      } else if (draftId !== null) {
        // ignore nhưng đã lỡ stream → xóa draft
        await this.bot.api.deleteMessage(chat.id, draftId).catch(() => {});
      }
    } catch (err) {
      this.deps.onError?.(err as Error);
      setStatus("error");
      // dọn bong bóng nháp dang dở, tránh để câu trả lời cụt cạnh thông báo lỗi
      if (draftId !== null) {
        await this.bot.api.deleteMessage(chat.id, draftId).catch(() => {});
      }
      try {
        await grctx.reply("⚠️ Có lỗi khi xử lý tin nhắn. Vui lòng thử lại.", replyOpts);
      } catch {
        // ignore
      }
    } finally {
      typing.markDispatchIdle();
      typing.stopNow();
      rc?.stop();
    }
  }

  /** Gửi câu trả lời cuối: edit draft (nếu có) bằng bản HTML, còn lại gửi mới. */
  private async deliverFinal(
    chatId: number,
    draftId: number | null,
    mdText: string,
    replyOpts: Record<string, unknown>,
  ): Promise<void> {
    const html = markdownToTelegramHtml(mdText);
    const chunks = chunkHtml(html);
    let first = chunks.shift() ?? "";
    if (draftId !== null && first) {
      try {
        await this.bot.api.editMessageText(chatId, draftId, first, {
          parse_mode: "HTML",
        });
        first = "";
      } catch (err) {
        // "message is not modified" = nội dung chốt TRÙNG bản nháp đang hiển
        // thị → coi như đã gửi xong, gửi lại sẽ thành tin nhắn lặp.
        if (/not modified/i.test((err as Error).message ?? "")) first = "";
        // lỗi khác (HTML sai...) → gửi tin mới bên dưới
      }
    }
    const remaining = first ? [first, ...chunks] : chunks;
    for (const part of remaining) {
      await this.sendHtmlWithFallback(chatId, part, replyOpts, mdText);
    }
  }

  private async sendHtmlWithFallback(
    chatId: number,
    html: string,
    replyOpts: Record<string, unknown>,
    originalMd: string,
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...replyOpts,
      });
    } catch (err) {
      // Telegram từ chối HTML → fallback plain text. Fallback cũng có thể lỗi
      // (bot bị chặn, flood 429) — nuốt lỗi ở đây, KHÔNG để rejection thoát ra
      // ngoài làm sập tiến trình.
      try {
        for (const part of chunkText(stripToPlain(originalMd))) {
          await this.bot.api.sendMessage(chatId, part, { ...replyOpts });
        }
      } catch (fallbackErr) {
        this.deps.onError?.(fallbackErr as Error);
      }
      void err;
    }
  }

  private async finalizeDraft(
    chatId: number,
    draftId: number | null,
    mdText: string,
    replyOpts: Record<string, unknown>,
  ): Promise<void> {
    const html = markdownToTelegramHtml(mdText);
    const chunks = chunkHtml(html);
    const first = chunks.shift() ?? "";
    if (draftId !== null && first) {
      try {
        await this.bot.api.editMessageText(chatId, draftId, first, { parse_mode: "HTML" });
      } catch {
        await this.sendHtmlWithFallback(chatId, first, replyOpts, mdText);
      }
    } else if (first) {
      await this.sendHtmlWithFallback(chatId, first, replyOpts, mdText);
    }
    for (const part of chunks) {
      await this.sendHtmlWithFallback(chatId, part, replyOpts, mdText);
    }
  }

  private async replySafe(
    grctx: { reply: (t: string, o?: object) => Promise<unknown> },
    text: string,
    topicId?: number,
  ): Promise<void> {
    try {
      await grctx.reply(text, topicId ? { message_thread_id: topicId } : {});
    } catch {
      // ignore
    }
  }

  /** Tải media đính kèm: ảnh → data URL, document text → nội dung. */
  private async collectMedia(grctx: Context): Promise<InboundMedia[]> {
    const msg = grctx.message;
    if (!msg) return [];
    const out: InboundMedia[] = [];

    try {
      if (msg.photo?.length) {
        // photo[] xếp theo độ phân giải tăng dần — lấy bản to nhất còn trong cap
        const best = [...msg.photo]
          .reverse()
          .find((p) => (p.file_size ?? 0) <= MEDIA_MAX_BYTES);
        if (best) {
          const data = await this.downloadFile(best.file_id);
          if (data) {
            out.push({
              kind: "photo",
              dataUrl: `data:image/jpeg;base64,${data.toString("base64")}`,
            });
          }
        } else {
          out.push({ kind: "photo", note: "[Ảnh bị bỏ qua: vượt 10MB]" });
        }
      }
      if (msg.document) {
        const doc = msg.document;
        const name = doc.file_name ?? "file";
        if (
          TEXT_MIMES.test(doc.mime_type ?? "") &&
          (doc.file_size ?? 0) <= DOC_TEXT_MAX_BYTES
        ) {
          const data = await this.downloadFile(doc.file_id);
          if (data) {
            // text nhỏ: inline nội dung cho LLM + kèm bản gốc để runtime lưu file
            out.push({
              kind: "document",
              name,
              text: data.toString("utf8"),
              dataB64: data.toString("base64"),
            });
          }
        } else if ((doc.mime_type ?? "").startsWith("image/") && (doc.file_size ?? 0) <= MEDIA_MAX_BYTES) {
          const data = await this.downloadFile(doc.file_id);
          if (data) {
            out.push({
              kind: "photo",
              name,
              dataUrl: `data:${doc.mime_type};base64,${data.toString("base64")}`,
            });
          }
        } else if ((doc.file_size ?? 0) <= MEDIA_MAX_BYTES) {
          // PDF/Word/Excel...: tải về để runtime lưu vào workspace — agent đọc
          // bằng read_document khi người dùng yêu cầu (trước đây file bị vứt bỏ)
          const data = await this.downloadFile(doc.file_id);
          if (data) {
            out.push({ kind: "document", name, dataB64: data.toString("base64") });
          } else {
            out.push({
              kind: "document",
              name,
              note: `[File "${name}" tải về thất bại]`,
            });
          }
        } else {
          out.push({
            kind: "document",
            name,
            note: `[File "${name}" bị bỏ qua: vượt 10MB]`,
          });
        }
      }
      if (msg.voice || msg.audio) {
        out.push({
          kind: "voice",
          note: "[Người dùng gửi tin nhắn thoại — hệ thống chưa hỗ trợ nghe, hãy lịch sự đề nghị họ nhắn chữ]",
        });
      }
      if (msg.video || msg.video_note || msg.animation) {
        out.push({
          kind: "video",
          note: "[Người dùng gửi video — hệ thống chưa hỗ trợ xem video]",
        });
      }
    } catch {
      // lỗi tải media không được chặn tin nhắn text
    }
    return out;
  }

  private async downloadFile(fileId: string): Promise<Buffer | null> {
    try {
      const f = await this.bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.deps.token}/${f.file_path}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      // file_size do API báo có thể thiếu → kiểm tra lại kích thước thật
      if (buf.length > MEDIA_MAX_BYTES) return null;
      return buf;
    } catch {
      return null;
    }
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    // init (getMe) có thể lỗi/treo thoáng qua lúc boot — thử lại 3 lần
    let initErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.init();
        initErr = null;
        break;
      } catch (err) {
        initErr = err;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (initErr) throw initErr;
    this.botUsername = this.bot.botInfo.username ?? "";
    // đăng ký menu lệnh (thử tối đa 3 lần)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.api.setMyCommands(MENU_COMMANDS);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // grammy start() chạy long-poll nền, không await tới khi stop.
    // Long polling hỏng (token bị thu hồi, 409 do chạy 2 instance) phải báo ra
    // onError và hạ cờ running, không được để rejection lơ lửng.
    void this.bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      this.running = false;
      this.deps.onError?.(err as Error);
    });
    this.running = true;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    // chờ các handler đang chạy dở xong rồi mới dừng hẳn
    await this.runner.drain(10_000);
    this.running = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const [chatId, , topicId] = msg.chatKey.split(":");
    const replyOpts = topicId ? { message_thread_id: Number(topicId) } : {};
    if (msg.text.trim()) {
      if (msg.buttons?.length) {
        await this.sendWithButtons(msg.chatKey, msg.text, msg.buttons);
      } else {
        const html = markdownToTelegramHtml(msg.text);
        for (const part of chunkHtml(html)) {
          await this.sendHtmlWithFallback(Number(chatId), part, replyOpts, msg.text);
        }
      }
    }
    if (msg.media?.length) {
      await this.sendMediaFiles(Number(chatId), msg.media, replyOpts);
    }
  }

  /** Gửi file media (ảnh → sendPhoto, khác → sendDocument). */
  private async sendMediaFiles(
    chatId: number,
    paths: string[],
    replyOpts: Record<string, unknown>,
  ): Promise<void> {
    for (const p of paths) {
      try {
        if (/\.(png|jpe?g|webp|gif)$/i.test(p)) {
          await this.bot.api.sendPhoto(chatId, new InputFile(p), { ...replyOpts });
        } else {
          await this.bot.api.sendDocument(chatId, new InputFile(p), { ...replyOpts });
        }
      } catch (err) {
        this.deps.onError?.(err as Error);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
