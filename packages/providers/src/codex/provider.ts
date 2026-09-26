import { randomUUID } from "node:crypto";
import { logger, type ToolCallData } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
} from "../types.js";
import { type CodexAuth, DEFAULT_AUTH_FILE } from "./oauth.js";
import {
  CodexAccountManager,
  DEFAULT_ACCOUNTS_DIR,
  type CodexAccountPublic,
} from "./accounts.js";
import { parseSupportedEfforts, pickSupportedEffort } from "./reasoning.js";

const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";

type ResponseItem =
  | {
      type: "message";
      role: string;
      content: Array<{ type: string; text?: string }>;
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: string; [k: string]: unknown };

/**
 * Provider dùng gói ChatGPT subscription qua OAuth (spec-codex-provider.md).
 * Backend: OpenAI Responses API tại chatgpt.com — luôn stream SSE.
 *
 * Hỗ trợ NHIỀU tài khoản ChatGPT xoay vòng (CodexAccountManager): mỗi request
 * chọn tài khoản ít việc nhất, tài khoản nghẽn 429/hết quota bị cooldown và
 * request failover ngay sang tài khoản khác — nhiều người chat cùng lúc được
 * chia đều lên các gói subscription.
 */
/**
 * Model không dùng được trên tài khoản ChatGPT hiện tại → tự đổi sang model
 * tương đương còn chạy, thay vì để 400 dội thẳng vào người dùng.
 *
 * MẶC ĐỊNH RỖNG — không đổi gì cả.
 *
 * Vì sao có cơ chế này: 13/09/2026 gói ChatGPT Plus của tài khoản hết hạn, tài
 * khoản tụt về `free`, `gpt-5.6-sol` và `gpt-6-astra` biến mất khỏi danh sách
 * model và mọi lời gọi trả 400 "not supported when using Codex with a ChatGPT
 * account". 7 agent (3 kênh đang bật) + app ngoài gọi đích danh `gpt-5.6-sol`
 * chết đồng loạt. Điền bảng này là che được cho MỌI lối vào (API công khai,
 * agent, kênh chat, cron) trong một lần, không phải sửa DB agent hay báo app
 * ngoài đổi code.
 *
 * Cách dùng khi gặp lại: điền vào đây hoặc — tốt hơn, không cần deploy —
 * đặt `providers.codex.modelRewrites = { "cũ": "mới" }` trong config.
 * Nhớ XOÁ đi khi model có lại, nếu không sẽ âm thầm chạy sai model.
 */
export const DEFAULT_CODEX_MODEL_REWRITES: Record<string, string> = {};

export class CodexProvider implements Provider {
  readonly accounts: CodexAccountManager;
  private rewrites: Record<string, string>;
  /** Đã log cảnh báo cho model nào rồi — tránh spam log mỗi request. */
  private warnedRewrites = new Set<string>();
  /** Mức suy luận model chấp nhận, học từ lỗi 400 (theo tên model gửi đi). */
  private effortSupport = new Map<string, string[]>();
  private warnedEfforts = new Set<string>();

  constructor(
    readonly name: string,
    private cfg: {
      authFile?: string;
      accountsDir?: string;
      modelRewrites?: Record<string, string>;
    } = {},
  ) {
    this.accounts = new CodexAccountManager(
      cfg.authFile ?? DEFAULT_AUTH_FILE,
      cfg.accountsDir ?? DEFAULT_ACCOUNTS_DIR,
    );
    this.rewrites = { ...DEFAULT_CODEX_MODEL_REWRITES, ...(cfg.modelRewrites ?? {}) };
  }

  /** Tên model thực sự gửi lên ChatGPT (sau khi đổi model đã bị gỡ). */
  effectiveModel(model: string): string {
    const next = this.rewrites[model];
    if (!next || next === model) return model;
    if (!this.warnedRewrites.has(model)) {
      this.warnedRewrites.add(model);
      logger.warn(
        `Codex: model "${model}" không còn khả dụng trên tài khoản ChatGPT — tự dùng "${next}" thay thế`,
      );
    }
    return next;
  }

  /** Mức suy luận thực sự gửi đi — đổi sang mức gần nhất model chấp nhận (nếu đã biết). */
  private effortFor(model: string, requested: string): string {
    const supported = this.effortSupport.get(model);
    if (!supported) return requested;
    const effort = pickSupportedEffort(requested, supported);
    const key = `${model}:${requested}`;
    if (effort !== requested && !this.warnedEfforts.has(key)) {
      this.warnedEfforts.add(key);
      logger.warn(
        `Codex: model "${model}" không nhận mức suy luận "${requested}" — tự dùng "${effort}"`,
      );
    }
    return effort;
  }

