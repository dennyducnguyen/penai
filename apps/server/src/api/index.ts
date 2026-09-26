/**
 * API công khai OpenAI-compatible — specs/spec-public-api-gateway.md
 *
 * Phạm vi: chỉ phục vụ thứ app KHÔNG tự gọi được — tài khoản ChatGPT
 * subscription (codex), Antigravity/Claude Code CLI, và agent PenAI.
 * Provider có API key nằm ngoài phạm vi: app tự gọi thẳng nhà cung cấp.
 *
 * Các lựa chọn thiết kế có chủ ý:
 *   - Stream là delta THẬT, không phải chạy xong rồi bắn một chunk.
 *   - raw mode dùng TRỌN messages[] client gửi (stateless đúng nghĩa), không
 *     vứt history rồi chỉ lấy message cuối.
 *   - Có trần đồng thời theo provider (ProviderGate) vì mỗi tiến trình CLI
 *     tốn ~220 MB RAM trên VPS chỉ còn ~1,1 GB.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PenaiConfig, WorkspaceContext } from "@penai/shared";
import { logger } from "@penai/shared";
import {
  ImageRouter,
  antigravityImageBackend,
  codexImageBackend,
  openAIImageBackend,
  AntigravityProvider,
  CodexProvider,
  type ChatRequest,
  type ImageBackend,
  type Provider,
  type ProviderChatMessage,
  type ProviderRegistry,
} from "@penai/providers";
import {
  ProviderGate,
  QueueRejectedError,
  gatedProvider,
  runAgent,
  type AgentEvent,
} from "@penai/core";
import {
  appendMessage,
  bumpApiUsage,
  createPublishedFile,
  createSession,
  getAgentById,
  getAgentByKey,
  getApiConversation,
  loadMessages,
  recordTraceSafe,
  saveApiConversation,
  type Db,
} from "@penai/db";
import { buildLoopDeps, agentOpts, contentTypeOf, type RuntimeDeps } from "../agent-runtime.js";
import { ApiError, sendApiError, toApiError } from "./errors.js";
import {
  assertAgentAllowed,
  assertModelAllowed,
  checkIpAllowlist,
  checkQuota,
  concurrencyEnter,
  loadPolicy,
  newRequestId,
  rateLimitCheck,
  sweepBuckets,
  type ApiCaller,
} from "./policy.js";
import { RouteState, isRetryableProviderError, resolveModel } from "./routing.js";
import { chatChunk, startSse } from "./sse.js";

export interface ApiDeps {
  rt: RuntimeDeps;
  gate: ProviderGate;
}

// ===== Thân request =====

const ChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.object({ url: z.string() }).optional(),
      }),
    ),
    z.null(),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

const PenaiExtSchema = z
  .object({
    conversation_id: z.string().max(200).optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    return_files: z.enum(["url", "b64", "none"]).default("url"),
    url_ttl_hours: z.number().int().min(1).optional(),
  })
  .optional();

const ChatBodySchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  max_completion_tokens: z.number().int().min(1).max(200_000).optional(),
  reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  user: z.string().max(200).optional(),
  stream_options: z.object({ include_usage: z.boolean().default(false) }).optional(),
  penai: PenaiExtSchema,
});

const ImageBodySchema = z.object({
  model: z.string().default("penai-image"),
  prompt: z.string().min(1).max(32_000),
  /** Bỏ trống: 1024x1024, riêng khi có ref_images thì "auto" (sửa ảnh giữ khung gốc). */
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional(),
  n: z.number().int().min(1).max(4).default(1),
  response_format: z.enum(["url", "b64_json"]).default("url"),
  penai: z
    .object({
      url_ttl_hours: z.number().int().min(1).optional(),
      /** Ép provider tạo ảnh; bỏ trống = theo route của model (antigravity → codex). */
      provider: z.enum(["antigravity", "codex"]).optional(),
      /** Tỷ lệ khung "16:9", "9:16", "4:5"… — thắng size. */
      aspect_ratio: z
        .string()
        .regex(/^\d{1,2}:\d{1,2}$/, "penai.aspect_ratio dạng W:H, vd 16:9")
        .optional(),
      /** Ảnh tham chiếu / ảnh cần sửa: data URL base64, tối đa 5 ảnh (~10 MB/ảnh). */
      ref_images: z
        .array(
          z
            .string()
            .max(14_000_000, "Ảnh tham chiếu quá ~10 MB")
            .regex(/^data:image\/[\w.+-]+;base64,/, "penai.ref_images phải là data URL base64 (data:image/...;base64,...)"),
        )
        .max(5)
        .optional(),
    })
    .optional(),
});

// ===== Tiện ích =====

function textOf(content: z.infer<typeof ChatMessageSchema>["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .filter((p) => p.type === "text" || typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n");
}

