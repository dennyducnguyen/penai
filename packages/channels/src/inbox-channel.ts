import type { Channel } from "./types.js";

/**
 * Kênh có Inbox trực chat: mọi tin đến/đi được lưu để nhân viên cùng xem, trả lời tay,
 * bật/tắt AI theo từng hội thoại. Gồm kênh tài khoản cá nhân (Zalo, WhatsApp — đăng nhập QR)
 * và kênh Trang Meta (Facebook Fanpage, Instagram Business — nối qua hub).
 */
export const INBOX_PLATFORM_LABEL: Record<string, string> = {
  zalo_personal: "Zalo",
  whatsapp_personal: "WhatsApp",
  facebook: "Facebook",
  instagram: "Instagram",
};

export const INBOX_CHANNEL_KINDS = Object.keys(INBOX_PLATFORM_LABEL);

export function isInboxChannelKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(INBOX_PLATFORM_LABEL, kind);
}

/** Tên nền tảng để hiện cho người dùng (Zalo, WhatsApp, Facebook, Instagram). */
export function inboxPlatformLabel(kind: string): string {
  return INBOX_PLATFORM_LABEL[kind] ?? kind;
}

export interface InboxAccount {
  id: string;
  name: string;
  avatar?: string;
  phone?: string;
}

/** Tính năng Inbox mà kênh hỗ trợ — giao diện ẩn nút không dùng được. */
export interface InboxCapabilities {
  /** Có hội thoại nhóm */
  groups: boolean;
  /** Tra người dùng theo số điện thoại */
  phoneLookup: boolean;
  /** Đồng bộ danh bạ (bạn bè + nhóm) */
  syncContacts: boolean;
  /** Thả cảm xúc vào tin */
  reactions: boolean;
  /** Chủ động nhắn cho người chưa từng nhắn tới */
  newConversation: boolean;
  /** Ứng dụng AI bên ngoài (MCP) đọc/gửi tin qua kênh này */
  mcp: boolean;
  /** Gửi file (không chỉ ảnh) từ Inbox */
  files: boolean;
  /** Cách xử lý khi khách chỉ gửi ảnh có tùy chọn "AI trả lời luôn" */
  photoAi: boolean;
  /** Có hội thoại bình luận bài viết (Fanpage / Instagram) */
  comments?: boolean;
}

export type InboxSendSource = "agent" | "web" | "mcp" | "api";

export interface InboxChannel extends Channel {
  isConnected(): boolean;
  accountInfo(): InboxAccount | null;
  /** Bỏ trống = kênh cá nhân (đủ mọi tính năng). */
  inboxCapabilities?(): InboxCapabilities;
  /** Gửi có chủ đích từ người trực (web), MCP, REST. Trả mã các tin đã gửi. */
  sendManual(input: {
    threadId: string;
    peerKind: "direct" | "group";
    text?: string;
    filePaths?: string[];
    source: InboxSendSource;
    webUserId?: string;
    threadName?: string;
    /** Hội thoại bình luận: trả lời công khai bình luận này, hoặc nhắn riêng người bình luận (private) */
    comment?: { id: string; private?: boolean };
  }): Promise<string[]>;
}

const PERSONAL_CAPS: InboxCapabilities = {
  groups: true,
  phoneLookup: true,
  syncContacts: true,
  reactions: true,
  newConversation: true,
  mcp: true,
  files: false,
  photoAi: false,
};

export function isInboxChannel(ch: Channel | null | undefined): ch is InboxChannel {
  return !!ch && isInboxChannelKind(ch.kind) && typeof (ch as Partial<InboxChannel>).sendManual === "function";
}

export function inboxCapabilitiesOf(ch: InboxChannel | null | undefined, kind?: string): InboxCapabilities {
  if (ch?.inboxCapabilities) return ch.inboxCapabilities();
  if (kind === "facebook" || kind === "instagram") {
    return { groups: false, phoneLookup: false, syncContacts: false, reactions: false, newConversation: false, mcp: false, files: true, photoAi: true, comments: true };
  }
  return PERSONAL_CAPS;
}
