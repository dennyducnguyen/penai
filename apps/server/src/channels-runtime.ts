import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decryptSecret, encryptSecret, logger } from "@penai/shared";
import { confineMediaPath } from "@penai/tools";
import {
  appendMessage,
  createSession,
  getAgentById,
  getChannelSession,
  isPaired,
  createPairing,
  mapChannelSession,
  upsertContact,
  upsertConversation,
  listEnabledChannels,
  updateChannel,
  upsertZaloObservedPeer,
  type EnabledChannel,
  recordTraceSafe,
} from "@penai/db";
import { Scheduler, runAgent } from "@penai/core";
import {
  ChannelManager,
  isChannelKindSupported,
  TeamsChannel,
  TelegramChannel,
  type AgentStatus,
  type CallbackResult,
  type Channel,
  type ChannelCallback,
  type InboundHandler,
  type InboundMedia,
  type InboundMessage,
  type InboundResult,
  type OutboundButton,
  type RunHooks,
} from "@penai/channels";

/** Handler + channel theo channelId — cho webhook route (WhatsApp, Teams) dùng. */
export const channelHandlers = new Map<
  string,
  { handler: InboundHandler; channel: Channel; workspaceId: string }
>();

/**
 * Interceptor inbound: module ngoài (bộ điều phối quy trình...) đăng ký để "nghe"
 * tin nhắn kênh TRƯỚC khi agent xử lý. Trả InboundResult = đã tiêu thụ tin
 * (không chạy agent); trả null = bỏ qua, luồng thường tiếp tục.
 */
export type InboundInterceptor = (msg: InboundMessage) => Promise<InboundResult | null>;
export const inboundInterceptors: InboundInterceptor[] = [];

/** Handler bấm nút inline (Telegram callback) — orchestrator đăng ký. */
export type ChannelCallbackHandler = (
  cb: ChannelCallback,
) => Promise<CallbackResult | undefined | void>;
export const channelCallbackHandlers: ChannelCallbackHandler[] = [];

/** Chạy chuỗi callback handler (webhook route Teams gọi; Telegram gọi qua deps.onCallback). */
export async function dispatchChannelCallback(
  cb: ChannelCallback,
): Promise<CallbackResult | undefined> {
  for (const cbHandler of channelCallbackHandlers) {
    try {
      const res = await cbHandler(cb);
      if (res) return res;
    } catch (err) {
      logger.warn(`Callback handler lỗi: ${(err as Error).message}`);
    }
  }
  return undefined;
}
import {
  buildLoopDeps,
  agentOpts,
  reasoningEffortOf,
  sanitizeUserKey,
  systemContext,
  type RuntimeDeps,
} from "./agent-runtime.js";

const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm

function genPairingCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
}

/** Run đang chạy theo sessionId — cho lệnh /stop hủy giữa chừng. */
const activeRuns = new Map<string, AbortController>();

// ===== Thẻ duyệt có nút bấm (tool send_approval_card) =====
// Agent gửi thẻ (Telegram inline keyboard / Teams Adaptive Card); người dùng
// bấm → sửa thẻ khóa nút (chống bấm trùng) + bơm kết quả vào hội thoại như tin
// nhắn hệ thống để agent xử lý tiếp. State in-memory: restart làm thẻ đang chờ
// hết hiệu lực (bấm sau restart được báo lịch sự, agent gửi lại được).
interface PendingApprovalCard {
  channelId: string;
  chatKey: string;
  peerKind: "direct" | "group";
  messageId: string | null;
  text: string;
  /** value → label để hiển thị trạng thái sau khi bấm. */
  labels: Record<string, string>;
  resolved: boolean;
}
const pendingApprovalCards = new Map<string, PendingApprovalCard>();

/** Tạo + gửi thẻ duyệt trên kênh hỗ trợ nút. Trả id thẻ. */
async function sendApprovalCard(
  channel: Channel,
  channelId: string,
  chatKey: string,
  peerKind: "direct" | "group",
  input: { text: string; buttons: Array<{ label: string; value: string }> },
): Promise<string> {
  const cardId = randomBytes(4).toString("hex");
  const rows: OutboundButton[][] = [
    input.buttons.map((b) => ({
      text: b.label,
      // Telegram giới hạn callback_data 64 byte → payload gọn {pac, v}
      data: JSON.stringify({ pac: cardId, v: b.value }),
    })),
  ];
  let messageId: string | null = null;
  if (channel instanceof TeamsChannel) {
    messageId = await channel.sendCard(chatKey, input.text, rows);
  } else if (channel instanceof TelegramChannel) {
    messageId = await channel.sendWithButtons(chatKey, input.text, rows);
  } else {
    throw new Error(`Kênh ${channel.kind} chưa hỗ trợ thẻ nút bấm`);
  }
  pendingApprovalCards.set(cardId, {
    channelId,
    chatKey,
    peerKind,
    messageId,
    text: input.text,
    labels: Object.fromEntries(input.buttons.map((b) => [b.value, b.label])),
    resolved: false,
  });
  return cardId;
}