function imagesOf(content: z.infer<typeof ChatMessageSchema>["content"]): string[] {
  if (typeof content === "string" || !content) return [];
  return content
    .filter((p) => p.image_url?.url)
    .map((p) => p.image_url!.url)
    .slice(0, 8);
}

/** messages[] kiểu OpenAI → system + lịch sử cho provider. */
function toProviderMessages(msgs: Array<z.infer<typeof ChatMessageSchema>>): {
  system: string;
  history: ProviderChatMessage[];
} {
  const systemParts: string[] = [];
  const history: ProviderChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === "user") {
      const images = imagesOf(m.content);
      history.push({
        role: "user",
        content: textOf(m.content),
        ...(images.length ? { images } : {}),
      });
      continue;
    }
    if (m.role === "assistant") {
      history.push({ role: "assistant", content: textOf(m.content) });
      continue;
    }
    if (m.role === "tool") {
      history.push({
        role: "tool",
        toolCallId: m.tool_call_id ?? "call",
        content: textOf(m.content),
      });
    }
  }
  return { system: systemParts.join("\n\n"), history };
}

function lastUserText(msgs: Array<z.infer<typeof ChatMessageSchema>>): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "user") return textOf(m.content);
  }
  return "";
}

function completionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Provider chay bang CLI (spawn tien trinh): chi stream token khi KHONG co tool.
 * Agent luon co tool nen agent chay claude-code/antigravity la nguyen khoi.
 */
function isCliProvider(name: string): boolean {
  return name === "claude-code" || name === "antigravity";
}

