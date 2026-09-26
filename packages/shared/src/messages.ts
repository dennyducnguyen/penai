/** Một yêu cầu gọi tool từ LLM. */
export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Metadata opaque của provider (vd. thought signature Gemini), phải round-trip nguyên vẹn. */
  providerData?: Record<string, unknown>;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Nội dung message lưu DB (jsonb) — discriminated theo `kind`. */
export type MessageContent =
  | { kind: "text"; text: string } // user | system
  | { kind: "assistant"; text: string | null; toolCalls: ToolCallData[] }
  | {
      kind: "tool_result";
      toolCallId: string;
      name: string;
      result: string;
      isError: boolean;
    };

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: MessageContent;
  seq: number;
}
