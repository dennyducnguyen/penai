/**
 * Chat web (Dashboard) ngang hàng kênh Telegram về FILE:
 *   - Người dùng đính kèm ảnh/tài liệu → lưu vào thư mục riêng `users/web-<userId>`
 *     (ảnh → vision + refImages cho tạo ảnh; tài liệu → read_document; text nhỏ inline).
 *   - Agent trả file (send_file / marker [[media:]] / file mới sinh) → sự kiện SSE
 *     `file` + lưu marker [[files:…]] vào lịch sử để mở lại vẫn thấy.
 *   - Route tải file có xác thực, giới hạn trong thư mục của chính người dùng
 *     (+ shared; ws_admin/operator xem được cả workspace).
 *
 * Dùng lại saveInboundImages/saveInboundDocs/mergeMediaText/newDeliverables của
 * channels-runtime để hành vi giống Telegram (tên file slug theo caption, chống
 * trùng, ack "đã lưu" khi chỉ gửi file chưa có yêu cầu).
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceContext } from "@penai/shared";
import type { InboundMedia } from "@penai/channels";
import { assertRealPathInside, confineMediaPath } from "@penai/tools";
import { contentTypeOf, sanitizeUserKey } from "./agent-runtime.js";
import {
  mergeMediaText,
  newDeliverables,
  saveInboundDocs,
  saveInboundImages,
  snapshotWorkDir,
} from "./channels-runtime.js";

export const WEB_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const WEB_FILES_MAX = 10;
const DOC_TEXT_MAX_BYTES = 200 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|toml|log|html?|js|ts|py|sql)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const RECENT_IMAGES_MAX = 5;
/** Ảnh gần nhất theo session (in-memory) — người dùng gửi ảnh trước, hỏi sau vẫn "nhìn thấy". */
const recentImages = new Map<string, Array<{ name: string; path: string }>>();

export interface WebAttachmentIn {
  name: string;
  contentB64: string;
  mime?: string;
}

export interface WebFileOut {
  /** tên hiển thị */
  name: string;
  /** tham số `p` cho GET /v1/chat/files */
  p: string;
  size: number;
  mime: string;
  isImage: boolean;
}

export function webUserKey(ctx: WorkspaceContext): string {
  return `web-${ctx.userId}`;
}

export function webDirs(dataDir: string, ctx: WorkspaceContext) {
  const wsDir = resolve(join(dataDir, ctx.workspaceId));
  const userDir = resolve(join(wsDir, "users", sanitizeUserKey(webUserKey(ctx))));
  const sharedDir = resolve(join(wsDir, "shared"));
  return { wsDir, userDir, sharedDir };
}

/** Chuẩn hóa file đính kèm từ web thành InboundMedia (giống adapter Telegram). */
export function toInboundMedia(files: WebAttachmentIn[]): InboundMedia[] {
  const out: InboundMedia[] = [];
  for (const f of files.slice(0, WEB_FILES_MAX)) {
    const name = basename(f.name || "file").slice(0, 120) || "file";
    const buf = Buffer.from(f.contentB64 || "", "base64");
    if (!buf.length) continue;
    if (buf.length > WEB_FILE_MAX_BYTES) {
      out.push({ kind: "document", name, note: `[File "${name}" bị bỏ qua: vượt 100MB]` });
      continue;
    }
    const mime = (f.mime || "").toLowerCase();
    const isImage = mime.startsWith("image/") || IMAGE_EXT.test(name);
    if (isImage) {
      const m = mime.startsWith("image/") ? mime : `image/${name.toLowerCase().endsWith(".png") ? "png" : name.toLowerCase().endsWith(".webp") ? "webp" : name.toLowerCase().endsWith(".gif") ? "gif" : "jpeg"}`;
      out.push({ kind: "photo", name, dataUrl: `data:${m};base64,${buf.toString("base64")}` });
      continue;
    }
    const isText = TEXT_EXT.test(name) || mime.startsWith("text/") || /json|xml|yaml|csv/.test(mime);
    if (isText && buf.length <= DOC_TEXT_MAX_BYTES) {
      out.push({ kind: "document", name, text: buf.toString("utf8"), dataB64: buf.toString("base64") });
      continue;
    }
    out.push({ kind: "document", name, dataB64: buf.toString("base64") });
  }
  return out;
}

