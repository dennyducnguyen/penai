import OpenAI from "openai";
import type { ToolCallData } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingModelInfo,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  Provider,
  StopReason,
  StreamEvent,
} from "./types.js";
import { withRetry } from "./retry.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const NON_CHAT_MODEL =
  /(embedding|moderation|whisper|tts|transcrib|speech|audio|realtime|image|dall-e|sora|babbage|davinci|curie|ada)/i;

/**
 * Model đời mới của OpenAI (gpt-5.x, o-series) TỪ CHỐI `max_tokens` (400
 * "Use 'max_completion_tokens' instead"). Endpoint compat khác (OpenRouter,
 * Groq...) vẫn dùng `max_tokens` — chọn tham số theo tên model.
 */
const NEEDS_COMPLETION_TOKENS = /(^|\/)(gpt-5|o\d)/i;

/**
 * Model reasoning của OpenAI nhận `reasoning_effort` trên chat/completions.
 * Riêng thế hệ gpt-5.6+ (luna/sol/terra...) BẮT BUỘC reasoning_effort="none"
 * khi dùng function tools mà không muốn reasoning (400 nếu bỏ trống).
 */
const ACCEPTS_REASONING_EFFORT = /(^|\/)(gpt-5|o\d)/i;
const REQUIRES_EFFORT_WITH_TOOLS = /(^|\/)gpt-5\.([6-9]|\d{2,})/i;

export function isLikelyChatModel(modelId: string): boolean {
  return modelId.length > 0 && !NON_CHAT_MODEL.test(modelId);
}