  /**
   * Lỗi 400 do mức suy luận không hợp lệ → nhớ danh sách mức model chấp nhận.
   * Trả true khi vừa học được điều mới (gửi lại 1 lần sẽ khác lần trước).
   */
  private learnEffortSupport(req: ChatRequest, errorText: string): boolean {
    if (!req.reasoningEffort) return false;
    const supported = parseSupportedEfforts(errorText);
    if (!supported) return false;
    const model = this.effectiveModel(req.model);
    const before = this.effortFor(model, req.reasoningEffort);
    this.effortSupport.set(model, supported);
    return this.effortFor(model, req.reasoningEffort) !== before;
  }

  /** Lấy token của 1 tài khoản; lỗi auth được gắn cờ để failover sang tài khoản khác. */
  private async authFor(alias: string, force = false): Promise<CodexAuth> {
    try {
      return await this.accounts.freshAuth(alias, force);
    } catch (err) {
      (err as Error & { authFail?: boolean }).authFail = true;
      throw err;
    }
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const input: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === "user") {
        const content: unknown[] = [{ type: "input_text", text: m.content }];
        for (const img of m.images ?? []) {
          content.push({ type: "input_image", image_url: img });
        }
        input.push({ type: "message", role: "user", content });
      } else if (m.role === "assistant") {
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        for (const tc of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            name: tc.name,
            arguments: JSON.stringify(tc.args),
            call_id: tc.id,
          });
        }
      } else {
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        });
      }
    }
    const model = this.effectiveModel(req.model);
    return {
      model,
      instructions: req.system || "You are a helpful assistant.",
      input,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              strict: false,
              parameters: t.parameters,
            })),
            tool_choice: "auto",
            parallel_tool_calls: false,
          }
        : {}),
      ...(req.reasoningEffort
        ? { reasoning: { effort: this.effortFor(model, req.reasoningEffort) } }
        : {}),
      store: false,
      stream: true,
    };
  }

  /**
   * Stream với pool tài khoản:
   * - 1 tài khoản: retry tại chỗ tối đa 3 lần (backoff + tôn trọng Retry-After).
   * - Nhiều tài khoản: mỗi tài khoản CHỈ thử 1 lần — dính 429/5xx là đánh dấu
   *   cooldown và chuyển ngay sang tài khoản kế (tránh ngồi chờ Retry-After
   *   trên tài khoản đã cạn quota trong khi tài khoản khác đang rảnh).
   * Guard an toàn: đã yield text ra ngoài thì KHÔNG retry/failover (tránh lặp
   * nội dung người dùng đã thấy).
   */
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    return this.streamWithPool(req, false);
  }

  /**
   * buffered=true: người gọi (chat() không stream) tự gom sự kiện, chưa có gì
   * lọt ra client → đứt kết nối giữa chừng vẫn retry được từ đầu. Lượt hỏng
   * không bao giờ phát "done" nên không lẫn nội dung cụt vào kết quả.
   */
  private async *streamWithPool(
    req: ChatRequest,
    buffered: boolean,
  ): AsyncIterable<StreamEvent> {
    const order = this.accounts.pickOrder();
    if (!order.length) {
      // status 503 để router API coi là lỗi tạm thời → nhảy sang provider dự
      // phòng (api.fallback) thay vì dừng luôn (14/09/2026).
      const err = new Error(
        "Chưa đăng nhập ChatGPT — thêm tài khoản trong trang Providers (hoặc pnpm codex:login)",
      ) as Error & { status: number };
      err.status = 503;
      throw err;
    }
    const multi = order.length > 1;
    let yielded = false;
    let lastErr: unknown;

    for (let ai = 0; ai < order.length; ai++) {
      const alias = order[ai]!.alias;
      const maxAttempts = multi ? 1 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this.accounts.acquire(alias);
        try {
          for await (const ev of this.streamOnce(req, alias)) {
            yielded = true;
            yield ev;
          }
          this.accounts.markOk(alias);
          return;
        } catch (err) {
          lastErr = err;
          const status = (err as { status?: number }).status;
          const authFail = (err as { authFail?: boolean }).authFail === true;
          const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
          if (status === 429 || (typeof status === "number" && status >= 500)) {
            this.accounts.markThrottled(alias, retryAfterMs);
          }
          const retryable =
            authFail ||
            (typeof status === "number"
              ? status === 429 || status >= 500
              : // "terminated"/"other side closed" = undici báo backend đóng socket
                // giữa lúc đọc SSE (13/09/2026: 503 lọt ra app vì thiếu mẫu này)
                /response\.failed|fetch failed|network|ECONNRESET|timeout|terminated|other side closed|UND_ERR_SOCKET|kết thúc bất thường/i.test(
                  (err as Error).message ?? "",
                ));
          if ((yielded && !buffered) || req.signal?.aborted || !retryable) throw err;
          if (!multi && !authFail && attempt < maxAttempts - 1) {
            const delay = retryAfterMs ?? 500 * 2 ** attempt + Math.random() * 200;
            await new Promise((r) => setTimeout(r, delay));
            continue; // retry cùng tài khoản
          }
          break; // sang tài khoản kế
        } finally {
          this.accounts.release(alias);
        }
      }
    }
    throw lastErr;
  }

  private async *streamOnce(req: ChatRequest, alias: string): AsyncIterable<StreamEvent> {
    let auth = await this.authFor(alias);

    const doFetch = (a: CodexAuth) =>
      fetch(CODEX_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.accessToken}`,
          "chatgpt-account-id": a.accountId,
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          session_id: randomUUID(),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(this.buildBody(req)),
        ...(req.signal ? { signal: req.signal } : {}),
      });

    let res = await doFetch(auth);
    if (res.status === 401) {
      // access token hết hạn giữa chừng → refresh 1 lần rồi thử lại
      auth = await this.authFor(alias, true);
      res = await doFetch(auth);
      if (res.status === 401) {
        // refresh xong vẫn 401 → tài khoản hỏng thật, loại khỏi vòng xoay
        this.accounts.markNeedsReauth(alias);
        const err = new Error(
          `Codex: tài khoản "${alias}" bị từ chối (401) — cần đăng nhập lại`,
        ) as Error & { authFail: boolean };
        err.authFail = true;
        throw err;
      }
    }
    const apiError = (r: Response, text: string) => {
      const err = new Error(
        `Codex API lỗi ${r.status}: ${text.slice(0, 500)}`,
      ) as Error & { status: number; retryAfterMs?: number };
      err.status = r.status;
      const ra = Number(r.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
      return err;
    };
    if (res.status === 400 && req.reasoningEffort) {
      // Model không nhận mức suy luận này → học mức hợp lệ rồi gửi lại ĐÚNG 1
      // lần (chưa có chữ nào ra ngoài nên gửi lại an toàn).
      const text = await res.text().catch(() => "");
      if (!this.learnEffortSupport(req, text)) throw apiError(res, text);
      res = await doFetch(auth);
    }
    if (!res.ok || !res.body) {
      throw apiError(res, await res.text().catch(() => ""));
    }

    // Parse SSE
    let content = "";
    const toolCalls: ToolCallData[] = [];
    const seenToolIds = new Set<string>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let completedText: string | null = null;
    let truncated = false;
    let sawTerminal = false;
    // Tích lũy function_call qua delta — phòng backend không gửi output_item.done
    const pendingCalls = new Map<
      string,
      { name?: string; callId?: string; args: string }
    >();

    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const addToolCall = (fc: {
      name?: string;
      arguments?: string;
      call_id?: string;
      id?: string;
    }) => {
      const id = fc.call_id ?? fc.id;
      if (!id || !fc.name || seenToolIds.has(id)) return;
      seenToolIds.add(id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fc.arguments || "{}");
      } catch {
        args = { _raw: fc.arguments };
      }
      toolCalls.push({ id, name: fc.name, args });
    };

    const collectFromItem = (item: ResponseItem | undefined) => {
      if (!item) return;
      if (item.type === "function_call") {
        addToolCall(item as Parameters<typeof addToolCall>[0]);
      } else if (item.type === "message") {
        const msg = item as { content?: Array<{ type: string; text?: string }> };
        const text = (msg.content ?? [])
          .filter((c) => c.type === "output_text" && c.text)
          .map((c) => c.text)
          .join("");
        if (text) completedText = (completedText ?? "") + text;
      }
    };

    const flushPendingCalls = () => {
      for (const p of pendingCalls.values()) {
        if (p.name && (p.callId || p.args)) {
          addToolCall({
            ...(p.name ? { name: p.name } : {}),
            ...(p.callId ? { call_id: p.callId } : {}),
            arguments: p.args,
          });
        }
      }
      pendingCalls.clear();
    };

    const handleEvent = (payload: unknown): StreamEvent | null => {
      const ev = payload as {
        type?: string;
        delta?: string;
        item?: ResponseItem;
        item_id?: string;
        response?: unknown;
      };
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        content += ev.delta;
        return { type: "text_delta", text: ev.delta };
      }
      // Theo dõi function_call qua added + arguments.delta (dự phòng khi
      // backend không gửi output_item.done đầy đủ)
      if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
        const it = ev.item as { id?: string; name?: string; call_id?: string };
        if (it.id) {
          pendingCalls.set(it.id, {
            ...(it.name ? { name: it.name } : {}),
            ...(it.call_id ? { callId: it.call_id } : {}),
            args: "",
          });
        }
      }
      if (
        ev.type === "response.function_call_arguments.delta" &&
        ev.item_id &&
        typeof ev.delta === "string"
      ) {
        const p = pendingCalls.get(ev.item_id) ?? { args: "" };
        p.args += ev.delta;
        pendingCalls.set(ev.item_id, p);
      }
      // Function call + message hoàn tất đến qua từng item — nguồn đáng tin cậy
      // (response.completed.output[] có thể RỖNG khi stream function_call).
      if (ev.type === "response.output_item.done") {
        collectFromItem(ev.item);
        const it = ev.item as { id?: string } | undefined;
        if (it?.id) pendingCalls.delete(it.id);
      }
      if (ev.type === "response.failed") {
        const r = ev.response as { error?: { message?: string } } | undefined;
        throw new Error(`Codex response.failed: ${r?.error?.message ?? "không rõ"}`);
      }
      if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        sawTerminal = true;
        if (ev.type === "response.incomplete") truncated = true;
        const r = ev.response as {
          output?: ResponseItem[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        for (const item of r.output ?? []) collectFromItem(item); // dự phòng
        flushPendingCalls(); // dự phòng cuối: args tích lũy từ delta
        usage = {
          inputTokens: r.usage?.input_tokens ?? 0,
          outputTokens: r.usage?.output_tokens ?? 0,
        };
      }
      return null;
    };

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        } else if (line === "") {
          const data = dataLines.join("\n");
          dataLines = [];
          if (!data || data === "[DONE]") continue;
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          const out = handleEvent(payload);
          if (out) yield out;
        }
        // dòng "event: ..." bỏ qua — type đã nằm trong data JSON
      }
    }

    // Stream đứt giữa chừng (mất mạng) mà không có response.completed:
    // trả về như thể xong sẽ lưu câu trả lời CỤT thành câu trả lời cuối.
    // Báo lỗi để lượt chat thất bại rõ ràng thay vì âm thầm sai.
    if (!sawTerminal) {
      throw new Error(
        "Codex: stream kết thúc bất thường (mất kết nối giữa chừng) — câu trả lời chưa hoàn tất",
      );
    }

    const finalContent = content || completedText;
    yield {
      type: "done",
      response: {
        content: finalContent || null,
        toolCalls,
        stopReason: truncated
          ? "max_tokens"
          : toolCalls.length > 0
            ? "tool_use"
            : "end",
        usage,
      },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let response: ChatResponse | undefined;
    for await (const ev of this.streamWithPool(req, true)) {
      if (ev.type === "done") response = ev.response;
    }
    if (!response) throw new Error("Codex: stream kết thúc mà không có kết quả");
    return response;
  }

  /**
   * Tạo ảnh bằng gói ChatGPT subscription qua Responses API:
   * gửi Responses API với tool image_generation + tool_choice ép, đọc SSE
   * lấy item image_generation_call.result (base64).
   */
  async generateImage(req: {
    prompt: string;
    size?: string;
    model?: string;
    refImages?: string[];
  }): Promise<{ data: Buffer; mime: string }> {
    const order = this.accounts.pickOrder();
    if (!order.length) {
      throw new Error("Chưa đăng nhập ChatGPT — thêm tài khoản trong trang Providers");
    }
    let lastErr: unknown;
    for (const acc of order) {
      this.accounts.acquire(acc.alias);
      try {
        const out = await this.generateImageOn(acc.alias, req);
        this.accounts.markOk(acc.alias);
        return out;
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        if (status === 429 || (typeof status === "number" && status >= 500)) {
          this.accounts.markThrottled(acc.alias, (err as { retryAfterMs?: number }).retryAfterMs);
          continue; // thử tài khoản kế
        }
        if ((err as { authFail?: boolean }).authFail) continue;
        throw err;
      } finally {
        this.accounts.release(acc.alias);
      }
    }
    throw lastErr;
  }

  private async generateImageOn(
    alias: string,
    req: { prompt: string; size?: string; model?: string; refImages?: string[] },
  ): Promise<{ data: Buffer; mime: string }> {
    let auth = await this.authFor(alias);
    const content: unknown[] = [];
    for (const img of req.refImages ?? []) {
      content.push({ type: "input_image", image_url: img });
    }
    content.push({ type: "input_text", text: req.prompt });
    const body = {
      model: this.effectiveModel(req.model || "gpt-5.5"),
      stream: true,
      store: false,
      instructions:
        "Use the image_generation tool to create the image the user asks for. Respond with the image only, without any text.",
      input: [{ role: "user", content }],
      tools: [
        {
          type: "image_generation",
          action: "generate",
          model: "gpt-image-2",
          output_format: "png",
          size: req.size || "1024x1024",
        },
      ],
      tool_choice: { type: "image_generation" },
    };
    const doFetch = (a: CodexAuth) =>
      fetch(CODEX_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.accessToken}`,
          "chatgpt-account-id": a.accountId,
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          session_id: randomUUID(),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        // 360s: gpt-image lúc tải cao có thể render >180s — render chậm-nhưng-xong vẫn hơn abort + retry
        signal: AbortSignal.timeout(360_000),
      });
    let res = await doFetch(auth);
    if (res.status === 401) {
      auth = await this.authFor(alias, true);
      res = await doFetch(auth);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const err = new Error(
        `Codex tạo ảnh lỗi ${res.status}: ${text.slice(0, 300)}`,
      ) as Error & { status: number; retryAfterMs?: number };
      err.status = res.status;
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
      throw err;
    }
    // Quét SSE tìm image_generation_call.result
    const decoder = new TextDecoder();
    let buffer = "";
    let b64 = "";
    let format = "png";
    const scan = (payload: unknown) => {
      const ev = payload as {
        type?: string;
        item?: { type?: string; result?: string; output_format?: string };
        response?: {
          output?: Array<{ type?: string; result?: string; output_format?: string }>;
        };
      };
      if (
        ev.type === "response.output_item.done" &&
        ev.item?.type === "image_generation_call" &&
        ev.item.result
      ) {
        b64 = ev.item.result;
        if (ev.item.output_format) format = ev.item.output_format;
      }
      if (ev.type === "response.completed") {
        for (const it of ev.response?.output ?? []) {
          if (it.type === "image_generation_call" && it.result) {
            b64 = it.result;
            if (it.output_format) format = it.output_format;
          }
        }
      }
      if (ev.type === "response.failed") {
        const r = payload as { response?: { error?: { message?: string } } };
        throw new Error(
          `Codex tạo ảnh thất bại: ${r.response?.error?.message ?? "không rõ"}`,
        );
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          scan(JSON.parse(data));
        } catch (err) {
          if ((err as Error).message.startsWith("Codex tạo ảnh")) throw err;
        }
      }
    }
    if (!b64) throw new Error("Codex tạo ảnh: không nhận được ảnh trong stream");
    return {
      data: Buffer.from(b64, "base64"),
      mime: format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png",
    };
  }

  /** Danh sách model tài khoản ChatGPT hiện dùng được (cho UI chọn model). */
  async listModels(): Promise<
    Array<{ slug: string; displayName: string; contextWindow: number }>
  > {
    const first = this.accounts.pickOrder()[0];
    if (!first) throw new Error("Chưa đăng nhập ChatGPT");
    const auth = await this.authFor(first.alias);
    const res = await fetch(
      "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0",
      {
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          originator: "codex_cli_rs",
        },
      },
    );
    if (!res.ok) throw new Error(`Codex list models lỗi ${res.status}`);
    const data = (await res.json()) as {
      models?: Array<{
        slug: string;
        display_name?: string;
        context_window?: number;
        visibility?: string;
      }>;
    };
    return (data.models ?? [])
      .filter((m) => m.visibility !== "hidden")
      .map((m) => ({
        slug: m.slug,
        displayName: m.display_name ?? m.slug,
        contextWindow: m.context_window ?? 0,
      }));
  }

  /** Thông tin đăng nhập hiện tại (tài khoản đầu tiên) — null nếu chưa login. */
  authInfo(): { email?: string; accountId: string } | null {
    const list = this.accounts.list();
    const a = list[0];
    if (!a) return null;
    return { ...(a.email ? { email: a.email } : {}), accountId: a.accountId };
  }

  /** Danh sách tài khoản trong pool (cho UI Providers). */
  listAccounts(): CodexAccountPublic[] {
    return this.accounts.list();
  }
}
