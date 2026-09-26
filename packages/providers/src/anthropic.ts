import Anthropic from "@anthropic-ai/sdk";
import type { ToolCallData } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StopReason,
  StreamEvent,
} from "./types.js";
import { withRetry } from "./retry.js";

function mapStop(reason: string | null): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(
    readonly name: string,
    cfg: { apiKey: string; baseURL?: string },
  ) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      maxRetries: 0,
    });
  }

  private buildParams(req: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    const out: Anthropic.MessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        out.push({ role: "assistant", content: blocks });
      } else {
        // Anthropic yêu cầu tool_result nằm trong user message;
        // các tool result liên tiếp gộp chung 1 message.
        const block: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        };
        const last = out[out.length - 1];
        if (
          last?.role === "user" &&
          Array.isArray(last.content) &&
          last.content[0] &&
          (last.content[0] as { type?: string }).type === "tool_result"
        ) {
          (last.content as Anthropic.ContentBlockParam[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
      }
    }
    return {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      ...(req.system ? { system: req.system } : {}),
      messages: out,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool["input_schema"],
            })),
          }
        : {}),
    };
  }

  /** Danh sách model mà API key hiện tại được phép dùng, phục vụ dropdown quản trị. */
  async listModels(): Promise<
    Array<{ slug: string; displayName: string; contextWindow: number }>
  > {
    const models: Array<{ slug: string; displayName: string; contextWindow: number }> = [];
    for await (const model of await this.client.models.list()) {
      models.push({
        slug: model.id,
        displayName: model.display_name || model.id,
        contextWindow: 0,
      });
    }
    return models;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const res = await this.client.messages.create(this.buildParams(req), {
        signal: req.signal,
      });
      let text = "";
      const toolCalls: ToolCallData[] = [];
      for (const block of res.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          });
        }
      }
      return {
        content: text || null,
        toolCalls,
        stopReason: mapStop(res.stop_reason),
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
      };
    });
  }

  /** Streaming SSE thật qua SDK Anthropic (messages.stream). */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const stream = this.client.messages.stream(this.buildParams(req), {
      signal: req.signal,
    });

    let text = "";
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "tool_use") {
          toolBlocks.set(ev.index, {
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: "",
          });
        }
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          text += ev.delta.text;
          yield { type: "text_delta", text: ev.delta.text };
        } else if (ev.delta.type === "input_json_delta") {
          const blk = toolBlocks.get(ev.index);
          if (blk) blk.json += ev.delta.partial_json;
        }
      }
    }

    const final = await stream.finalMessage();
    const toolCalls: ToolCallData[] = [];
    for (const block of final.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }
    yield {
      type: "done",
      response: {
        content: text || null,
        toolCalls,
        stopReason: mapStop(final.stop_reason),
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        },
      },
    };
  }
}
