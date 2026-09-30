/** Media đính kèm inbound đã chuẩn hóa. */
export interface InboundMedia {
  kind: "photo" | "document" | "voice" | "video";
  /** data URL base64 (ảnh) — cho provider vision. */
  dataUrl?: string;
  /** Text trích từ document (file text/json/csv...). */
  text?: string;
  /** Nội dung file gốc (base64) — runtime lưu thành file trong workspace. */
  dataB64?: string;
  name?: string;
  /** Ghi chú cho LLM khi media không xử lý được (quá to, chưa hỗ trợ...). */
  note?: string;
}

/** Tin nhắn vào từ một kênh, đã chuẩn hóa. */
export interface InboundMessage {
  channelId: string;
  channelKind: string;
  /** id hội thoại trên nền tảng (chat_id, có thể kèm topic/thread). */
  chatKey: string;
  /** id người gửi trên nền tảng. */
  senderId: string;
  senderName?: string;
  text: string;
  /** direct | group */
  peerKind: "direct" | "group";
  media?: InboundMedia[];
  /**
   * Group: người gửi có @mention/reply/lệnh nhắm vào bot không. Adapter set khi
   * pass-through mọi tin (zalo_personal) để runtime gate theo require_mention.
   */
  mentioned?: boolean;
}

/** Nút bấm inline (Telegram inline keyboard). data ≤ 64 byte theo giới hạn Telegram. */
export interface OutboundButton {
  text: string;
  data: string;
}

export interface OutboundMessage {
  chatKey: string;
  text: string;
  /** Đường dẫn file media (ảnh...) gửi kèm — adapter không hỗ trợ thì bỏ qua. */
  media?: string[];
  /** Hàng nút inline gắn vào tin nhắn — adapter không hỗ trợ thì bỏ qua. */
  buttons?: OutboundButton[][];
}

/** Sự kiện người dùng bấm nút inline trên một tin nhắn của bot. */
export interface ChannelCallback {
  channelId: string;
  channelKind: string;
  chatKey: string;
  senderId: string;
  senderName?: string;
  /** callback_data của nút được bấm. */
  data: string;
  /** id tin nhắn chứa nút (để edit thẻ sau khi xử lý). */
  messageId: string;
}

/** Kết quả xử lý callback — hiển thị toast/alert cho người bấm. */
export interface CallbackResult {
  text?: string;
  showAlert?: boolean;
}

/**
 * Trạng thái agent run — channel adapter dùng để hiển thị hiệu ứng
 * (reaction emoji, typing indicator).
 */
export type AgentStatus =
  | "queued"
  | "thinking"
  | "tool"
  | "coding"
  | "web"
  | "done"
  | "error";

/** Hook tiến trình run — runtime gọi, channel adapter hiển thị hiệu ứng. */
export interface RunHooks {
  onStatus?: (status: AgentStatus) => void;
  onTextDelta?: (delta: string) => void;
  /** Câu dẫn trước khi chạy tool ("Để em kiểm tra...") — bubble riêng. */
  onBlockReply?: (text: string) => void;
}

/** Kết quả xử lý 1 tin nhắn inbound, do runtime (server) trả về. */
export type InboundResult =
  | { kind: "reply"; text: string; media?: string[] }
  | { kind: "pairing"; text: string } // cần pairing — gửi hướng dẫn
  | { kind: "ignore" };

export type InboundHandler = (
  msg: InboundMessage,
  hooks?: RunHooks,
) => Promise<InboundResult>;

/** Giao diện chung mọi channel adapter phải implement. */
export interface Channel {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  isRunning(): boolean;
}

export interface ChannelDeps {
  id: string;
  name: string;
  token: string;
  config: Record<string, unknown>;
  requirePairing: boolean;
  /** Xử lý inbound (server inject): resolve session, chạy agent, trả text. */
  onInbound: InboundHandler;
  /** Xử lý bấm nút inline (nếu adapter hỗ trợ) — trả text hiển thị cho người bấm. */
  onCallback?: (cb: ChannelCallback) => Promise<CallbackResult | undefined | void>;
  onError?: (err: Error) => void;
  /** Lưu lại secret mới do adapter tạo (ví dụ credentials sau khi quét QR). */
  onSecretChanged?: (secret: string) => Promise<void>;
  /**
   * Ghi nhận peer nhắn tới (Zalo Personal): server persist vào DB để danh
   * sách chờ duyệt sống qua restart. countMessage=false = chỉ cập nhật tên.
   */
  onObserved?: (peer: {
    chatKey: string;
    threadId: string;
    kind: "direct" | "group";
    name: string;
    lastSenderId: string;
    lastSenderName: string;
    countMessage: boolean;
  }) => void;
  /**
   * Zalo Personal — Inbox: MỌI tin đến/đi của tài khoản (kể cả thread chưa
   * cho agent trả lời) để server lưu và đẩy realtime cho người trực.
   */
  onMessageLog?: (entry: ChannelMessageLog) => void;
  /** Zalo Personal — danh bạ (bạn bè + nhóm) vừa đồng bộ xong. */
  onContactsSynced?: (items: ChannelContact[]) => void;
  /** Zalo Personal — tra được tên nhóm (sau khi tin đầu tiên tới). */
  onThreadName?: (threadId: string, name: string) => void;
  /** Zalo Personal — có người thả/gỡ cảm xúc vào một tin (khách, chủ tài khoản, hoặc PenAI vừa thả). */
  onReaction?: (r: ChannelReaction) => void;
}

/** Một lượt thả/gỡ cảm xúc vào tin nhắn. icon rỗng = gỡ. */
export interface ChannelReaction {
  threadId: string;
  peerKind: "direct" | "group";
  /** msgId của tin được thả cảm xúc */
  targetMsgId: string;
  reactorId: string;
  reactorName: string;
  /** mã icon Zalo ("/-heart", "/-strong"…) — "" = gỡ */
  icon: string;
  /** zalo = khách/thành viên nhóm · app = chủ tài khoản trên điện thoại · web/auto/mcp = PenAI thả */
  source: "zalo" | "app" | "web" | "auto" | "mcp";
  webUserId?: string;
  at: Date;
}

/** Một tin nhắn (đến hoặc đi) cho Inbox. */
export interface ChannelMessageLog {
  threadId: string;
  peerKind: "direct" | "group";
  msgId: string;
  direction: "in" | "out";
  /** zalo = người ngoài gửi tới · app = chủ tài khoản gửi từ điện thoại · agent/web/mcp/api = gửi từ PenAI */
  source: "zalo" | "app" | "agent" | "web" | "mcp" | "api";
  senderId: string;
  senderName: string;
  webUserId?: string;
  contentType: "text" | "photo" | "file" | "sticker" | "voice" | "video" | "link" | "other";
  text: string;
  media?: { url?: string; thumb?: string; name?: string; size?: number; localPath?: string };
  meta?: Record<string, unknown>;
  sentAt: Date;
  /** Tên hội thoại biết được lúc này (DM đến: tên người gửi; nhóm: tên nhóm nếu đã tra). */
  threadName?: string;
}

/** Một mục danh bạ đồng bộ về (bạn bè hoặc nhóm). */
export interface ChannelContact {
  id: string;
  type: "direct" | "group";
  name: string;
  avatar?: string;
  phone?: string;
  memberCount?: number;
}
