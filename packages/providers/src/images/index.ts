/**
 * ImageRouter — lõi tạo ảnh dùng chung cho HAI lối vào:
 *   - tool `image_generation` (agent mode)
 *   - route `/v1/images/generations` (API công khai, không cần agent)
 *
 * Trước đây lõi nằm trong tool nên API muốn tạo ảnh là phải đi qua agent.
 * Tách ra đây để một thay đổi (vd đổi model, đổi thứ tự ứng viên) áp dụng cho
 * cả hai — không để hai bản logic lệch nhau.
 *
 * Thứ tự mặc định (13/09/2026): Antigravity (gói Ultra, hạn mức lớn) → codex
 * (ChatGPT subscription, 1 tài khoản) → OpenAI Images (chỉ khi có API key).
 *
 * Chú ý: `CodexProvider.generateImage()` TỰ xoay vòng pool tài khoản ChatGPT
 * (pickOrder → acquire → 429/5xx thì markThrottled + nhảy tài khoản), nên ở đây
 * không lặp lại việc đó; ImageRouter chỉ xoay giữa các ỨNG VIÊN provider.
 */

import { DEFAULT_ANTIGRAVITY_IMAGE_MODEL } from "../antigravity/provider.js";

export interface ImageRequest {
  prompt: string;
  size?: string;
  /** Tỷ lệ khung "16:9", "9:16"… — antigravity dùng thẳng, codex quy về size gần nhất. */
  aspectRatio?: string;
  /** Ảnh tham chiếu dạng data URL (tạo/sửa ảnh dựa trên ảnh mẫu). */
  refImages?: string[];
  signal?: AbortSignal;
}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  /** Ứng viên đã tạo ra ảnh này — trả về header/`penai.route` để debug. */
  route: string;
}

/** Bộ tạo ảnh của một provider (antigravity, codex native, OpenAI Images…). */
export interface ImageBackend {
  /** Nhãn route, vd "antigravity/gemini-3.7-flash-low". */
  name: string;
  /** Tên provider trong registry — khóa của ProviderGate. */
  provider: string;
  generate(req: ImageRequest): Promise<{ data: Buffer; mime: string }>;
}

export interface ImageRouterOptions {
  /** Bọc mỗi lần gọi backend — thường là ProviderGate.run theo backend.provider. */
  run?: <T>(backend: ImageBackend, fn: () => Promise<T>) => Promise<T>;
  /**
   * Backend đang hết chỗ chạy ngay → thử các backend rảnh trước, quay lại xếp
   * hàng chờ nó sau cùng. agy chỉ 1 tiến trình và mỗi ảnh 20–50 s: không có cờ
   * này, request thứ hai phải chờ trọn lượt trước dù codex đang rảnh.
   */
  isBusy?: (backend: ImageBackend) => boolean;
}

const OPENAI_IMAGE_TIMEOUT_MS = 120_000;