export function isLikelyEmbeddingModel(modelId: string): boolean {
  return /(embedding|embed-|embed$)/i.test(modelId);
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function mapFinish(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end";
}

/**
 * Adapter cho mọi endpoint tương thích OpenAI Chat Completions
 * (OpenAI, OpenRouter, Groq, DeepSeek, mock nội bộ...) qua baseURL.
 */
export class OpenAICompatProvider implements Provider, EmbeddingProvider {
  protected readonly client: OpenAI;

  constructor(
    readonly name: string,
    cfg: { baseURL?: string; apiKey?: string; defaultHeaders?: Record<string, string> },
  ) {
    this.client = new OpenAI({
      baseURL: cfg.baseURL?.trim() || OPENAI_DEFAULT_BASE_URL,
      apiKey: cfg.apiKey ?? "dummy",
      ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
      maxRetries: 0, // retry tự quản qua withRetry
    });
  }

  private buildParams(req: ChatRequest) {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      if (m.role === "user") {
        if (m.images?.length) {
          messages.push({
            role: "user",
            content: [
              { type: "text", text: m.content },
              ...m.images.map((url) => ({
                type: "image_url" as const,
                image_url: { url },
              })),
            ],
          });
        } else {
          messages.push({ role: "user", content: m.content });
        }
      } else if (m.role === "assistant") {
        const am: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =
          { role: "assistant", content: m.content };
        if (m.toolCalls?.length) {
          am.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            ...(tc.providerData ?? {}),
          })) as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
        }
        messages.push(am);
      } else {
        messages.push({
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content,
        });
      }
    }
    const tools = req.tools?.length
      ? req.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;
    // reasoning_effort: theo thinking level agent (chỉ model reasoning OpenAI,
    // và chỉ các mức API chắc chắn nhận: low/medium/high — "minimal" không gửi,
    // gpt-5.5 từ chối giá trị này); gpt-5.6+ với tools mà không có mức hợp lệ
    // → bắt buộc gửi "none".
    const explicitEffort =
      req.reasoningEffort &&
      ["low", "medium", "high"].includes(req.reasoningEffort) &&
      ACCEPTS_REASONING_EFFORT.test(req.model)
        ? req.reasoningEffort
        : undefined;
    // gpt-5.6+ trên chat/completions CHỈ nhận reasoning_effort="none" khi có
    // tools (mọi mức khác đều 400) — ép "none", bỏ qua thinking level agent.
    const reasoningEffort = tools && REQUIRES_EFFORT_WITH_TOOLS.test(req.model)
      ? ("none" as const)
      : explicitEffort;
    return {
      model: req.model,
      messages,
      ...(tools ? { tools } : {}),
      ...(reasoningEffort
        ? { reasoning_effort: reasoningEffort as "low" | "medium" | "high" }
        : {}),
      ...(req.maxTokens
        ? NEEDS_COMPLETION_TOKENS.test(req.model)
          ? { max_completion_tokens: req.maxTokens }
          : { max_tokens: req.maxTokens }
        : {}),
    };
  }

  /** Danh sách model mà API key hiện tại nhìn thấy, dùng cho dropdown quản trị. */
  async listModels(): Promise<
    Array<{ slug: string; displayName: string; contextWindow: number }>
  > {
    const ids = new Set<string>();
    for await (const model of await this.client.models.list()) {
      if (isLikelyChatModel(model.id)) ids.add(model.id);
    }
    return [...ids]
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((id) => ({ slug: id, displayName: id, contextWindow: 0 }));
  }

  /** Catalog embedding tách riêng để model embedding không lọt vào dropdown agent chat. */
  async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    const ids = new Set<string>();
    for await (const model of await this.client.models.list()) {
      if (isLikelyEmbeddingModel(model.id)) ids.add(model.id);
    }
    return [...ids]
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((id) => ({ slug: id, displayName: id, dimensions: [] }));
  }

  protected prepareEmbeddingInputs(req: EmbeddingRequest): string[] {
    return req.inputs;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!req.inputs.length) throw new Error("Embedding cần ít nhất một input");
    return withRetry(async () => {
      const response = await this.client.embeddings.create(
        {
          model: req.model,
          input: this.prepareEmbeddingInputs(req),
          encoding_format: "float",
          ...(req.dimensions ? { dimensions: req.dimensions } : {}),
        },
        { signal: req.signal },
      );
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== req.inputs.length) {
        throw new Error(`Provider trả ${ordered.length} vector cho ${req.inputs.length} input`);
      }
      return {
        model: response.model,
        vectors: ordered.map((item) => item.embedding),
        usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
      };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const res = await this.client.chat.completions.create(
        { ...this.buildParams(req), stream: false },
        { signal: req.signal },
      );
      const choice = res.choices[0];
      if (!choice) throw new Error("Provider không trả về choice nào");
      const toolCalls: ToolCallData[] = (choice.message.tool_calls ?? [])
        .filter((tc) => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: safeParseArgs(tc.function.arguments),
          ...((tc as unknown as { extra_content?: Record<string, unknown> }).extra_content
            ? { providerData: { extra_content: (tc as unknown as { extra_content: Record<string, unknown> }).extra_content } }
            : {}),
        }));
      return {
        content: choice.message.content ?? null,
        toolCalls,
        stopReason: mapFinish(choice.finish_reason),
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      };
    });
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const stream = await withRetry(() =>
      this.client.chat.completions.create(
        {
          ...this.buildParams(req),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      ),
    );
    let content = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string; providerData?: Record<string, unknown> }>();
    let finish: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const deltaText = choice?.delta?.content;
      if (deltaText) {
        content += deltaText;
        yield { type: "text_delta", text: deltaText };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        const extraContent = (tc as unknown as { extra_content?: Record<string, unknown> }).extra_content;
        if (extraContent) cur.providerData = { extra_content: extraContent };
        toolAcc.set(tc.index, cur);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    const toolCalls: ToolCallData[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        name: v.name,
        args: safeParseArgs(v.args),
        ...(v.providerData ? { providerData: v.providerData } : {}),
      }));
    yield {
      type: "done",
      response: {
        content: content || null,
        toolCalls,
        stopReason: mapFinish(finish),
        usage,
      },
    };
  }
}
