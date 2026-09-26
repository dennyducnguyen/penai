import type { ChatRequest, StreamEvent } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/** Endpoint OpenAI-compatible của Alibaba DashScope (Qwen). */
export const DASHSCOPE_DEFAULT_BASE =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

/** Catalog model Qwen cho UI chọn. */
export const DASHSCOPE_MODELS: Array<{ slug: string; displayName: string }> = [
  { slug: "qwen3-max", displayName: "Qwen3 Max" },
  { slug: "qwen-max", displayName: "Qwen Max" },
  { slug: "qwen-plus", displayName: "Qwen Plus" },
  { slug: "qwen-turbo", displayName: "Qwen Turbo" },
  { slug: "qwen3-coder-plus", displayName: "Qwen3 Coder Plus" },
  { slug: "qwen3-coder-flash", displayName: "Qwen3 Coder Flash" },
  { slug: "qwen-vl-max", displayName: "Qwen VL Max (vision)" },
  { slug: "qwen-vl-plus", displayName: "Qwen VL Plus (vision)" },
];

export const QWEN_EMBEDDING_MODELS = [
  { slug: "qwen3.7-text-embedding", displayName: "Qwen 3.7 Text Embedding", dimensions: [64, 128, 256, 512, 768, 1024, 2048, 4096] },
  { slug: "qwen3.7-text-embedding-flash", displayName: "Qwen 3.7 Text Embedding Flash", dimensions: [64, 128, 256, 512, 768, 1024] },
  { slug: "text-embedding-v4", displayName: "Text Embedding V4", dimensions: [64, 128, 256, 512, 768, 1024, 2048] },
];

/**
 * Provider Qwen qua DashScope. Khác openai-compat ở một điểm sống còn
 * Lưu ý: DashScope TỪ CHỐI tools + streaming cùng lúc
 * → khi có tools, gọi non-stream rồi giả lập chunk.
 */
export class DashScopeProvider extends OpenAICompatProvider {
  constructor(name: string, cfg: { baseURL?: string; apiKey: string }) {
    super(name, { baseURL: cfg.baseURL || DASHSCOPE_DEFAULT_BASE, apiKey: cfg.apiKey });
  }

  override async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (req.tools?.length) {
      const res = await this.chat(req);
      if (res.content) yield { type: "text_delta", text: res.content };
      yield { type: "done", response: res };
      return;
    }
    yield* super.chatStream(req);
  }
}

/** Tên first-class mới; DashScopeProvider được giữ làm alias tương thích cấu hình cũ. */
export class QwenProvider extends DashScopeProvider {
  private readonly useFallbackCatalog: boolean;

  constructor(name: string, cfg: { baseURL?: string; apiKey: string }) {
    super(name, cfg);
    this.useFallbackCatalog = !cfg.baseURL;
  }

  override async listModels() {
    try {
      const models = await super.listModels();
      return models.length || !this.useFallbackCatalog
        ? models
        : DASHSCOPE_MODELS.map((model) => ({ ...model, contextWindow: 0 }));
    } catch (error) {
      if (!this.useFallbackCatalog) throw error;
      return DASHSCOPE_MODELS.map((model) => ({ ...model, contextWindow: 0 }));
    }
  }

  override async listEmbeddingModels() {
    try {
      const models = await super.listEmbeddingModels();
      return models.length || !this.useFallbackCatalog ? models : QWEN_EMBEDDING_MODELS;
    } catch (error) {
      if (!this.useFallbackCatalog) throw error;
      return QWEN_EMBEDDING_MODELS;
    }
  }
}