/** Handler bấm nút thẻ duyệt — đăng ký vào chuỗi callback chung (chạy mọi kênh). */
channelCallbackHandlers.push(async (cb) => {
  let payload: { pac?: string; v?: string };
  try {
    payload = JSON.parse(cb.data) as { pac?: string; v?: string };
  } catch {
    return undefined; // không phải data của thẻ duyệt — nhường handler khác
  }
  if (!payload?.pac) return undefined;
  const card = pendingApprovalCards.get(payload.pac);
  if (!card) {
    return { text: "Thẻ này đã hết hiệu lực (hệ thống vừa khởi động lại) — nhờ trợ lý gửi lại thẻ mới." };
  }
  if (card.resolved) return { text: "Thẻ đã được xử lý trước đó." };
  card.resolved = true;
  const value = String(payload.v ?? "");
  const label = card.labels[value] ?? value;
  const who = cb.senderName ?? cb.senderId;
  const at = new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
  // 1. Khóa thẻ: sửa lại bỏ nút + ghi trạng thái
  const entry = channelHandlers.get(card.channelId);
  const statusLine = `\n\n— ${value === "approve" ? "✅" : value === "reject" ? "⛔" : "🔘"} **${who}** đã chọn "${label}" lúc ${at}`;
  const mid = card.messageId ?? (cb.messageId || null);
  if (entry && mid) {
    try {
      if (entry.channel instanceof TeamsChannel) {
        await entry.channel.updateCard(card.chatKey, mid, card.text + statusLine);
      } else if (entry.channel instanceof TelegramChannel) {
        await entry.channel.editMessage(card.chatKey, mid, card.text + statusLine);
      }
    } catch (err) {
      logger.warn(`Khóa thẻ duyệt ${payload.pac} lỗi: ${(err as Error).message}`);
    }
  }
  // 2. Bơm kết quả vào hội thoại như tin hệ thống → agent xử lý tiếp
  if (entry) {
    void (async () => {
      try {
        const res = await entry.handler({
          channelId: card.channelId,
          channelKind: cb.channelKind,
          chatKey: card.chatKey,
          senderId: cb.senderId,
          ...(cb.senderName ? { senderName: cb.senderName } : {}),
          peerKind: card.peerKind,
          mentioned: true,
          text:
            `[Thẻ duyệt #${payload.pac}] ${who} đã bấm "${label}" (giá trị: ${value}). ` +
            `Nội dung thẻ: """${card.text}""". Hãy tiếp tục xử lý theo quyết định này và báo kết quả.`,
        });
        if (res.kind === "reply" || res.kind === "pairing") {
          await entry.channel.send({
            chatKey: card.chatKey,
            text: res.text,
            ...(res.kind === "reply" && res.media?.length ? { media: res.media } : {}),
          });
        }
      } catch (err) {
        logger.warn(`Xử lý sau bấm thẻ duyệt lỗi: ${(err as Error).message}`);
      }
    })();
  }
  return { text: `Đã ghi nhận: ${label}` };
});

/** Marker file nội bộ — không được lọt ra cho người dùng thấy. */
const MEDIA_MARKER_RE = /\[\[media:[^\]]+\]\]/g;

// ===== Ảnh người dùng gửi qua kênh =====
// Lưu thành file trong thư mục riêng người gửi để: (1) tham chiếu lại ở các
// lượt sau (refImages của image_generation), (2) nạp lại vào vision.
// Theo dõi tối đa RECENT_IMAGES_MAX ảnh gần nhất mỗi session (in-memory —
// restart mất vision nạp lại nhưng file + tên trong lịch sử vẫn còn).
const RECENT_IMAGES_MAX = 5;
const recentImages = new Map<string, Array<{ name: string; path: string }>>();
/** Số lần liên tiếp chỉ-gửi-ảnh trong 1 session — để ack lần 2+ ngắn gọn. */
const imageOnlyStreak = new Map<string, number>();

export function extOfDataUrl(dataUrl: string): string {
  const m = /^data:image\/(\w+)/.exec(dataUrl);
  const t = m?.[1]?.toLowerCase();
  return t === "jpeg" ? "jpg" : (t ?? "jpg");
}

/**
 * Slug ASCII từ caption/tin nhắn để đặt tên file dễ tham chiếu, đỡ lỗi đường
 * dẫn (bỏ dấu tiếng Việt, kebab-case, tối đa ~6 từ). "Logo công ty mình
 * lưu lại nhé" → "logo-cong-ty-minh-luu-lai".
 */
export function slugFromCaption(text: string | undefined, maxWords = 6): string {
  if (!text) return "";
  const ascii = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .toLowerCase();
  const words = ascii
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join("-").slice(0, 48).replace(/-+$/, "");
}