// ===== Đăng ký route =====

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { rt, gate } = deps;
  const db = rt.db.db;
  const routeState = new RouteState();
  const sweeper = setInterval(() => sweepBuckets(), 10 * 60_000);
  sweeper.unref?.();

  const cfgOf = (): PenaiConfig["api"] => rt.config.api;

  /** Xác thực + mọi lớp chặn trước khi chạy. Ném ApiError. */
  async function gateway(req: FastifyRequest): Promise<ApiCaller> {
    const cfg = cfgOf();
    if (!cfg.enabled) {
      throw new ApiError("invalid_request", "API công khai đang tắt (api.enabled=false)");
    }
    checkIpAllowlist(req, cfg);

    const info = req.authInfo;
    if (!info || info.kind !== "apikey" || !info.apiKeyId) {
      throw new ApiError("invalid_api_key", "API này chỉ nhận API key psk_ qua Authorization Bearer");
    }
    const ctx = req.authCtx;
    const policy = await loadPolicy(db, ctx, info.apiKeyId);
    if (policy?.paused) throw new ApiError("key_paused", "API key đang bị tạm dừng");
    rateLimitCheck(info.apiKeyId, cfg, policy);
    return { ctx, apiKeyId: info.apiKeyId, requestId: newRequestId(), policy };
  }

  function baseHeaders(reply: FastifyReply, caller: ApiCaller): void {
    void reply.header("x-request-id", caller.requestId);
  }

  // ---------- GET /v1/models ----------
  app.get("/v1/api/models", async (req, reply) => modelsHandler(req, reply));
  app.get("/v1/models", async (req, reply) => modelsHandler(req, reply));

  async function modelsHandler(req: FastifyRequest, reply: FastifyReply) {
    let caller: ApiCaller;
    try {
      caller = await gateway(req);
    } catch (err) {
      return sendApiError(reply, toApiError(err), newRequestId());
    }
    const cfg = cfgOf();
    baseHeaders(reply, caller);

    const data: Array<Record<string, unknown>> = [];
    for (const [alias, def] of Object.entries(cfg.models)) {
      try {
        assertModelAllowed(alias, cfg, caller.policy);
      } catch {
        continue;
      }
      const cliOnly = def.route.every(
        (c) => c.provider === "claude-code" || c.provider === "antigravity",
      );
      const anyCli = def.route.some(
        (c) => c.provider === "claude-code" || c.provider === "antigravity",
      );
      const isImages = def.route[0]?.kind === "images";
      data.push({
        id: alias,
        object: "model",
        created: 0,
        owned_by: "penai",
        penai: {
          // native = luôn stream token; tools_only = chỉ stream khi không có tool; ảnh không stream
          streaming: isImages ? "none" : cliOnly ? "tools_only" : anyCli ? "mixed" : "native",
          route: def.route.map((c) => `${c.provider}/${c.model}`),
          kind: def.route[0]?.kind ?? "chat",
        },
      });
    }

    // Agent mà key được phép dùng
    try {
      const { listAgents } = await import("@penai/db");
      for (const a of await listAgents(db, caller.ctx)) {
        try {
          assertAgentAllowed(a.key, caller.policy);
        } catch {
          continue;
        }
        const cli = a.provider === "claude-code" || a.provider === "antigravity";
        data.push({
          id: `agent:${a.key}`,
          object: "model",
          created: 0,
          owned_by: "penai",
          penai: {
            // Agent luôn có tool → CLI provider không stream được token
            streaming: cli ? "emulated" : "native",
            provider: a.provider,
            model: a.model,
            name: a.name,
          },
        });
      }
    } catch {
      /* không liệt kê được agent thì vẫn trả model alias */
    }

    return reply.send({ object: "list", data });
  }

  // ---------- POST /v1/chat/completions ----------
  app.post("/v1/chat/completions", async (req, reply) => {
    let caller: ApiCaller;
    try {
      caller = await gateway(req);
    } catch (err) {
      return sendApiError(reply, toApiError(err), newRequestId());
    }
    baseHeaders(reply, caller);

    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(
        reply,
        new ApiError("invalid_request", parsed.error.issues[0]?.message ?? "Body không hợp lệ", {
          param: parsed.error.issues[0]?.path.join(".") ?? undefined,
        }),
        caller.requestId,
      );
    }
    const body = parsed.data;
    const cfg = cfgOf();

    let release: (() => void) | null = null;
    try {
      await checkQuota(db, caller);
      release = concurrencyEnter(caller.apiKeyId, cfg, caller.policy);
      const resolved = resolveModel(body.model, cfg);

      if (resolved.mode === "agent") {
        assertAgentAllowed(resolved.agentRef, caller.policy);
        return await runAgentMode(req, reply, caller, body, resolved.agentRef);
      }
      assertModelAllowed(resolved.alias ?? body.model, cfg, caller.policy);
      return await runRawMode(req, reply, caller, body, resolved.candidates);
    } catch (err) {
      const apiErr = toApiError(err);
      recordTraceSafe(db, caller.ctx, {
        inputTokens: 0,
        outputTokens: 0,
        iterations: 0,
        durationMs: 0,
        error: apiErr.message.slice(0, 500),
        source: "api",
        apiKeyId: caller.apiKeyId,
        model: body.model,
      });
      void bumpApiUsage(db, caller.ctx, {
        apiKeyId: caller.apiKeyId,
        model: body.model,
        isError: true,
      }).catch(() => undefined);
      if (reply.sent || reply.raw.headersSent) return;
      return sendApiError(reply, apiErr, caller.requestId);
    } finally {
      release?.();
    }
  });

  // ===== raw mode: gọi thẳng provider, stateless =====

  async function runRawMode(
    req: FastifyRequest,
    reply: FastifyReply,
    caller: ApiCaller,
    body: z.infer<typeof ChatBodySchema>,
    candidates: Array<{ provider: string; model: string; kind: "chat" | "images" }>,
  ): Promise<unknown> {
    const convId = body.penai?.conversation_id;
    const { ordered, blocked } = routeState.order(candidates, convId);
    const { system, history } = toProviderMessages(body.messages);
    if (!history.length) {
      throw new ApiError("invalid_request", "messages phải có ít nhất một lượt user", {
        param: "messages",
      });
    }

    const id = completionId();
    const started = Date.now();
    // Header phải quyết định TRƯỚC khi mở SSE: startSse gọi writeHead ngay, sau
    // đó reply.header() không còn tác dụng (header đã đi rồi).
    const firstIsCli = isCliProvider(ordered[0]?.provider ?? "");
    const stream = body.stream
      ? startSse(req, reply, {
          "x-request-id": caller.requestId,
          // raw mode không gửi tool → CLI vẫn stream token thật
          "x-penai-stream": "native",
        })
      : null;
    if (!stream && firstIsCli) void reply.header("x-penai-stream", "native");
    let queuedMs = 0;
    let queuedNotified = false;
    let emitted = false;

    const attempts: string[] = [];
    let lastErr: unknown = null;

    for (const cand of ordered) {
      let provider: Provider;
      try {
        provider = rt.providers.get(cand.provider, caller.ctx.workspaceId);
      } catch (err) {
        lastErr = err;
        attempts.push(`${cand.provider}: chưa cấu hình`);
        continue;
      }

      const chatReq: ChatRequest = {
        model: cand.model,
        messages: history,
        ...(system ? { system } : {}),
        ...(body.max_tokens || body.max_completion_tokens
          ? { maxTokens: body.max_tokens ?? body.max_completion_tokens! }
          : {}),
        ...(body.penai?.reasoning_effort || body.reasoning_effort
          ? { reasoningEffort: body.penai?.reasoning_effort ?? body.reasoning_effort! }
          : {}),
        ...(stream ? { signal: stream.signal } : {}),
      };
      // Model THẬT sẽ gửi lên (provider có thể tự đổi model đã bị nhà cung cấp
      // gỡ, vd gpt-5.6-sol → gpt-5.6-terra). Báo đúng cái chạy, không báo cái
      // client xin — nếu không thì x-penai-route thành vô dụng lúc debug.
      const effModel =
        (provider as { effectiveModel?: (m: string) => string }).effectiveModel?.(cand.model) ??
        cand.model;
      const route = `${cand.provider}/${effModel}`;
      const qStart = Date.now();
      // Boc gate o TANG PROVIDER (giong moi loi vao khac) thay vi gate.run
      // long ngoai: neu long hai lop, agent mode se tu cho chinh minh khi
      // concurrency=1.
      const gated = gatedProvider(gate, provider, {
        providerKey: cand.provider,
        bucket: caller.apiKeyId,
        priority: 1,
        onQueued: (position, etaMs) => {
          queuedNotified = true;
          if (stream) {
            stream.send(
              chatChunk(id, body.model, {}, { penai: { queued: { position, eta_ms: etaMs } } }),
            );
          } else {
            void reply.header("x-penai-queue-position", String(position));
          }
        },
      });

      try {
        const result = await (async () => {
          {
            if (stream) {
              let text = "";
              let usage = { inputTokens: 0, outputTokens: 0 };
              for await (const ev of gated.chatStream(chatReq)) {
                if (ev.type === "text_delta") {
                  if (!emitted) {
                    stream.send(chatChunk(id, body.model, { role: "assistant" }));
                    emitted = true;
                  }
                  text += ev.text;
                  stream.send(chatChunk(id, body.model, { content: ev.text }));
                } else if (ev.type === "done") {
                  usage = ev.response.usage;
                  if (!emitted) {
                    stream.send(chatChunk(id, body.model, { role: "assistant" }));
                    emitted = true;
                  }
                  // Provider nguyên khối (CLI có tool) — nội dung tới ở đây
                  if (!text && ev.response.content) {
                    stream.send(chatChunk(id, body.model, { content: ev.response.content }));
                    text = ev.response.content;
                  }
                }
              }
              return { content: text, usage };
            }
            const res = await gated.chat(chatReq);
            return { content: res.content ?? "", usage: res.usage };
          }
        })();
        queuedMs += queuedNotified ? Date.now() - qStart : 0;

        routeState.markSuccess(cand);
        routeState.noteSticky(convId, cand);
        const durationMs = Date.now() - started;
        const usage = {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        };

        recordTraceSafe(db, caller.ctx, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          iterations: 1,
          durationMs,
          source: "api",
          apiKeyId: caller.apiKeyId,
          model: effModel,
          provider: cand.provider,
          kind: "api_raw",
        });
        void bumpApiUsage(db, caller.ctx, {
          apiKeyId: caller.apiKeyId,
          model: body.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          queuedMs,
          durationMs,
        }).catch(() => undefined);

        if (stream) {
          stream.send(
            chatChunk(
              id,
              body.model,
              {},
              {
                finishReason: "stop",
                ...(body.stream_options?.include_usage ? { usage } : {}),
                penai: { route, request_id: caller.requestId, queued_ms: queuedMs },
              },
            ),
          );
          stream.done();
          return;
        }
        void reply.header("x-penai-route", route);
        void reply.header("x-penai-usage", `in=${usage.prompt_tokens};out=${usage.completion_tokens}`);
        return reply.send({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.content },
              finish_reason: "stop",
            },
          ],
          usage,
          penai: { route, request_id: caller.requestId, queued_ms: queuedMs },
        });
      } catch (err) {
        if (err instanceof QueueRejectedError) {
          if (err.reason === "aborted") return; // client đã đi
          throw new ApiError("too_many_concurrent", err.message, {
            retryAfterSec: err.retryAfterSec,
          });
        }
        lastErr = err;
        attempts.push(`${route}: ${(err as Error).message?.slice(0, 160)}`);
        routeState.markFailure(cand, err);

        // Đã phát nội dung ra rồi thì KHÔNG được thử ứng viên khác — client sẽ
        // thấy nội dung lặp/chắp vá (cùng nguyên tắc với CodexProvider).
        if (emitted) break;
        if (!isRetryableProviderError(err)) break;
      }
    }

    const summary = [...attempts, ...blocked].join(" | ");
    if (stream) {
      if (!emitted) stream.send(chatChunk(id, body.model, { role: "assistant" }));
      stream.send(
        chatChunk(
          id,
          body.model,
          { content: `\n[lỗi] ${(lastErr as Error)?.message ?? "không gọi được provider"}` },
          { finishReason: "error", penai: { request_id: caller.requestId, attempts } },
        ),
      );
      stream.done();
      return;
    }
    throw new ApiError(
      "all_routes_exhausted",
      `Mọi ứng viên đều hỏng: ${summary || String(lastErr)}`,
    );
  }

  // ===== agent mode =====

  async function runAgentMode(
    req: FastifyRequest,
    reply: FastifyReply,
    caller: ApiCaller,
    body: z.infer<typeof ChatBodySchema>,
    agentRef: string,
  ): Promise<unknown> {
    const agent =
      (await getAgentByKey(db, caller.ctx, agentRef).catch(() => null)) ??
      (await getAgentById(db, caller.ctx, agentRef).catch(() => null));
    if (!agent) {
      throw new ApiError("model_not_found", `Agent "${agentRef}" không tồn tại`, { param: "model" });
    }

    const convId = body.penai?.conversation_id;
    const ext = body.penai;
    let sessionId: string;
    let userMessage: string;

    if (convId) {
      // Hội thoại bền: ngữ cảnh nằm ở session, chỉ nạp lượt user cuối
      const existing = await getApiConversation(db, caller.ctx, {
        apiKeyId: caller.apiKeyId,
        conversationId: convId,
        agentId: agent.id,
      });
      if (existing) {
        sessionId = existing.sessionId;
      } else {
        const s = await createSession(db, caller.ctx, {
          agentId: agent.id,
          title: `api:${convId}`.slice(0, 120),
        });
        sessionId = s.id;
        await saveApiConversation(db, caller.ctx, {
          apiKeyId: caller.apiKeyId,
          conversationId: convId,
          agentId: agent.id,
          sessionId,
        });
      }
      userMessage = lastUserText(body.messages);
    } else {
      // Stateless: nạp TRỌN messages[] client gửi vào một session tạm.
      // (Không vứt lịch sử rồi chỉ lấy tin cuối — như vậy sai ngữ nghĩa chat completions.)
      const s = await createSession(db, caller.ctx, { agentId: agent.id, title: "api" });
      sessionId = s.id;
      const prior = body.messages.slice(0, -1);
      for (const m of prior) {
        if (m.role === "system" || m.role === "developer") continue;
        const text = textOf(m.content);
        if (!text) continue;
        await appendMessage(db, caller.ctx, sessionId, {
          role: m.role === "assistant" ? "assistant" : "user",
          content:
            m.role === "assistant"
              ? { kind: "assistant", text, toolCalls: [] }
              : { kind: "text", text },
        });
      }
      userMessage = lastUserText(body.messages) || textOf(body.messages.at(-1)?.content ?? "");
    }

    if (!userMessage.trim()) {
      throw new ApiError("invalid_request", "messages phải có nội dung user", { param: "messages" });
    }

    const userKey = body.user ? `api-${body.user}`.slice(0, 120) : `api-${caller.apiKeyId}`;
    const outFiles: string[] = [];
    const loopDeps = await buildLoopDeps(rt, caller.ctx, agent.provider, {
      ...agentOpts(agent),
      userKey,
      sourceKind: "api",
      // Cùng ProviderGate với kênh chat; bucket = api key để một app không
      // chiếm hết lượt của app khác, priority 1 = nhường người dùng thật.
      gateBucket: caller.apiKeyId,
      gatePriority: 1,
      attachFile: (p: string) => outFiles.push(p),
    });

    const images = imagesOf(body.messages.at(-1)?.content ?? null);
    const id = completionId();
    const started = Date.now();
    // Agent LUÔN có tool → provider CLI trả nguyên khối, không stream token được.
    // Phải gắn header TRƯỚC startSse (writeHead chạy ngay trong đó).
    const isCli = isCliProvider(agent.provider);
    const stream = body.stream
      ? startSse(req, reply, {
          "x-request-id": caller.requestId,
          "x-penai-stream": isCli ? "emulated" : "native",
        })
      : null;
    if (!stream) void reply.header("x-penai-stream", isCli ? "emulated" : "native");

    let queuedMs = 0;
    const qStart = Date.now();
    let emitted = false;
    let finalText = "";
    let iterations = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let runError: string | null = null;
    const toolCalls: Array<{ name: string }> = [];

    try {
      // Khong gate.run o day: buildLoopDeps da boc provider bang chinh gate
      // nay (gatedProvider), nen tran duoc ap o tung luot goi LLM that su.
      {
        {
          const runInput = {
            ctx: caller.ctx,
            agent: {
              systemPrompt: agent.systemPrompt,
              model: agent.model,
              maxIterations: agent.maxIterations,
              ...(ext?.reasoning_effort ? { reasoningEffort: ext.reasoning_effort } : {}),
            },
            sessionId,
            userMessage,
            ...(images.length ? { userImages: images } : {}),
            ...(stream ? { signal: stream.signal } : {}),
          };
          for await (const ev of runAgent(loopDeps, runInput) as AsyncGenerator<AgentEvent>) {
            if (ev.type === "text_delta") {
              finalText += ev.text;
              if (stream) {
                if (!emitted) {
                  stream.send(chatChunk(id, body.model, { role: "assistant" }));
                  emitted = true;
                }
                stream.send(chatChunk(id, body.model, { content: ev.text }));
              }
            } else if (ev.type === "tool_call") {
              toolCalls.push({ name: ev.name });
              if (stream) {
                stream.send(
                  chatChunk(id, body.model, {}, { penai: { tool_call: { name: ev.name } } }),
                );
              }
            } else if (ev.type === "done") {
              iterations = ev.iterations;
              usage = ev.usage;
              if (ev.finalText && ev.finalText !== finalText) {
                // Provider nguyên khối: nội dung chỉ tới ở sự kiện done
                const rest = finalText && ev.finalText.startsWith(finalText)
                  ? ev.finalText.slice(finalText.length)
                  : ev.finalText;
                finalText = ev.finalText;
                if (stream && rest) {
                  if (!emitted) {
                    stream.send(chatChunk(id, body.model, { role: "assistant" }));
                    emitted = true;
                  }
                  stream.send(chatChunk(id, body.model, { content: rest }));
                }
              }
            } else if (ev.type === "error") {
              runError = ev.message;
            }
          }
        }
      }
      // Agent mode: thời gian xếp hàng nằm rải trong từng lượt gọi LLM bên
      // trong vòng lặp (gate bọc ở tầng provider), không đo gộp được ở đây.
    } catch (err) {
      if (err instanceof QueueRejectedError) {
        if (err.reason === "aborted") return;
        throw new ApiError("too_many_concurrent", err.message, {
          retryAfterSec: err.retryAfterSec,
        });
      }
      throw err;
    }

    const durationMs = Date.now() - started;
    const files = await describeApiFiles(caller, outFiles, ext?.return_files ?? "url", ext?.url_ttl_hours);

    recordTraceSafe(db, caller.ctx, {
      agentId: agent.id,
      sessionId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      iterations,
      durationMs,
      source: "api",
      apiKeyId: caller.apiKeyId,
      model: agent.model,
      provider: agent.provider,
      kind: "api_agent",
      ...(runError ? { error: String(runError).slice(0, 500) } : {}),
    });
    void bumpApiUsage(db, caller.ctx, {
      apiKeyId: caller.apiKeyId,
      model: body.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      queuedMs,
      durationMs,
      isError: Boolean(runError),
    }).catch(() => undefined);

    const usageOut = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    };
    const contentWithFiles = appendFileLinks(finalText, files);
    const penaiMeta = {
      route: `${agent.provider}/${agent.model}`,
      request_id: caller.requestId,
      queued_ms: queuedMs,
      agent: agent.key,
      session_id: sessionId,
      ...(convId ? { conversation_id: convId } : {}),
      ...(files.length ? { files } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(isCli ? { stream: "emulated" } : {}),
    };

    if (stream) {
      if (!emitted) {
        stream.send(chatChunk(id, body.model, { role: "assistant" }));
        stream.send(chatChunk(id, body.model, { content: contentWithFiles }));
      } else if (files.length) {
        const suffix = contentWithFiles.slice(finalText.length);
        if (suffix) stream.send(chatChunk(id, body.model, { content: suffix }));
      }
      for (const f of files) {
        stream.send(chatChunk(id, body.model, {}, { penai: { file: f } }));
      }
      stream.send(
        chatChunk(
          id,
          body.model,
          {},
          {
            finishReason: runError ? "error" : "stop",
            ...(body.stream_options?.include_usage ? { usage: usageOut } : {}),
            penai: penaiMeta,
          },
        ),
      );
      stream.done();
      return;
    }

    if (runError && !finalText) {
      throw new ApiError("internal_error", String(runError));
    }
    void reply.header("x-penai-route", `${agent.provider}/${agent.model}`);
    return reply.send({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: contentWithFiles },
          finish_reason: runError ? "error" : "stop",
        },
      ],
      usage: usageOut,
      penai: penaiMeta,
    });
  }

  // ===== File trả ra từ agent =====

  interface ApiFileOut {
    id: string;
    name: string;
    content_type: string;
    bytes: number;
    url?: string;
    b64_json?: string;
    expires_at?: string;
    downgraded?: boolean;
  }

  async function describeApiFiles(
    caller: ApiCaller,
    paths: string[],
    mode: "url" | "b64" | "none",
    ttlHours?: number,
  ): Promise<ApiFileOut[]> {
    if (!paths.length) return [];
    const { stat, readFile } = await import("node:fs/promises");
    const cfg = cfgOf();
    const out: ApiFileOut[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const abs = resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) continue;
      const name = abs.split(/[\\/]/).pop() ?? "file";
      const ct = contentTypeOf(name);
      const base: ApiFileOut = {
        id: `f_${createHash("sha256").update(abs).digest("hex").slice(0, 24)}`,
        name,
        content_type: ct,
        bytes: info.size,
      };
      if (mode === "none") {
        out.push(base);
        continue;
      }
      if (mode === "b64") {
        if (info.size <= cfg.files.inlineB64MaxBytes) {
          base.b64_json = (await readFile(abs)).toString("base64");
          out.push(base);
          continue;
        }
        base.downgraded = true; // quá lớn → tự hạ về link
      }
      const published = await publishForApi(caller, abs, name, ttlHours);
      if (published) {
        base.url = published.url;
        base.expires_at = published.expiresAt;
      }
      out.push(base);
    }
    return out;
  }

  async function publishForApi(
    caller: ApiCaller,
    absPath: string,
    fileName: string,
    ttlHours?: number,
  ): Promise<{ url: string; expiresAt: string } | null> {
    const publicBase = (process.env.PENAI_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (!publicBase) return null;
    const cfg = cfgOf();
    const hours = Math.min(ttlHours ?? cfg.files.urlTtlHours, cfg.files.maxTtlHours);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + hours * 3600_000);
    await createPublishedFile(db, caller.ctx, {
      tokenHash,
      absPath: resolve(absPath),
      fileName,
      contentType: contentTypeOf(fileName),
      createdBy: `api:${caller.apiKeyId}`,
      expiresAt,
    });
    return { url: `${publicBase}/f/${token}`, expiresAt: expiresAt.toISOString() };
  }

  function appendFileLinks(text: string, files: ApiFileOut[]): string {
    const withUrl = files.filter((f) => f.url);
    if (!withUrl.length) return text;
    const lines = withUrl.map((f) =>
      f.content_type.startsWith("image/") ? `![${f.name}](${f.url})` : `[${f.name}](${f.url})`,
    );
    return `${text}\n\n${lines.join("\n")}`.trim();
  }

  // ---------- POST /v1/images/generations ----------
  app.post("/v1/images/generations", async (req, reply) => {
    let caller: ApiCaller;
    try {
      caller = await gateway(req);
    } catch (err) {
      return sendApiError(reply, toApiError(err), newRequestId());
    }
    baseHeaders(reply, caller);

    const parsed = ImageBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendApiError(
        reply,
        new ApiError("invalid_request", parsed.error.issues[0]?.message ?? "Body không hợp lệ"),
        caller.requestId,
      );
    }
    const body = parsed.data;
    const cfg = cfgOf();
    let release: (() => void) | null = null;
    const started = Date.now();
    try {
      await checkQuota(db, caller);
      release = concurrencyEnter(caller.apiKeyId, cfg, caller.policy);
      assertModelAllowed(body.model, cfg, caller.policy);

      let backends = imageBackendsFor(caller.ctx, body.model, cfg);
      const forced = body.penai?.provider;
      if (forced) {
        if (!cfg.providers.includes(forced)) {
          throw new ApiError("provider_not_allowed", `Provider "${forced}" không phục vụ qua API`, {
            param: "penai.provider",
          });
        }
        // Ép provider: ưu tiên ứng viên trong route của model, không có thì backend mặc định.
        const picked = backends.filter((b) => b.provider === forced);
        backends = picked.length
          ? picked
          : imageBackendsFor(caller.ctx, "", cfg).filter((b) => b.provider === forced);
      }
      if (!backends.length) {
        throw new ApiError(
          "all_routes_exhausted",
          forced
            ? `Provider "${forced}" chưa sẵn sàng tạo ảnh`
            : "Không có backend tạo ảnh (cần đăng nhập Antigravity / ChatGPT hoặc OPENAI_API_KEY)",
        );
      }
      const ac = new AbortController();
      req.raw.on("aborted", () => ac.abort());

      // Trần đồng thời áp cho TỪNG lần gọi backend (agy và codex có trần riêng);
      // backend đang bận thì thử backend rảnh trước thay vì đứng chờ.
      const router = new ImageRouter(backends, {
        run: (b, fn) =>
          gate.run(b.provider, fn, {
            bucket: caller.apiKeyId,
            priority: 1,
            signal: ac.signal,
            onQueued: (position) => void reply.header("x-penai-queue-position", String(position)),
          }),
        isBusy: (b) => !gate.isFree(b.provider),
      });
      const refImages = body.penai?.ref_images ?? [];
      const aspectRatio = body.penai?.aspect_ratio;
      // Không ghi size: sửa ảnh / có tỷ lệ khung thì để provider giữ khung, còn lại vuông như OpenAI.
      const size = body.size ?? (refImages.length || aspectRatio ? "auto" : "1024x1024");
      const images = await router.generateMany(
        {
          prompt: body.prompt,
          ...(size !== "auto" ? { size } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(refImages.length ? { refImages } : {}),
          signal: ac.signal,
        },
        body.n,
      );
      const providerName = images[0]?.route.split("/")[0] ?? "";

      const dir = join(
        resolve(rt.config.dataDir),
        caller.ctx.workspaceId,
        "api",
        "images",
        new Date().toISOString().slice(0, 7),
      );
      await mkdir(dir, { recursive: true });

      const data: Array<Record<string, unknown>> = [];
      for (const img of images) {
        const name = `${randomUUID()}.${img.mime.includes("jpeg") ? "jpg" : "png"}`;
        const abs = join(dir, name);
        await writeFile(abs, img.data);
        if (body.response_format === "b64_json") {
          data.push({
            b64_json: img.data.toString("base64"),
            penai: { route: img.route, bytes: img.data.length },
          });
          continue;
        }
        const pub = await publishForApi(caller, abs, name, body.penai?.url_ttl_hours);
        data.push({
          ...(pub ? { url: pub.url, expires_at: pub.expiresAt } : { b64_json: img.data.toString("base64") }),
          penai: {
            route: img.route,
            bytes: img.data.length,
            ...(pub ? {} : { note: "PENAI_PUBLIC_URL chưa cấu hình → trả base64" }),
          },
        });
      }

      const durationMs = Date.now() - started;
      recordTraceSafe(db, caller.ctx, {
        inputTokens: 0,
        outputTokens: 0,
        iterations: images.length,
        durationMs,
        source: "api",
        apiKeyId: caller.apiKeyId,
        model: body.model,
        provider: providerName,
        kind: "api_image",
      });
      void bumpApiUsage(db, caller.ctx, {
        apiKeyId: caller.apiKeyId,
        model: body.model,
        images: images.length,
        durationMs,
      }).catch(() => undefined);

      return reply.send({ created: Math.floor(Date.now() / 1000), data });
    } catch (err) {
      if (err instanceof QueueRejectedError) {
        const e = new ApiError("too_many_concurrent", err.message, {
          retryAfterSec: err.retryAfterSec,
        });
        return sendApiError(reply, e, caller.requestId);
      }
      const apiErr = toApiError(err);
      void bumpApiUsage(db, caller.ctx, {
        apiKeyId: caller.apiKeyId,
        model: body.model,
        isError: true,
      }).catch(() => undefined);
      recordTraceSafe(db, caller.ctx, {
        inputTokens: 0,
        outputTokens: 0,
        iterations: 0,
        durationMs: Date.now() - started,
        error: apiErr.message.slice(0, 500),
        source: "api",
        apiKeyId: caller.apiKeyId,
        model: body.model,
        kind: "api_image",
      });
      return sendApiError(reply, apiErr, caller.requestId);
    } finally {
      release?.();
    }
  });

  /**
   * Backend tạo ảnh theo model: alias (ứng viên kind "images") hoặc "<provider>/<model>".
   * Model rỗng / không phải alias ảnh → chuỗi mặc định Antigravity → codex;
   * không có provider nào thì mới dùng OPENAI_API_KEY.
   */
  function imageBackendsFor(
    ctx: WorkspaceContext,
    model: string,
    cfg: PenaiConfig["api"],
  ): ImageBackend[] {
    let route: Array<{ provider: string; model?: string }>;
    const slash = model.indexOf("/");
    if (slash > 0) {
      const provider = model.slice(0, slash);
      if (!cfg.providers.includes(provider)) {
        throw new ApiError(
          "provider_not_allowed",
          `Provider "${provider}" không phục vụ qua API (được phép: ${cfg.providers.join(", ")})`,
          { param: "model" },
        );
      }
      route = [{ provider, model: model.slice(slash + 1) }];
    } else {
      route = cfg.models[model]?.route.filter((c) => c.kind === "images") ?? [];
      if (!route.length) {
        route = [{ provider: "antigravity" }, { provider: "codex" }].filter((c) =>
          cfg.providers.includes(c.provider),
        );
      }
    }
    const backends: ImageBackend[] = [];
    for (const cand of route) {
      let p: Provider;
      try {
        p = rt.providers.get(cand.provider, ctx.workspaceId);
      } catch {
        continue; // provider chưa cấu hình → bỏ qua ứng viên
      }
      const opts = cand.model ? { model: cand.model } : {};
      if (p instanceof AntigravityProvider) backends.push(antigravityImageBackend(p, opts));
      else if (p instanceof CodexProvider) backends.push(codexImageBackend(p, opts));
    }
    const key = process.env.OPENAI_API_KEY;
    if (!backends.length && key) backends.push(openAIImageBackend(key));
    return backends;
  }

  // ---------- GET /v1/api/status (giám sát hàng đợi) ----------
  app.get("/v1/api/status", async (req, reply) => {
    let caller: ApiCaller;
    try {
      caller = await gateway(req);
    } catch (err) {
      return sendApiError(reply, toApiError(err), newRequestId());
    }
    baseHeaders(reply, caller);
    return reply.send({
      enabled: cfgOf().enabled,
      queue: gate.stats(),
      cooldowns: routeState.snapshot(),
      models: Object.keys(cfgOf().models),
    });
  });

  logger.info(
    `API công khai: ${cfgOf().enabled ? "BẬT" : "tắt"} — model ${Object.keys(cfgOf().models).join(", ") || "(chưa cấu hình)"}`,
  );
}
