/**
 * Provider HoiAI (chat.hoiai.vn) — cổng AI tương thích OpenAI do HoiAI vận hành,
 * phía sau gọi Qwen (sau này thêm nguồn khác). Một khóa dùng cho chat (chữ, ảnh,
 * âm thanh), embedding và tạo ảnh.
 *
 * Khác OpenAI-compatible thường ở chỗ HoiAI TỰ KHAI BÁO khả năng từng model trong
 * `/models` (trường `type`, `input_modalities`, `dimensions`…) — PenAI đọc đó thay
 * vì đoán theo tên. Khóa lấy bằng "Đăng nhập HoiAI" (mã kích hoạt, chuẩn OAuth
 * Device Authorization Grant — RFC 8628) hoặc dán tay; hai cách ra cùng một khóa.
 */

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatRequest, EmbeddingModelInfo } from "./types.js";
import type { ImageBackend, ImageRequest } from "./images/index.js";

export const HOIAI_DEFAULT_BASE = "https://chat.hoiai.vn/api/v1";

/** Base URL mặc định — biến môi trường cho phép trỏ sang máy thử của HoiAI. */
export function hoiaiDefaultBase(): string {
  return (process.env.PENAI_HOIAI_BASE_URL?.trim() || HOIAI_DEFAULT_BASE).replace(/\/$/, "");
}

/** Một model trong `/models` của HoiAI (chỉ các trường PenAI dùng; trường lạ bỏ qua). */
export interface HoiaiModelInfo {
  id: string;
  type?: string;
  display_name?: string;
  input_modalities?: string[];
  context_window?: number;
  supports_tools?: boolean;
  reasoning_efforts?: string[];
  dimensions?: number[];
  default_dimensions?: number;
  status?: string;
}

export interface HoiaiAccount {
  key_name?: string;
  account_email?: string;
  email?: string;
  credit_vnd?: number;
  allowed_models?: string[];
  topup_url?: string;
  [key: string]: unknown;
}

const MODELS_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 180_000;

/** Lỗi gọi HoiAI kèm mã HTTP — `status` để retry/fallback và báo lỗi như lỗi SDK. */
export class HoiaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HoiaiError";
  }
}

async function readError(res: Response, what: string): Promise<HoiaiError> {
  let code: string | undefined;
  let message = "";
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string } | string; message?: string };
    if (typeof j.error === "string") code = j.error;
    else if (j.error) {
      code = j.error.code;
      message = j.error.message ?? "";
    }
    if (!message && typeof j.message === "string") message = j.message;
  } catch {
    /* body không phải JSON */
  }
  if (res.status === 402) message = message || "Hết credit HoiAI — nạp thêm tại chat.hoiai.vn";
  if (res.status === 401) message = message || "Khóa HoiAI không hợp lệ hoặc đã bị thu hồi — hãy đăng nhập lại";
  return new HoiaiError(`HoiAI ${what}: ${message || `HTTP ${res.status}`}`, res.status, code);
}

/** Nhận dạng định dạng ảnh theo vài byte đầu (HoiAI trả base64 không kèm mime). */
function sniffImageMime(data: Buffer): string {
  if (data.length > 4 && data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.length > 12 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") {
    return "image/webp";
  }
  return "image/png";
}

export class HoiaiProvider extends OpenAICompatProvider {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private modelsCache: { at: number; models: HoiaiModelInfo[] } | null = null;
  private modelsInflight: Promise<HoiaiModelInfo[]> | null = null;