/** Ghi file với tên mong muốn, trùng thì thêm hậu tố -2, -3... (không ghi đè). */
async function writeUnique(
  userDir: string,
  stem: string,
  ext: string,
  data: Buffer,
): Promise<{ name: string; path: string } | null> {
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    const abs = join(userDir, name);
    try {
      await writeFile(abs, data, { flag: "wx" });
      return { name, path: abs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        logger.warn(`Không lưu được file inbound "${name}": ${(err as Error).message}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Ghi các ảnh inbound thành file trong thư mục người gửi. Có caption → tên
 * slug theo caption (vd "logo-cong-ty.jpg"); không có → `anh-nhan-<stamp>`.
 */
export async function saveInboundImages(
  userDir: string,
  photos: InboundMedia[],
  caption?: string,
): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  if (!photos.length) return out;
  await mkdir(userDir, { recursive: true });
  const ts = new Date();
  const stamp =
    String(ts.getDate()).padStart(2, "0") +
    String(ts.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(ts.getHours()).padStart(2, "0") +
    String(ts.getMinutes()).padStart(2, "0") +
    String(ts.getSeconds()).padStart(2, "0");
  const slug = slugFromCaption(caption);
  let i = 0;
  for (const p of photos) {
    if (!p.dataUrl) continue;
    i++;
    const b64 = p.dataUrl.slice(p.dataUrl.indexOf(",") + 1);
    const ext = `.${extOfDataUrl(p.dataUrl)}`;
    const stem = slug
      ? photos.length > 1
        ? `${slug}-${i}`
        : slug
      : `anh-nhan-${stamp}-${i}`;
    const saved = await writeUnique(userDir, stem, ext, Buffer.from(b64, "base64"));
    if (saved) out.push(saved);
  }
  return out;
}

/** Tên file an toàn từ tên gốc người dùng gửi (giữ đuôi, bỏ ký tự lạ). */
export function safeDocName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "file";
  const safe = base.replace(/[^a-zA-Z0-9à-ỹÀ-Ỹ._ -]/g, "_").trim().slice(0, 100);
  return safe && safe !== "." && safe !== ".." ? safe : "file";
}

/**
 * Lưu document inbound (PDF/Word/Excel...). Tên file = slug chuẩn ASCII:
 * 1 file + có caption → slug theo caption; còn lại slug hóa tên gốc
 * ("Bảng Giá (v2).XLSX" → "bang-gia-v2.xlsx"). Trùng tên → hậu tố -2.
 */
export async function saveInboundDocs(
  userDir: string,
  docs: InboundMedia[],
  caption?: string,
): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  if (!docs.length) return out;
  await mkdir(userDir, { recursive: true });
  const captionSlug = docs.length === 1 ? slugFromCaption(caption) : "";
  for (const d of docs) {
    if (!d.dataB64) continue;
    const base = safeDocName(d.name ?? "file");
    const dot = base.lastIndexOf(".");
    const origStem = dot > 0 ? base.slice(0, dot) : base;
    const ext = (dot > 0 ? base.slice(dot) : "").toLowerCase();
    const stem = captionSlug || slugFromCaption(origStem, 8) || "file";
    const saved = await writeUnique(userDir, stem, ext, Buffer.from(d.dataB64, "base64"));
    if (saved) out.push(saved);
  }
  return out;
}

/** Đọc lại các ảnh gần nhất của session thành data URL cho vision. */
async function recentImagesAsDataUrls(sessionId: string): Promise<string[]> {
  const list = recentImages.get(sessionId) ?? [];
  const out: string[] = [];
  for (const img of list.slice(-RECENT_IMAGES_MAX)) {
    try {
      const buf = await readFile(img.path);
      const ext = img.name.split(".").pop() ?? "jpg";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      out.push(`data:${mime};base64,${buf.toString("base64")}`);
    } catch {
      // file đã bị xóa → bỏ qua
    }
  }
  return out;
}

/**
 * Đuôi file được TỰ ĐỘNG gửi cho người dùng khi agent tạo ra trong lượt chat.
 * Người dùng bảo "tạo file X" là muốn nhận file, không muốn phải xin thêm lần
 * nữa. Script trung gian (.py/.js/.sh...) cố ý KHÔNG nằm trong danh sách.
 */
const AUTO_SEND_EXT = new Set([
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "rtf", "odt", "ods", "odp",
  "csv", "txt", "md", "json", "xml", "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
  "mp3", "wav", "ogg", "m4a", "mp4", "mov", "webm",
  "zip", "rar", "7z", "tar", "gz",
]);

/** File hệ thống của agent — không bao giờ tự gửi. */
const NEVER_AUTO_SEND = new Set(["user.md", "agent.md"]);

const AUTO_SEND_MAX_FILES = 5;
const AUTO_SEND_MAX_BYTES = 45 * 1024 * 1024;

/** Ảnh chụp trạng thái file trong thư mục làm việc: path → "mtime:size". */
export async function snapshotWorkDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4 || out.size > 2000) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "__pycache__" || e.name === "node_modules") {
        continue;
      }
      const full = resolve(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const info = await stat(full).catch(() => null);
        if (info) out.set(full, `${info.mtimeMs}:${info.size}`);
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** File mới tạo hoặc vừa sửa trong lượt chat, đáng gửi cho người dùng. */
export async function newDeliverables(
  dir: string,
  before: Map<string, string>,
): Promise<string[]> {
  const after = await snapshotWorkDir(dir);
  const changed: Array<{ path: string; mtime: number }> = [];
  for (const [path, sig] of after) {
    if (before.get(path) === sig) continue;
    const name = path.split(/[\\/]/).pop() ?? "";
    if (NEVER_AUTO_SEND.has(name.toLowerCase())) continue;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (!AUTO_SEND_EXT.has(ext)) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > AUTO_SEND_MAX_BYTES) continue;
    changed.push({ path, mtime: info.mtimeMs });
  }
  // file mới nhất trước, giới hạn số lượng để không spam
  return changed
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, AUTO_SEND_MAX_FILES)
    .map((c) => c.path);
}

/** Chống spam: 1 mã ghép nối / người gửi / 60 giây. */
const pairingDebounce = new Map<string, number>();
const PAIRING_DEBOUNCE_MS = 60_000;

/**
 * Nhóm Zalo demo: người dùng hay nhắn vài tin liên tiếp rồi mới tag bot.
 * Các tin chưa tag bị gate mention bỏ qua sẽ được đệm lại ở đây; khi có tin
 * tag bot, các tin liền trước của CÙNG người gửi trong cửa sổ thời gian được
 * nối vào làm ngữ cảnh để agent hiểu trọn ý.
 */
const groupChatter = new Map<
  string,
  Array<{ senderId: string; text: string; at: number }>
>();
const CHATTER_MAX = 10;
const CHATTER_WINDOW_MS = 60_000;

/** Ghép các tin liền trước (cùng người gửi, còn trong cửa sổ) vào tin được tag. */
export function joinGroupChatter(
  chatterKey: string,
  senderId: string,
  senderName: string | undefined,
  text: string,
  now = Date.now(),
): string {
  const list = groupChatter.get(chatterKey) ?? [];
  const prior = list.filter(
    (e) => e.senderId === senderId && now - e.at <= CHATTER_WINDOW_MS,
  );
  // dọn: bỏ tin đã dùng + tin quá hạn của mọi người
  const rest = list.filter(
    (e) => !prior.includes(e) && now - e.at <= CHATTER_WINDOW_MS,
  );
  if (rest.length) groupChatter.set(chatterKey, rest);
  else groupChatter.delete(chatterKey);
  if (!prior.length) return text;
  return (
    `[Ngữ cảnh — các tin nhắn liền trước của ${senderName ?? "người gửi"} trong nhóm, chưa được trả lời]\n` +
    prior.map((e) => `• ${e.text}`).join("\n") +
    `\n\n[Tin nhắn hiện tại — người gửi tag bạn, hãy trả lời trọn ý các tin trên]\n` +
    text
  );
}

/** Đệm 1 tin nhóm chưa tag (gọi cả khi orchestrator tiêu thụ tin đó). */
export function bufferGroupChatter(
  chatterKey: string,
  senderId: string,
  text: string,
  now = Date.now(),
): void {
  if (!text.trim()) return;
  const list = (groupChatter.get(chatterKey) ?? []).filter(
    (e) => now - e.at <= CHATTER_WINDOW_MS,
  );
  list.push({ senderId, text: text.slice(0, 1000), at: now });
  groupChatter.set(chatterKey, list.slice(-CHATTER_MAX));
}

/** Map tên tool → trạng thái reaction (đang chạy code / truy cập web / dùng tool). */
function toolReactionStatus(toolName: string): AgentStatus {
  if (toolName.startsWith("web") || toolName === "browser") return "web";
  if (toolName === "exec") return "coding";
  return "tool";
}

/** Ghép nội dung media vào user message cho LLM (ảnh ghi rõ tên file đã lưu). */
export function mergeMediaText(
  text: string,
  media: InboundMedia[] | undefined,
  savedImageNames: string[] = [],
  savedDocNames: string[] = [],
): string {
  if (!media?.length) return text;
  const parts: string[] = [];
  let photoIdx = 0;
  let docIdx = 0;
  for (const m of media) {
    if (m.text !== undefined) {
      const saved = m.dataB64 ? savedDocNames[docIdx++] : undefined;
      parts.push(
        `[Nội dung file "${m.name ?? "đính kèm"}"${saved ? ` — đã lưu tại: ${saved}` : ""}]:\n${m.text}`,
      );
    } else if (m.kind === "document" && m.dataB64) {
      const saved = savedDocNames[docIdx++];
      parts.push(
        saved
          ? `[Người dùng gửi file, đã lưu tại: ${saved} — đọc nội dung bằng tool read_document]`
          : `[Người dùng gửi file "${m.name ?? "?"}" nhưng lưu thất bại]`,
      );
    } else if (m.note) {
      parts.push(m.note);
    } else if (m.kind === "photo" && m.dataUrl) {
      const name = savedImageNames[photoIdx++];
      parts.push(
        name
          ? `[Người dùng gửi kèm ảnh, đã lưu tại: ${name}]`
          : "[Người dùng gửi kèm 1 ảnh]",
      );
    }
  }
  return [text, ...parts].filter(Boolean).join("\n\n");
}

/** Xây handler xử lý inbound cho 1 channel cụ thể. */
function makeInboundHandler(
  rt: RuntimeDeps,
  queue: Scheduler,
  channel: EnabledChannel,
): InboundHandler {
  const { db } = rt.db;
  return async (msg, hooks?: RunHooks): Promise<InboundResult> => {
    const ctx = systemContext(channel.workspaceId);

    // Nhóm Zalo: đệm tin chưa tag làm ngữ cảnh (kể cả tin orchestrator sẽ
    // tiêu thụ) — người dùng hay nhắn vài tin liên tiếp rồi mới tag bot.
    const isZaloGroup =
      msg.peerKind === "group" && msg.channelKind === "zalo_personal";
    const chatterKey = `${channel.id}:${msg.chatKey}`;
    if (isZaloGroup && msg.mentioned === false) {
      bufferGroupChatter(chatterKey, msg.senderId, msg.text);
    }

    // Interceptor (bộ điều phối quy trình...): chạy TRƯỚC pairing/agent — phản hồi
    // của đại lý trong nhóm demo phải tới orchestrator dù người gửi chưa pair.
    for (const interceptor of inboundInterceptors) {
      try {
        const res = await interceptor(msg);
        if (res) return res;
      } catch (err) {
        logger.warn(`Interceptor inbound lỗi: ${(err as Error).message}`);
      }
    }

    // Group Zalo: adapter pass-through mọi tin (kèm cờ mentioned) để
    // orchestrator thấy hết; agent MẶC ĐỊNH chỉ trả lời khi được tag/reply
    // (31/08/2026 — user chốt). Muốn bot trả lời mọi tin trong nhóm demo
    // (kiểu hội thoại nhóm tự nhiên) thì đặt rõ config require_mention: false.
    if (
      msg.peerKind === "group" &&
      msg.channelKind === "zalo_personal" &&
      channel.config["require_mention"] !== false &&
      msg.mentioned === false
    ) {
      return { kind: "ignore" };
    }

    // Ghi contact TRƯỚC cổng pairing để danh sách chờ duyệt có tên hiển thị
    // (chỉ metadata tên + id — người lạ chưa duyệt cũng cần nhận diện được).
    const channelIdentity = await upsertContact(db, ctx, {
      channelId: channel.id,
      channelKind: channel.kind,
      externalId: msg.senderId,
      ...(msg.senderName ? { displayName: msg.senderName } : {}),
    }).catch((err) =>
      (logger.warn(`upsertContact (pre-pairing) lỗi: ${(err as Error).message}`), undefined),
    );

    // Gate pairing (fail-closed): DM lạ chưa duyệt → cấp mã, chờ admin duyệt
    if (channel.requirePairing) {
      const paired = await isPaired(db, ctx, channel.id, msg.senderId);
      if (!paired) {
        // Người lạ nhắn liên tục: không tạo mã mới mỗi tin (phình bảng
        // channel_pairings + admin thấy hàng loạt mã khác nhau cho 1 người).
        const debounceKey = `${channel.id}:${msg.senderId}`;
        const last = pairingDebounce.get(debounceKey) ?? 0;
        if (Date.now() - last < PAIRING_DEBOUNCE_MS) {
          return { kind: "ignore" };
        }
        pairingDebounce.set(debounceKey, Date.now());
        const code = genPairingCode();
        await createPairing(db, ctx, channel.id, code, msg.senderId);
        return {
          kind: "pairing",
          text:
            `👋 Xin chào! Bạn cần được duyệt trước khi dùng trợ lý này.\n` +
            `Mã ghép nối của bạn: *${code}*\n` +
            `Vui lòng gửi mã này cho quản trị viên để được duyệt.`,
        };
      }
    }

    const conversationId = await upsertConversation(db, ctx, {
      channelId: channel.id,
      externalChatId: msg.chatKey,
      peerKind: msg.peerKind === "group" ? "group" : "direct",
      title: msg.senderName ?? msg.chatKey,
    }).catch((err) =>
      (logger.warn(`upsertConversation lỗi: ${(err as Error).message}`), undefined),
    );

    // Resolve/tạo session cho hội thoại này
    let sessionId = await getChannelSession(db, ctx, channel.id, msg.chatKey);
    if (!sessionId) {
      const s = await createSession(db, ctx, {
        agentId: channel.agentId,
        title: `${channel.kind}:${msg.senderName ?? msg.chatKey}`,
      });
      await mapChannelSession(db, ctx, channel.id, msg.chatKey, s.id);
      sessionId = s.id;
    }

    // Bot commands (/stop /reset /new /status /help)
    const cmd = msg.text.trim().toLowerCase().split("@")[0];
    if (cmd === "/help" || cmd === "/start") {
      // Không hardcode lời giới thiệu (mỗi bot một vai khác nhau) — biến thành
      // câu hỏi để chính agent tự giới thiệu theo system prompt của nó.
      // Không return: pairing gate phía dưới vẫn áp dụng cho người lạ.
      msg.text =
        "Xin chào! Bạn tên gì, vai trò của bạn là gì? Hãy giới thiệu ngắn gọn " +
        "bạn có thể giúp tôi những việc gì (kèm 2-3 ví dụ cụ thể), và nhắc tôi " +
        "các lệnh: /new (cuộc mới), /reset (xóa lịch sử), /stop (dừng trả lời), /status, /help.";
    }
    if (cmd === "/status") {
      return { kind: "reply", text: "✅ Đang hoạt động. Agent: " + channel.name };
    }
    if (cmd === "/stop") {
      const ac = activeRuns.get(sessionId);
      if (ac) {
        ac.abort();
        return { kind: "reply", text: "⏹ Đã dừng câu trả lời đang chạy." };
      }
      return { kind: "reply", text: "Không có câu trả lời nào đang chạy." };
    }
    if (cmd === "/new" || cmd === "/reset") {
      const s = await createSession(db, ctx, { agentId: channel.agentId, title: `${channel.kind}:${msg.senderName ?? msg.chatKey}` });
      await mapChannelSession(db, ctx, channel.id, msg.chatKey, s.id);
      return { kind: "reply", text: "🆕 Đã bắt đầu cuộc trò chuyện mới." };
    }

    const agent = await getAgentById(db, ctx, channel.agentId);
    if (!agent) return { kind: "reply", text: "⚠️ Agent chưa được cấu hình." };

    const userKey = `${channel.kind}-${msg.senderId}`;
    const wsDirEarly = resolve(join(rt.config.dataDir, ctx.workspaceId));
    const userDirEarly = resolve(join(wsDirEarly, "users", sanitizeUserKey(userKey)));

    // Lưu ảnh + document inbound thành file (tham chiếu lại được ở các lượt
    // sau). Caption/tin nhắn kèm theo → đặt tên file slug dễ hiểu.
    const photos = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl);
    const savedImages = await saveInboundImages(userDirEarly, photos, msg.text);
    if (savedImages.length) {
      const list = [...(recentImages.get(sessionId) ?? []), ...savedImages];
      recentImages.set(sessionId, list.slice(-RECENT_IMAGES_MAX));
    }
    const inboundDocs = (msg.media ?? []).filter(
      (m) => m.kind === "document" && m.dataB64,
    );
    const savedDocs = await saveInboundDocs(userDirEarly, inboundDocs, msg.text);

    // Chỉ gửi ảnh/file, chưa có yêu cầu → lưu + xác nhận ngắn, KHÔNG chạy LLM.
    // (Thói quen phổ biến: gửi 3-5 ảnh / vài file trước rồi mới nhắn yêu cầu.)
    const hasSubstance =
      msg.text.trim().length > 0 ||
      (msg.media ?? []).some((m) => m.text !== undefined || m.note);
    const savedAll = [...savedImages, ...savedDocs];
    if (!hasSubstance && savedAll.length) {
      await appendMessage(db, ctx, sessionId, {
        role: "user",
        content: {
          kind: "text",
          text: `[Đã gửi ${savedAll.length} file: ${savedAll.map((s) => s.name).join(", ")}]`,
        },
      }).catch(() => {});
      const streak = (imageOnlyStreak.get(sessionId) ?? 0) + 1;
      imageOnlyStreak.set(sessionId, streak);
      // Báo rõ TÊN FILE đã lưu để người dùng (và agent ở các lượt sau) tham chiếu
      const what = savedAll.map((s) => s.name).join(", ");
      if (streak === 1) {
        const hint = savedDocs.length
          ? `Ví dụ: "tóm tắt file này", "phân tích số liệu", "dựa vào file lên plan"...`
          : `Ví dụ: "làm hình sản phẩm từ ảnh này", "tạo banner", "đọc chữ trên nhãn"...\nMẹo: gửi ảnh kèm caption (vd "logo công ty") để file được đặt tên theo caption.`;
        return {
          kind: "reply",
          text: `📎 Đã lưu: ${what}. Bạn muốn làm gì với chúng?\n${hint}`,
        };
      }
      return {
        kind: "reply",
        text: `📎 Đã lưu thêm: ${what}. Nhắn yêu cầu khi bạn sẵn sàng nhé.`,
      };
    }
    imageOnlyStreak.delete(sessionId);

    // File agent muốn gửi: từ tool send_file (đã kiểm tra) và từ marker
    // [[media:...]] trong kết quả tool (chưa kiểm tra — xác minh sau vòng lặp).
    const mediaOut: string[] = [];
    const pendingMedia: string[] = [];
    // Agent đã CHỦ ĐỘNG chọn file gửi (send_file) → các nguồn auto (marker,
    // file mới sinh) chỉ là sản phẩm trung gian (ảnh nền chưa ghép chữ, .json
    // sinh ra giữa pipeline...) — không gửi kèm nữa.
    let explicitAttach = false;
    // Agent đã gửi thẻ duyệt trong lượt này → final rỗng là hợp lệ, đừng thay
    // bằng placeholder "(không có nội dung)".
    let cardSent = false;
    const loopDeps = await buildLoopDeps(rt, ctx, agent.provider, {
      ...agentOpts(agent),
      autoApproveExec: false,
      // Thư mục làm việc riêng theo người gửi trên kênh (không đọc file của nhau)
      userKey,
      ...(channelIdentity ? {
        principalId: channelIdentity.principalId,
        channelIdentityId: channelIdentity.contactId,
      } : {}),
      ...(conversationId ? { conversationId } : {}),
      // Hồ sơ contact + chỉ dẫn của quản trị viên cho người đang chat
      person: { channelKind: channel.kind, peerKind: msg.peerKind === "group" ? "group" : "direct" },
      sourceKind: "channel",
      accessRole: null,
      attachFile: (p) => {
        explicitAttach = true;
        if (!mediaOut.includes(p)) mediaOut.push(p);
      },
      // Thẻ duyệt có nút bấm (tool send_approval_card) — chỉ kênh hỗ trợ nút
      ...(channel.kind === "msteams" || channel.kind === "telegram"
        ? {
            approvalCard: async (input: {
              text: string;
              buttons: Array<{ label: string; value: string }>;
            }) => {
              const adapter = channelHandlers.get(channel.id)?.channel;
              if (!(adapter instanceof TeamsChannel) && !(adapter instanceof TelegramChannel)) {
                throw new Error("Kênh chưa sẵn sàng gửi thẻ nút bấm");
              }
              const cardId = await sendApprovalCard(
                adapter,
                channel.id,
                msg.chatKey,
                msg.peerKind,
                input,
              );
              cardSent = true;
              return cardId;
            },
          }
        : {}),
    });

    // Chụp trạng thái thư mục trước khi chạy để biết file nào MỚI sinh ra
    const wsDir = wsDirEarly;
    const userDir = userDirEarly;
    const filesBefore = await snapshotWorkDir(userDir);

    hooks?.onStatus?.("queued");
    // Tin được tag trong nhóm Zalo: nối các tin liền trước của cùng người gửi
    // (trong 60 giây) để agent trả lời trọn ý, không chỉ câu cuối.
    const inboundText =
      isZaloGroup && msg.mentioned
        ? joinGroupChatter(chatterKey, msg.senderId, msg.senderName, msg.text)
        : msg.text;
    const userMessage = mergeMediaText(
      inboundText,
      msg.media,
      savedImages.map((s) => s.name),
      savedDocs.map((s) => s.name),
    );
    // Vision = ảnh lượt này + các ảnh gần đây của session (đọc lại từ đĩa) —
    // người dùng gửi ảnh trước, nhắn yêu cầu sau thì model vẫn "nhìn thấy" ảnh.
    let userImages = await recentImagesAsDataUrls(sessionId);
    if (!userImages.length && photos.length) {
      userImages = photos.map((m) => m.dataUrl!);
    }

    // Đăng ký TRƯỚC khi vào hàng đợi: /stop lúc run còn đang xếp hàng vẫn hủy
    // được (nếu chỉ đăng ký khi bắt đầu chạy thì /stop báo "không có gì chạy"
    // rồi run vẫn chạy sau đó).
    const ac = new AbortController();
    activeRuns.set(sessionId, ac);
    // Trace: moi luot chay tren kenh chat deu phai ghi (truoc 0025 khong ghi gi)
    const traceStart = Date.now();
    let traceUsage = { inputTokens: 0, outputTokens: 0 };
    let traceIterations = 0;
    let traceError: string | null = null;
    // Trace: ghi cho MOI luot chay tren kenh chat, KE CA luot loi (truoc 26/09/2026
    // luot loi throw truoc buoc ghi nen admin khong thay loi, phai doc log may chu).
    const writeTrace = () =>
      recordTraceSafe(db, ctx, {
        agentId: agent.id,
        sessionId: sessionId!,
        inputTokens: traceUsage.inputTokens,
        outputTokens: traceUsage.outputTokens,
        iterations: traceIterations,
        durationMs: Date.now() - traceStart,
        source: "channel",
        model: agent.model,
        provider: agent.provider,
        kind: channel.kind,
        ...(traceError ? { error: String(traceError).slice(0, 500) } : {}),
      });
    const finalText = await queue.schedule("main", async () => {
      if (ac.signal.aborted) return "";
      hooks?.onStatus?.("thinking");
      try {
        let streamed = "";
        let sinceTool = ""; // text từ sau tool gần nhất — thành block reply nếu có tool tiếp
        let done = "";
        for await (const ev of runAgent(loopDeps, {
          ctx,
          agent: {
            systemPrompt: agent.systemPrompt,
            model: agent.model,
            maxIterations: agent.maxIterations,
            ...(reasoningEffortOf(agent)
              ? { reasoningEffort: reasoningEffortOf(agent)! }
              : {}),
          },
          sessionId: sessionId!,
          userMessage,
          ...(userImages.length ? { userImages } : {}),
          signal: ac.signal,
        })) {
          if (ev.type === "text_delta") {
            streamed += ev.text;
            sinceTool += ev.text;
            hooks?.onTextDelta?.(ev.text);
          } else if (ev.type === "tool_call") {
            // câu dẫn trước tool ("Để em kiểm tra...") → bubble riêng
            const block = sinceTool.replace(MEDIA_MARKER_RE, "").trim();
            if (block) hooks?.onBlockReply?.(block);
            sinceTool = "";
            hooks?.onStatus?.(toolReactionStatus(ev.name));
          } else if (ev.type === "tool_result") {
            // Gom media do tool tạo ([[media:path]]). Marker này có thể đến từ
            // custom tool / MCP server (nội dung không kiểm soát) nên PHẢI xác
            // minh nằm trong vùng dữ liệu trước khi gửi ra ngoài.
            for (const m of ev.result.matchAll(/\[\[media:([^\]]+)\]\]/g)) {
              const raw = m[1]?.trim();
              if (!raw) continue;
              pendingMedia.push(raw);
            }
          } else if (ev.type === "done") {
            done = ev.finalText || sinceTool || streamed;
            traceUsage = ev.usage;
            traceIterations = ev.iterations;
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
        return done;
      } finally {
        activeRuns.delete(sessionId!);
      }
    }, sessionId)
      .finally(() => activeRuns.delete(sessionId!))
      .catch((err: unknown) => {
        traceError = err instanceof Error ? err.message : String(err);
        writeTrace();
        throw err;
      });

    hooks?.onStatus?.("done");
    writeTrace();

    // Xác minh file từ marker: phải nằm trong thư mục riêng của chính người
    // dùng này hoặc vùng dùng chung, và không vượt jail qua symlink.
    // Bỏ qua toàn bộ khi agent đã send_file — chỉ gửi đúng file được chỉ định.
    if (pendingMedia.length && !explicitAttach) {
      const roots = [userDir, resolve(join(wsDir, "shared"))];
      for (const raw of pendingMedia) {
        const safe = await confineMediaPath(raw, roots);
        if (!safe) {
          logger.warn(`Bỏ qua media ngoài vùng dữ liệu: ${raw}`);
          continue;
        }
        const info = await stat(safe).catch(() => null);
        if (!info?.isFile() || info.size > 45 * 1024 * 1024) continue;
        if (!mediaOut.includes(safe)) mediaOut.push(safe);
      }
    }

    // Tự động gửi file agent vừa tạo trong lượt này — CHỈ khi model quên gọi
    // send_file (người dùng bảo "tạo file X" là muốn nhận file luôn). Nếu đã
    // send_file thì agent tự quyết file nào là thành phẩm, không auto gửi thêm.
    if (!explicitAttach) {
      for (const p of await newDeliverables(userDir, filesBefore)) {
        if (!mediaOut.includes(p)) mediaOut.push(p);
      }
    }

    // model có thể lặp lại marker trong câu trả lời — gỡ đi
    const cleanText = finalText.replace(MEDIA_MARKER_RE, "").trim();
    return {
      kind: "reply",
      // Đã có media hoặc thẻ duyệt gửi đi → final rỗng là hợp lệ (nội dung nằm
      // trong thẻ/file), không chèn placeholder gây bubble "(không có nội dung)".
      text: cleanText || (mediaOut.length || cardSent ? "" : "(không có nội dung)"),
      ...(mediaOut.length ? { media: mediaOut } : {}),
    };
  };
}

/**
 * Nạp mọi channel enabled từ DB, giải mã token, khởi động.
 * Trả về manager để server stop khi shutdown.
 */
/** Tạo (chưa start) 1 channel từ row DB. Trả null nếu thiếu điều kiện. */
function buildChannel(
  rt: RuntimeDeps,
  queue: Scheduler,
  manager: ChannelManager,
  ch: EnabledChannel,
): Channel | null {
  if (!isChannelKindSupported(ch.kind)) {
    logger.warn(`Bỏ qua channel "${ch.name}" — kind chưa hỗ trợ: ${ch.kind}`);
    return null;
  }
  if (!ch.tokenEncrypted && ch.kind !== "zalo_personal") {
    logger.warn(`Bỏ qua channel "${ch.name}" — thiếu token`);
    return null;
  }
  let token: string;
  try {
    token = ch.tokenEncrypted ? decryptSecret(ch.tokenEncrypted) : "";
  } catch (err) {
    logger.warn(`Channel "${ch.name}": giải mã token lỗi (${(err as Error).message})`);
    return null;
  }
  try {
    const handler = makeInboundHandler(rt, queue, ch);
    const channel = manager.add(ch.kind, {
      id: ch.id,
      name: ch.name,
      token,
      config: ch.config,
      requirePairing: ch.requirePairing,
      onInbound: handler,
      onCallback: async (cb) => {
        for (const cbHandler of channelCallbackHandlers) {
          try {
            const res = await cbHandler(cb);
            if (res) return res;
          } catch (err) {
            logger.warn(`Callback handler lỗi: ${(err as Error).message}`);
          }
        }
        return undefined;
      },
      onError: (e) => logger.error(`Channel "${ch.name}" lỗi: ${e.message}`),
      onSecretChanged: async (secret) => {
        await updateChannel(rt.db.db, systemContext(ch.workspaceId), ch.id, {
          tokenEncrypted: encryptSecret(secret),
        });
      },
      // Zalo Personal: persist danh sách quan sát vào DB — danh sách chờ duyệt
      // (tên + uid, nhóm/cá nhân) sống qua restart. Fire-and-forget, lỗi chỉ log.
      onObserved: (peer) => {
        void upsertZaloObservedPeer(
          rt.db.db,
          systemContext(ch.workspaceId),
          ch.id,
          peer,
        ).catch((err) =>
          logger.warn(`zalo.observed_persist lỗi: ${(err as Error).message}`),
        );
      },
    });
    channelHandlers.set(ch.id, { handler, channel, workspaceId: ch.workspaceId });
    return channel;
  } catch (err) {
    logger.warn(`Không tạo được channel "${ch.name}": ${(err as Error).message}`);
    return null;
  }
}

/** Trạng thái runtime để sửa channel áp dụng NGAY, không cần restart server. */
let live: { rt: RuntimeDeps; queue: Scheduler; manager: ChannelManager } | null = null;

/**
 * Chạy 1 việc trên ĐÚNG hàng đợi session của channels. Luồng ngoài (vd chào
 * mừng sau duyệt pairing trong app.ts) phải dùng hàm này thay vì queue riêng —
 * 2 queue khác nhau từng cho 2 lượt agent chạy song song cùng session, sinh
 * 2 tin chào mừng gần trùng khi provider chậm (antigravity ~30s/lượt).
 */
export function scheduleOnChannelQueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (live) return live.queue.schedule("main", fn, sessionId);
  return fn();
}

/**
 * Áp dụng thay đổi cho 1 channel đang chạy: dừng bản cũ, khởi động bản mới
 * theo row DB hiện tại (enabled=false hoặc row=null → chỉ dừng).
 * Trả ghi chú kết quả cho UI hiển thị.
 */
export async function applyChannelChange(
  channelId: string,
  row: EnabledChannel | null,
): Promise<string> {
  if (!live) return "Đã lưu — restart server (pnpm start) để áp dụng.";
  await live.manager.remove(channelId);
  channelHandlers.delete(channelId);
  if (!row) return "Đã dừng channel.";
  const channel = buildChannel(live.rt, live.queue, live.manager, row);
  if (!channel) {
    return "Đã lưu nhưng channel KHÔNG khởi động được (thiếu token hoặc kind chưa hỗ trợ) — xem log server.";
  }
  try {
    await channel.start();
    return "Đã lưu và khởi động lại channel — áp dụng ngay.";
  } catch (err) {
    return `Đã lưu nhưng khởi động lỗi: ${(err as Error).message}`;
  }
}

export async function startChannels(rt: RuntimeDeps): Promise<ChannelManager> {
  const manager = new ChannelManager();
  // Lane "main": trần số lượt agent chạy đồng thời trên mọi
  // channel — nhiều người nhắn cùng lúc thì xếp hàng thay vì bóp nghẹt VPS/LLM.
  // Cùng session vẫn tuần tự (KeyedQueue bên trong Scheduler).
  const queue = new Scheduler({
    main: Math.max(1, Number(process.env.PENAI_LANE_MAIN) || 8),
  });
  live = { rt, queue, manager };
  let started = 0;

  let list: EnabledChannel[] = [];
  try {
    list = await listEnabledChannels(rt.db.db);
  } catch (err) {
    logger.warn(`Không đọc được danh sách channel: ${(err as Error).message}`);
    return manager;
  }

  for (const ch of list) {
    if (buildChannel(rt, queue, manager, ch)) started++;
  }

  await manager.startAll();
  if (started > 0) logger.info(`Đã khởi động ${started} channel`);
  return manager;
}