/** Backend OpenAI Images API (cần API key thật). */
export function openAIImageBackend(
  apiKey: string,
  model = "gpt-image-1",
  baseUrl = "https://api.openai.com/v1",
): ImageBackend {
  return {
    name: `openai/${model}`,
    provider: "openai-images",
    async generate(req) {
      const size = req.size ?? sizeForAspect(req.aspectRatio) ?? "1024x1024";
      let res: Response;
      if (req.refImages?.length) {
        // Có ảnh tham chiếu → endpoint edits (nhận nhiều ảnh input)
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", req.prompt);
        form.append("size", size);
        for (const [i, dataUrl] of req.refImages.entries()) {
          const parsed = parseDataUrl(dataUrl);
          if (!parsed) throw new Error("refImages phải là data URL");
          form.append(
            "image[]",
            new Blob([new Uint8Array(parsed.buf)], { type: parsed.mime }),
            `ref-${i}.${extOf(parsed.mime)}`,
          );
        }
        res = await fetch(`${baseUrl}/images/edits`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: req.signal ?? AbortSignal.timeout(OPENAI_IMAGE_TIMEOUT_MS),
        });
      } else {
        res = await fetch(`${baseUrl}/images/generations`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: req.prompt, size, n: 1 }),
          signal: req.signal ?? AbortSignal.timeout(OPENAI_IMAGE_TIMEOUT_MS),
        });
      }
      if (!res.ok) {
        const err = new Error(
          `OpenAI Images lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const json = (await res.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>;
      };
      const item = json.data?.[0];
      if (!item) throw new Error("OpenAI Images: không có ảnh trả về");
      if (item.b64_json) {
        return { data: Buffer.from(item.b64_json, "base64"), mime: "image/png" };
      }
      if (item.url) {
        const img = await fetch(item.url, { signal: req.signal ?? undefined });
        return { data: Buffer.from(await img.arrayBuffer()), mime: "image/png" };
      }
      throw new Error("OpenAI Images: phản hồi không có b64_json lẫn url");
    },
  };
}

/** Backend ChatGPT subscription (codex native image_generation). */
export function codexImageBackend(
  codex: {
    name?: string;
    generateImage(req: {
      prompt: string;
      size?: string;
      model?: string;
      refImages?: string[];
    }): Promise<{ data: Buffer; mime: string }>;
  },
  opts: { model?: string; carrierModel?: string } = {},
): ImageBackend {
  return {
    name: `codex/${opts.model ?? "gpt-image-2"}`,
    provider: codex.name ?? "codex",
    async generate(req) {
      const size = req.size ?? sizeForAspect(req.aspectRatio);
      return codex.generateImage({
        prompt: req.prompt,
        ...(size ? { size } : {}),
        ...(opts.carrierModel ? { model: opts.carrierModel } : {}),
        ...(req.refImages?.length ? { refImages: req.refImages } : {}),
      });
    },
  };
}

/** Backend gói Google Antigravity qua `agy` CLI (tool generate_image của CLI). */
export function antigravityImageBackend(
  agy: {
    name?: string;
    generateImage(req: {
      prompt: string;
      size?: string;
      aspectRatio?: string;
      refImages?: string[];
      model?: string;
      signal?: AbortSignal;
    }): Promise<{ data: Buffer; mime: string }>;
  },
  opts: { model?: string } = {},
): ImageBackend {
  const model = opts.model ?? DEFAULT_ANTIGRAVITY_IMAGE_MODEL;
  return {
    name: `antigravity/${model}`,
    provider: agy.name ?? "antigravity",
    async generate(req) {
      return agy.generateImage({
        prompt: req.prompt,
        model,
        ...(req.size ? { size: req.size } : {}),
        ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
        ...(req.refImages?.length ? { refImages: req.refImages } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    },
  };
}

export class ImageRouter {
  constructor(
    private backends: ImageBackend[],
    private opts: ImageRouterOptions = {},
  ) {}

  get isEmpty(): boolean {
    return this.backends.length === 0;
  }

  get routeNames(): string[] {
    return this.backends.map((b) => b.name);
  }

  /** Router chỉ gồm backend của một provider (ép provider theo yêu cầu người gọi). */
  only(provider: string): ImageRouter {
    const picked = this.backends.filter((b) => b.provider === provider);
    if (!picked.length) {
      throw new Error(
        `Không có backend tạo ảnh "${provider}" (đang có: ${
          [...new Set(this.backends.map((b) => b.provider))].join(", ") || "không có"
        })`,
      );
    }
    return new ImageRouter(picked, this.opts);
  }

  /**
   * Thử backend rảnh theo thứ tự trước, backend đang bận xếp sau; lỗi thì sang
   * backend kế. Hết ứng viên: một lỗi → ném nguyên lỗi đó (giữ QueueRejectedError
   * để API trả 429), nhiều lỗi → gộp thông điệp từng route.
   */
  async generate(req: ImageRequest): Promise<GeneratedImage> {
    if (!this.backends.length) {
      throw new Error(
        "Chưa cấu hình tạo ảnh: cần đăng nhập Antigravity / ChatGPT (codex) hoặc OPENAI_API_KEY",
      );
    }
    const isBusy = this.opts.isBusy;
    const ordered = isBusy
      ? [...this.backends.filter((b) => !isBusy(b)), ...this.backends.filter((b) => isBusy(b))]
      : this.backends;
    const run = this.opts.run ?? (<T>(_b: ImageBackend, fn: () => Promise<T>) => fn());
    const errors: Array<{ backend: ImageBackend; err: unknown }> = [];
    for (const backend of ordered) {
      try {
        const out = await run(backend, () => backend.generate(req));
        return { ...out, route: backend.name };
      } catch (err) {
        errors.push({ backend, err });
        if (req.signal?.aborted) throw err;
      }
    }
    const last = errors[errors.length - 1]!.err;
    if (errors.length === 1 || errors.every((e) => (e.err as Error)?.name === "QueueRejectedError")) {
      throw last instanceof Error ? last : new Error(String(last));
    }
    const merged = new Error(
      errors
        .map((e) => `${e.backend.name}: ${e.err instanceof Error ? e.err.message : String(e.err)}`)
        .join(" | "),
    ) as Error & { status?: number };
    const status = (last as { status?: number }).status;
    if (typeof status === "number") merged.status = status;
    throw merged;
  }

  /** Nhiều ảnh: gọi lặp (cả agy lẫn codex native đều 1 ảnh/lần). */
  async generateMany(req: ImageRequest, n: number): Promise<GeneratedImage[]> {
    const count = Math.max(1, Math.min(n, 4));
    const out: GeneratedImage[] = [];
    for (let i = 0; i < count; i++) out.push(await this.generate(req));
    return out;
  }
}

/** Quy tỷ lệ khung về size codex hỗ trợ (ngang / dọc / vuông). */
export function sizeForAspect(aspectRatio?: string): string | undefined {
  const m = aspectRatio ? /^(\d+):(\d+)$/.exec(aspectRatio.trim()) : null;
  if (!m) return undefined;
  const r = Number(m[1]) / Number(m[2]);
  if (!Number.isFinite(r) || r <= 0) return undefined;
  if (r >= 1.2) return "1536x1024";
  if (r <= 0.84) return "1024x1536";
  return "1024x1024";
}

function parseDataUrl(dataUrl: string): { buf: Buffer; mime: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1]!, buf: Buffer.from(m[2]!, "base64") };
}

function extOf(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}