  constructor(name: string, cfg: { baseURL?: string; apiKey: string }) {
    const baseUrl = (cfg.baseURL?.trim() || hoiaiDefaultBase()).replace(/\/$/, "");
    super(name, { baseURL: baseUrl, apiKey: cfg.apiKey });
    this.baseUrl = baseUrl;
    this.apiKey = cfg.apiKey;
  }

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  }

  /** Danh mục model kèm khả năng (cache 5 phút; lỗi mạng dùng lại bản cũ nếu có). */
  async models(force = false): Promise<HoiaiModelInfo[]> {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < MODELS_TTL_MS) {
      return this.modelsCache.models;
    }
    if (this.modelsInflight) return this.modelsInflight;
    this.modelsInflight = (async () => {
      try {
        const res = await this.request("/models");
        if (!res.ok) throw await readError(res, "đọc danh sách model");
        const j = (await res.json()) as { data?: HoiaiModelInfo[] };
        const models = (j.data ?? []).filter((m) => m && typeof m.id === "string" && m.status !== "disabled");
        this.modelsCache = { at: Date.now(), models };
        return models;
      } catch (err) {
        if (this.modelsCache) return this.modelsCache.models;
        throw err;
      } finally {
        this.modelsInflight = null;
      }
    })();
    return this.modelsInflight;
  }

  private cachedModel(id: string): HoiaiModelInfo | undefined {
    return this.modelsCache?.models.find((m) => m.id === id);
  }

  async modelInfo(id: string): Promise<HoiaiModelInfo | null> {
    try {
      return (await this.models()).find((m) => m.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async inputModalities(model: string): Promise<string[] | null> {
    return (await this.modelInfo(model))?.input_modalities ?? null;
  }

  protected override acceptsAudio(model: string): boolean {
    return this.cachedModel(model)?.input_modalities?.includes("audio") ?? false;
  }

  /**
   * HoiAI nhận reasoning_effort cho mọi model chat (none/low/medium/high → bật/tắt
   * suy nghĩ của Qwen). "minimal" của PenAI = tắt suy nghĩ. Không chọn mức thì
   * không gửi — HoiAI dùng mặc định của model.
   */
  protected override reasoningEffortParam(req: ChatRequest): string | undefined {
    if (!req.reasoningEffort) return undefined;
    const effort = req.reasoningEffort === "minimal" ? "none" : req.reasoningEffort;
    const allowed = this.cachedModel(req.model)?.reasoning_efforts;
    if (allowed?.length && !allowed.includes(effort)) return undefined;
    return effort;
  }

  override async listModels(): Promise<Array<{ slug: string; displayName: string; contextWindow: number }>> {
    const models = await this.models(true);
    return models
      .filter((m) => (m.type ? m.type === "chat" : !/(embed|image|transcri|audio|speech)/i.test(m.id)))
      .map((m) => ({ slug: m.id, displayName: m.display_name || m.id, contextWindow: m.context_window ?? 0 }));
  }

  override async listEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    const models = await this.models();
    return models
      .filter((m) => (m.type ? m.type === "embedding" : /embed/i.test(m.id)))
      .map((m) => ({ slug: m.id, displayName: m.display_name || m.id, dimensions: m.dimensions ?? [] }));
  }

  /** Model tạo ảnh đầu tiên HoiAI mở cho khóa này (null = không có). */
  async imageModel(): Promise<string | null> {
    try {
      return (await this.models()).find((m) => m.type === "image")?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Tạo ảnh (có ảnh mẫu → /images/edits). HoiAI tự chờ nguồn và trả b64_json. */
  async generateImage(req: ImageRequest, model?: string): Promise<{ data: Buffer; mime: string }> {
    const useModel = model || (await this.imageModel());
    if (!useModel) throw new HoiaiError("HoiAI: khóa này chưa được mở model tạo ảnh", 404, "model_not_found");
    const body: Record<string, unknown> = {
      model: useModel,
      prompt: req.prompt,
      n: 1,
      response_format: "b64_json",
      ...(req.size ? { size: req.size } : {}),
      ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
      ...(req.refImages?.length ? { images: req.refImages } : {}),
    };
    const res = await this.request(req.refImages?.length ? "/images/edits" : "/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: IMAGE_TIMEOUT_MS,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!res.ok) throw await readError(res, "tạo ảnh");
    const j = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = j.data?.[0];
    if (item?.b64_json) {
      const data = Buffer.from(item.b64_json, "base64");
      return { data, mime: sniffImageMime(data) };
    }
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new HoiaiError(`HoiAI: không tải được ảnh kết quả (HTTP ${img.status})`, 502);
      const data = Buffer.from(await img.arrayBuffer());
      return { data, mime: img.headers.get("content-type")?.split(";")[0] || sniffImageMime(data) };
    }
    throw new HoiaiError("HoiAI: phản hồi tạo ảnh không có b64_json", 502);
  }

  /** Tài khoản của khóa: email, credit, link nạp tiền. */
  async account(): Promise<HoiaiAccount> {
    const res = await this.request("/me");
    if (!res.ok) throw await readError(res, "đọc tài khoản");
    return (await res.json()) as HoiaiAccount;
  }

  /** Thu hồi chính khóa đang dùng (Ngắt kết nối). 401/404 = khóa đã chết sẵn → coi như xong. */
  async revokeKey(): Promise<void> {
    const res = await this.request("/me/key", { method: "DELETE" });
    if (res.ok || res.status === 401 || res.status === 404) return;
    throw await readError(res, "thu hồi khóa");
  }
}

/** Backend tạo ảnh cho ImageRouter (tool image_generation + /v1/images/generations). */
export function hoiaiImageBackend(provider: HoiaiProvider, model?: string): ImageBackend {
  return {
    name: `${provider.name}/${model ?? "image"}`,
    provider: provider.name,
    generate: (req) => provider.generateImage(req, model),
  };
}

// ===== Đăng nhập bằng mã kích hoạt (RFC 8628) =====

export interface HoiaiDeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type HoiaiDevicePoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | {
      status: "ok";
      apiKey: string;
      keyId?: string;
      keyName?: string;
      apiBase?: string;
      account?: { email?: string; name?: string; credit_vnd?: number };
    };

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Bước 1: xin mã kích hoạt để người dùng nhập trên trang HoiAI. */
export async function hoiaiDeviceStart(opts: {
  baseUrl?: string;
  clientName: string;
  clientUrl?: string;
  clientVersion?: string;
}): Promise<HoiaiDeviceStart> {
  const base = (opts.baseUrl?.trim() || hoiaiDefaultBase()).replace(/\/$/, "");
  const res = await postJson(`${base}/oauth/device/code`, {
    client_id: "penai",
    client_name: opts.clientName,
    ...(opts.clientUrl ? { client_url: opts.clientUrl } : {}),
    ...(opts.clientVersion ? { client_version: opts.clientVersion } : {}),
    scope: "api",
  });
  if (!res.ok) throw await readError(res, "xin mã kích hoạt");
  const j = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!j.device_code || !j.user_code || !j.verification_uri) {
    throw new HoiaiError("HoiAI trả mã kích hoạt thiếu trường", 502);
  }
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    verificationUriComplete:
      j.verification_uri_complete ||
      `${j.verification_uri}${j.verification_uri.includes("?") ? "&" : "?"}code=${encodeURIComponent(j.user_code)}`,
    expiresIn: j.expires_in ?? 600,
    interval: Math.max(2, j.interval ?? 5),
  };
}

/** Bước 2: hỏi một lần xem người dùng đã bấm Đồng ý chưa. */
export async function hoiaiDevicePoll(opts: { baseUrl?: string; deviceCode: string }): Promise<HoiaiDevicePoll> {
  const base = (opts.baseUrl?.trim() || hoiaiDefaultBase()).replace(/\/$/, "");
  const res = await postJson(`${base}/oauth/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: opts.deviceCode,
    client_id: "penai",
  });
  if (res.ok) {
    const j = (await res.json()) as {
      api_key?: string;
      key_id?: string;
      key_name?: string;
      api_base?: string;
      account?: { email?: string; name?: string; credit_vnd?: number };
    };
    if (!j.api_key) throw new HoiaiError("HoiAI trả kết quả đăng nhập không có api_key", 502);
    return {
      status: "ok",
      apiKey: j.api_key,
      ...(j.key_id ? { keyId: j.key_id } : {}),
      ...(j.key_name ? { keyName: j.key_name } : {}),
      ...(j.api_base ? { apiBase: j.api_base.replace(/\/$/, "") } : {}),
      ...(j.account ? { account: j.account } : {}),
    };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    let code = "";
    try {
      const j = (await res.clone().json()) as { error?: string | { code?: string } };
      code = typeof j.error === "string" ? j.error : (j.error?.code ?? "");
    } catch {
      /* không phải JSON */
    }
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow_down" };
    if (code === "access_denied") return { status: "denied" };
    if (code === "expired_token") return { status: "expired" };
  }
  throw await readError(res, "đăng nhập");
}
