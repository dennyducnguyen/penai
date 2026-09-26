import type { EmbeddingModelInfo, EmbeddingRequest } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

export const GEMINI_CHAT_MODELS = [
  { slug: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", contextWindow: 0 },
  { slug: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", contextWindow: 0 },
  { slug: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", contextWindow: 0 },
];

export const GEMINI_EMBEDDING_MODELS: EmbeddingModelInfo[] = [
  { slug: "gemini-embedding-2", displayName: "Gemini Embedding 2", dimensions: [768, 1536, 3072] },
  { slug: "gemini-embedding-001", displayName: "Gemini Embedding 001", dimensions: [768, 1536, 3072] },
];

/** Gemini API qua lớp OpenAI-compatible chính thức; cùng key cho chat và embedding. */
export class GeminiProvider extends OpenAICompatProvider {
  private readonly useFallbackCatalog: boolean;

  constructor(name: string, cfg: { apiKey: string; baseURL?: string }) {
    super(name, {
      baseURL: cfg.baseURL || GEMINI_OPENAI_BASE_URL,
      apiKey: cfg.apiKey,
      defaultHeaders: { "x-goog-api-client": "penai/0.1.0" },
    });
    this.useFallbackCatalog = !cfg.baseURL;
  }

  override async listModels() {
    try {
      const models = (await super.listModels())
        .map((model) => ({ ...model, slug: model.slug.replace(/^models\//, ""), displayName: model.displayName.replace(/^models\//, "") }))
        .filter((model) => /^(gemini|gemma)-/i.test(model.slug))
        .filter((model) => !/(embedding|live|omni|robotics|computer-use|image|tts|native-audio)/i.test(model.slug));
      return models.length || !this.useFallbackCatalog ? models : GEMINI_CHAT_MODELS;
    } catch (error) {
      if (!this.useFallbackCatalog) throw error;
      return GEMINI_CHAT_MODELS;
    }
  }

  override async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    try {
      const models = (await super.listEmbeddingModels()).map((model) => ({
        ...model,
        slug: model.slug.replace(/^models\//, ""),
        displayName: model.displayName.replace(/^models\//, ""),
      }));
      return models.length || !this.useFallbackCatalog ? models : GEMINI_EMBEDDING_MODELS;
    } catch (error) {
      if (!this.useFallbackCatalog) throw error;
      return GEMINI_EMBEDDING_MODELS;
    }
  }

  protected override prepareEmbeddingInputs(req: EmbeddingRequest): string[] {
    if (req.model !== "gemini-embedding-2") return req.inputs;
    if (req.inputType === "query") {
      return req.inputs.map((input) => `task: search result | query: ${input}`);
    }
    if (req.inputType === "document") {
      return req.inputs.map((input) =>
        req.title ? `title: ${req.title} | text: ${input}` : `text: ${input}`,
      );
    }
    return req.inputs;
  }
}