export interface PreparedInbound {
  /** user message đã ghép ghi chú file (giống mergeMediaText của kênh) */
  userMessage: string;
  /** data URL ảnh cho vision (ảnh lượt này + ảnh gần đây của session) */
  userImages: string[];
  savedImages: Array<{ name: string; path: string }>;
  savedDocs: Array<{ name: string; path: string }>;
  /** file đã lưu, dạng trả về cho UI để hiện chip trong bong bóng người dùng */
  savedOut: WebFileOut[];
}

/** Lưu file đính kèm vào thư mục người dùng + dựng user message / vision. */
export async function prepareWebInbound(
  userDir: string,
  sessionId: string,
  text: string,
  files: WebAttachmentIn[],
): Promise<PreparedInbound> {
  const media = toInboundMedia(files);
  const photos = media.filter((m) => m.kind === "photo" && m.dataUrl);
  // Web luôn biết TÊN FILE GỐC (khác Telegram: ảnh không tên) → giữ tên gốc
  // (slug hóa, chống trùng) thay vì đặt theo caption. Thứ tự giữ nguyên theo
  // `photos` để khớp savedImageNames trong mergeMediaText.
  const savedImages = await saveInboundDocs(
    userDir,
    photos.map((m) => ({
      kind: "document" as const,
      name: m.name || `anh-${Date.now()}.png`,
      dataB64: m.dataUrl!.slice(m.dataUrl!.indexOf(",") + 1),
    })),
    "",
  );
  if (savedImages.length) {
    const list = [...(recentImages.get(sessionId) ?? []), ...savedImages];
    recentImages.set(sessionId, list.slice(-RECENT_IMAGES_MAX));
  }
  const docs = media.filter((m) => m.kind === "document" && m.dataB64);
  const savedDocs = await saveInboundDocs(userDir, docs, "");
  const userMessage = mergeMediaText(
    text,
    media,
    savedImages.map((s) => s.name),
    savedDocs.map((s) => s.name),
  );
  let userImages = await recentImagesAsDataUrls(sessionId);
  if (!userImages.length && photos.length) userImages = photos.map((m) => m.dataUrl!);
  const savedOut: WebFileOut[] = [];
  for (const s of [...savedImages, ...savedDocs]) {
    const info = await stat(s.path).catch(() => null);
    savedOut.push({
      name: s.name,
      p: s.name,
      size: info?.size ?? 0,
      mime: contentTypeOf(s.name),
      isImage: IMAGE_EXT.test(s.name),
    });
  }
  return { userMessage, userImages, savedImages, savedDocs, savedOut };
}

async function recentImagesAsDataUrls(sessionId: string): Promise<string[]> {
  const out: string[] = [];
  for (const img of (recentImages.get(sessionId) ?? []).slice(-RECENT_IMAGES_MAX)) {
    try {
      const buf = await readFile(img.path);
      out.push(`data:${contentTypeOf(img.name)};base64,${buf.toString("base64")}`);
    } catch {
      // đã xóa
    }
  }
  return out;
}

// ===== File agent trả ra =====

/** Bộ gom file trong 1 lượt chat: send_file (ưu tiên) → marker → file mới sinh. */
export function createOutboundCollector(userDir: string, sharedDir: string) {
  const mediaOut: string[] = [];
  const pendingMedia: string[] = [];
  let explicitAttach = false;
  let filesBefore: Map<string, string> = new Map();
  return {
    async begin() {
      filesBefore = await snapshotWorkDir(userDir);
    },
    attachFile(p: string) {
      explicitAttach = true;
      if (!mediaOut.includes(p)) mediaOut.push(p);
    },
    noteToolResult(result: string) {
      for (const m of result.matchAll(/\[\[media:([^\]]+)\]\]/g)) {
        const raw = m[1]?.trim();
        if (raw) pendingMedia.push(raw);
      }
    },
    async finish(): Promise<string[]> {
      if (pendingMedia.length && !explicitAttach) {
        for (const raw of pendingMedia) {
          const safe = await confineMediaPath(raw, [userDir, sharedDir]);
          if (!safe) continue;
          const info = await stat(safe).catch(() => null);
          if (!info?.isFile() || info.size > WEB_FILE_MAX_BYTES) continue;
          if (!mediaOut.includes(safe)) mediaOut.push(safe);
        }
      }
      if (!explicitAttach) {
        for (const p of await newDeliverables(userDir, filesBefore)) {
          if (!mediaOut.includes(p)) mediaOut.push(p);
        }
      }
      return mediaOut;
    },
  };
}

