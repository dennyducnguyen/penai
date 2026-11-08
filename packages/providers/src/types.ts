import type { ToolCallData } from "@penai/shared";

export type ProviderChatMessage =
  | {
      role: "user";
      content: string;
      /** Ảnh đính kèm dạng data URL (vision) — provider không hỗ trợ thì bỏ qua. */
      images?: string[];
      /**
       * Âm thanh đính kèm (tin nhắn thoại) — chỉ gửi đi khi provider báo model
       * nghe được (`inputModalities` có "audio"); provider khác bỏ qua.
       */
      audio?: ProviderAudioInput[];
    }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCallData[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ProviderAudioInput {
  /** base64 thuần (không có tiền tố data:). */
  data: string;
  /** Định dạng file: ogg, opus, mp3, wav, m4a, aac, amr, webm… */
  format: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema cho tham số tool. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ProviderChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Mức reasoning (gpt-5.x): minimal | low | medium | high. Provider không hỗ trợ thì bỏ qua. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type StopReason = "end" | "tool_use" | "max_tokens";

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCallData[];
  stopReason: StopReason;
  usage: ChatUsage;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; response: ChatResponse };

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /**
   * Loại đầu vào model nhận được ("text", "image", "audio"…) theo khai báo của
   * provider. Không cài / trả null = không biết (giữ cách đoán cũ).
   */
  inputModalities?(model: string): Promise<string[] | null>;
}

export type EmbeddingInputType = "query" | "document" | "classification";

export interface EmbeddingRequest {
  model: string;
  inputs: string[];
  dimensions?: number;
  inputType?: EmbeddingInputType;
  /** Tiêu đề dùng khi nhúng tài liệu; provider không hỗ trợ sẽ bỏ qua. */
  title?: string;
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  model: string;
  vectors: number[][];
  usage: { inputTokens: number };
}

export interface EmbeddingModelInfo {
  slug: string;
  displayName: string;
  /** Danh sách rỗng nghĩa là API quyết định/không công bố catalog kích thước. */
  dimensions: number[];
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
  listEmbeddingModels(): Promise<EmbeddingModelInfo[]>;
}

export function isEmbeddingProvider(provider: Provider): provider is Provider & EmbeddingProvider {
  const candidate = provider as Partial<EmbeddingProvider>;
  return typeof candidate.embed === "function" && typeof candidate.listEmbeddingModels === "function";
}
