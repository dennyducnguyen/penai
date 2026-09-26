import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GeminiProvider,
  OpenAICompatProvider,
  QwenProvider,
  createProviderRegistry,
  isEmbeddingProvider,
} from "../src/index.js";

let server: Server;
let baseURL: string;
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ url: req.url ?? "", body });
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "chat-model", object: "model", created: 0, owned_by: "test" },
              { id: "text-embedding-test", object: "model", created: 0, owned_by: "test" },
            ],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/embeddings")) {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            model: body.model,
            data: input.map((_, index) => ({
              object: "embedding",
              index,
              embedding: [index + 0.1, index + 0.2, index + 0.3],
            })),
            usage: { prompt_tokens: input.length, total_tokens: input.length },
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        const messages = body.messages as Array<{ role: string; tool_calls?: unknown[] }>;
        const assistant = messages.find((message) => message.role === "assistant");
        const message = assistant
          ? { role: "assistant", content: "OK" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "gemini-call-1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                  extra_content: { google: { thought_signature: "opaque-signature" } },
                },
              ],
            };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "chat-test",
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message, finish_reason: assistant ? "stop" : "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({ error: { message: "not found" } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("provider capability chat + embedding", () => {
  it("OpenAI-compatible tách catalog chat/embedding và giữ đúng thứ tự vector", async () => {
    const provider = new OpenAICompatProvider("openai", { baseURL, apiKey: "test" });
    expect(isEmbeddingProvider(provider)).toBe(true);
    await expect(provider.listModels()).resolves.toEqual([
      { slug: "chat-model", displayName: "chat-model", contextWindow: 0 },
    ]);
    await expect(provider.listEmbeddingModels()).resolves.toEqual([
      { slug: "text-embedding-test", displayName: "text-embedding-test", dimensions: [] },
    ]);
    await expect(
      provider.embed({
        model: "text-embedding-test",
        inputs: ["tài liệu A", "tài liệu B"],
        dimensions: 768,
        inputType: "document",
      }),
    ).resolves.toMatchObject({ vectors: [[0.1, 0.2, 0.3], [1.1, 1.2, 1.3]] });
  });

  it("Gemini thêm prefix retrieval tương ứng cho query và document", async () => {
    const provider = new GeminiProvider("gemini", { apiKey: "test", baseURL });
    await provider.embed({
      model: "gemini-embedding-2",
      inputs: ["giá sản phẩm"],
      dimensions: 768,
      inputType: "query",
    });
    await provider.embed({
      model: "gemini-embedding-2",
      inputs: ["nội dung sản phẩm"],
      dimensions: 768,
      inputType: "document",
      title: "Sản phẩm A",
    });
    expect(requests.at(-2)?.body.input).toEqual(["task: search result | query: giá sản phẩm"]);
    expect(requests.at(-1)?.body.input).toEqual(["title: Sản phẩm A | text: nội dung sản phẩm"]);
  });

  it("Gemini round-trip thought signature khi agent gọi tool nhiều bước", async () => {
    const provider = new GeminiProvider("gemini", { apiKey: "test", baseURL });
    const first = await provider.chat({
      model: "gemini-chat",
      messages: [{ role: "user", content: "tra cứu" }],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
    });
    expect(first.toolCalls[0]?.providerData).toEqual({
      extra_content: { google: { thought_signature: "opaque-signature" } },
    });
    await provider.chat({
      model: "gemini-chat",
      messages: [
        { role: "user", content: "tra cứu" },
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "gemini-call-1", content: "xong" },
      ],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
    });
    const secondRequest = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
    const assistant = secondRequest.find((message) => message.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      expect.objectContaining({
        extra_content: { google: { thought_signature: "opaque-signature" } },
      }),
    ]);
  });

  it("Qwen dùng endpoint workspace và hỗ trợ embedding qua cùng API key", async () => {
    const provider = new QwenProvider("qwen", { apiKey: "test", baseURL });
    await expect(
      provider.embed({ model: "text-embedding-v4", inputs: ["xin chào"], dimensions: 768 }),
    ).resolves.toMatchObject({ vectors: [[0.1, 0.2, 0.3]] });
  });
});

describe("provider registry cô lập runtime theo workspace", () => {
  it("cho phép cùng tên ở hai workspace mà không ghi đè nhau", () => {
    const registry = createProviderRegistry({});
    const a = new OpenAICompatProvider("shared", { baseURL, apiKey: "a" });
    const b = new OpenAICompatProvider("shared", { baseURL, apiKey: "b" });
    registry.registerRuntime("ws-a", "shared", a);
    registry.registerRuntime("ws-b", "shared", b);
    expect(registry.get("shared", "ws-a")).toBe(a);
    expect(registry.get("shared", "ws-b")).toBe(b);
    expect(registry.names("ws-a")).toContain("shared");
    registry.removeRuntime("ws-a", "shared");
    expect(() => registry.get("shared", "ws-a")).toThrow();
    expect(registry.get("shared", "ws-b")).toBe(b);
  });
});
