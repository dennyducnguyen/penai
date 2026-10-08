import type { Channel } from "./types.js";
import type {
  ZaloObservedPeer,
  ZaloPersonalAccount,
  ZaloPersonalQrStatus,
  ZaloPersonalStatus,
  ZaloPersonalTarget,
  ZaloReactionKey,
  ZaloSendSource,
} from "./zalo-personal.js";

/** Loại kênh "tài khoản cá nhân" có Inbox trực chat + chế độ an toàn + đăng nhập bằng mã QR. */
export const PERSONAL_CHANNEL_KINDS = ["zalo_personal", "whatsapp_personal"] as const;
export type PersonalChannelKind = (typeof PERSONAL_CHANNEL_KINDS)[number];

export function isPersonalChannelKind(kind: string): kind is PersonalChannelKind {
  return (PERSONAL_CHANNEL_KINDS as readonly string[]).includes(kind);
}

/** Tên nền tảng để hiện cho người dùng. */
export const PERSONAL_PLATFORM_LABEL: Record<PersonalChannelKind, string> = {
  zalo_personal: "Zalo",
  whatsapp_personal: "WhatsApp",
};

export function personalPlatformLabel(kind: string): string {
  return isPersonalChannelKind(kind) ? PERSONAL_PLATFORM_LABEL[kind] : kind;
}

/**
 * Bề mặt chung của các kênh cá nhân (ZaloPersonalChannel, WhatsappPersonalChannel) —
 * Inbox, MCP server và trang Channels chỉ làm việc qua giao diện này.
 */
export interface PersonalChannel extends Channel {
  status(): ZaloPersonalStatus;
  isConnected(): boolean;
  accountInfo(): ZaloPersonalAccount | null;
  demoThreads(): string[];
  setDemoThreads(threads: string[]): void;
  listObserved(): ZaloObservedPeer[];
  startQrLogin(): Promise<{ id: string }>;
  qrStatus(id: string): (ZaloPersonalQrStatus & { pairingCode?: string | null }) | null;
  /** Chỉ WhatsApp: liên kết bằng mã 8 ký tự thay cho quét QR. */
  requestPairingCode?(loginId: string, phone: string): Promise<string>;
  logout(): Promise<void>;
  listTargets(): Promise<ZaloPersonalTarget[]>;
  syncContacts(): Promise<{ friends: number; groups: number }>;
  findUserByPhone(phone: string): Promise<{ uid: string; name: string; avatar: string } | null>;
  resolvePhone(phone: string): Promise<{ uid: string; name: string }>;
  lookupGroupName(threadId: string): Promise<string>;
  sendManual(input: {
    threadId: string;
    peerKind: "direct" | "group";
    text?: string;
    filePaths?: string[];
    source: ZaloSendSource;
    webUserId?: string;
    threadName?: string;
  }): Promise<string[]>;
  sendTestMessage(threadId: string, peerKind: "direct" | "group", text: string): Promise<void>;
  setAutoReaction(v: "heart" | "like" | null): void;
  getAutoReaction(): "heart" | "like" | null;
  react(input: {
    threadId: string;
    peerKind: "direct" | "group";
    msgId: string;
    cliMsgId: string;
    meta?: Record<string, unknown> | null;
    reaction: ZaloReactionKey;
    source: "web" | "auto" | "mcp";
    webUserId?: string;
  }): Promise<void>;
}

export function isPersonalChannel(ch: Channel | null | undefined): ch is PersonalChannel {
  return !!ch && isPersonalChannelKind(ch.kind) && typeof (ch as Partial<PersonalChannel>).sendManual === "function";
}

/** Mã hội thoại hợp lệ theo từng nền tảng (Zalo: số; WhatsApp: số điện thoại, "<số>@lid", "<id>@g.us"). */
export function isValidThreadId(kind: string, threadId: string): boolean {
  if (kind === "whatsapp_personal") {
    return /^\d{5,20}$/.test(threadId) || /^\d{5,25}@lid$/.test(threadId) || /^[0-9-]{5,40}@g\.us$/.test(threadId);
  }
  return /^\d{1,30}$/.test(threadId);
}