/** Đổi đường dẫn tuyệt đối → tham số `p` của route tải file (null nếu ngoài vùng cho phép). */
export function toFileParam(abs: string, dirs: { wsDir: string; userDir: string; sharedDir: string }): string | null {
  const a = resolve(abs);
  const inside = (root: string) => a === root || a.startsWith(root + sep);
  if (inside(dirs.userDir)) return relative(dirs.userDir, a).replaceAll(sep, "/");
  if (inside(dirs.sharedDir)) return "shared/" + relative(dirs.sharedDir, a).replaceAll(sep, "/");
  if (inside(dirs.wsDir)) return "ws/" + relative(dirs.wsDir, a).replaceAll(sep, "/");
  return null;
}

export async function describeOutbound(
  paths: string[],
  dirs: { wsDir: string; userDir: string; sharedDir: string },
): Promise<WebFileOut[]> {
  const out: WebFileOut[] = [];
  for (const abs of paths) {
    const p = toFileParam(abs, dirs);
    if (!p) continue;
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) continue;
    const name = basename(abs);
    out.push({ name, p, size: info.size, mime: contentTypeOf(name), isImage: IMAGE_EXT.test(name) });
  }
  return out;
}

/** Marker lưu trong lịch sử để UI dựng lại thẻ file khi mở phiên cũ. */
export function filesMarker(files: WebFileOut[]): string {
  return `[[files:${JSON.stringify(files.map((f) => ({ name: f.name, p: f.p, size: f.size, isImage: f.isImage })))}]]`;
}

/** Xác định file được phép tải theo `p` + quyền của người gọi. Trả đường dẫn tuyệt đối hoặc null. */
export async function resolveDownload(
  p: string,
  ctx: WorkspaceContext,
  dirs: { wsDir: string; userDir: string; sharedDir: string },
): Promise<string | null> {
  if (!p || p.includes("\0") || p.includes("..")) return null;
  const clean = p.replace(/^\/+/, "");
  let root: string;
  let rel: string;
  if (clean.startsWith("shared/")) {
    root = dirs.sharedDir;
    rel = clean.slice("shared/".length);
  } else if (clean.startsWith("ws/")) {
    if (ctx.role === "member" || ctx.role === "viewer") return null;
    root = dirs.wsDir;
    rel = clean.slice("ws/".length);
  } else {
    root = dirs.userDir;
    rel = clean;
  }
  const abs = resolve(join(root, rel));
  if (!(abs === root || abs.startsWith(root + sep))) return null;
  try {
    await assertRealPathInside(abs, [root], "vùng dữ liệu");
  } catch {
    return null;
  }
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) return null;
  return abs;
}

/** Gửi file về trình duyệt; html/svg/js ép tải về (chống XSS cùng origin). */
export async function sendDownload(req: FastifyRequest, reply: FastifyReply, abs: string): Promise<void> {
  const name = basename(abs);
  const mime = contentTypeOf(name);
  const risky = /\.(html?|svg|xml|js|mjs)$/i.test(name);
  const q = req.query as { dl?: string };
  const inline = !risky && (mime.startsWith("image/") || mime === "application/pdf") && q.dl !== "1";
  const buf = await readFile(abs);
  reply.header("content-type", risky ? "application/octet-stream" : mime);
  reply.header("content-length", String(buf.length));
  reply.header("cache-control", "private, max-age=300");
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  return reply.send(buf);
}
