import { readFileSync, existsSync } from "node:fs";
import JSON5 from "json5";
import { z } from "zod";

export const ProviderConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openai"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  }),
  z.object({
    kind: z.literal("gemini"),
    apiKeyEnv: z.string().default("GEMINI_API_KEY"),
  }),
  z.object({
    kind: z.literal("qwen"),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z.string().default("DASHSCOPE_API_KEY"),
  }),
  z.object({
    kind: z.literal("openai-compat"),
    baseURL: z.string().url(),
    apiKeyEnv: z.string().optional(),
  }),
  z.object({
    kind: z.literal("anthropic"),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
  }),
  z.object({
    kind: z.literal("codex"),
    /** File token OAuth ChatGPT (tạo bằng: pnpm codex:login) */
    authFile: z.string().default(".local/codex-auth.json"),
    /** Thư mục chứa các tài khoản ChatGPT bổ sung (pool xoay vòng). */
    accountsDir: z.string().default(".local/codex-accounts"),
    /**
     * Đổi tên model đã bị OpenAI gỡ khỏi tài khoản ChatGPT: { "cũ": "mới" }.
     * Bổ sung/đè lên bảng mặc định DEFAULT_CODEX_MODEL_REWRITES.
     */
    modelRewrites: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    kind: z.literal("acp"),
    /** Lệnh chạy CLI agent ở chế độ ACP (JSON-RPC stdio). */
    command: z.string(),
    args: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("antigravity"),
    /** Đường dẫn binary agy (Google Antigravity CLI). */
    command: z.string().default("agy"),
    /** Thư mục scratch rỗng làm workspace cách ly cho CLI. */
    scratchDir: z.string().optional(),
  }),
  z.object({
    kind: z.literal("claude-code"),
    /** Đường dẫn binary claude (Claude Code CLI). */
    command: z.string().default("claude"),
    /** Thư mục scratch rỗng làm workspace cách ly cho CLI. */
    scratchDir: z.string().optional(),
    /** File lưu OAuth token dài hạn (claude setup-token). */
    tokenFile: z.string().optional(),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ===== API công khai (OpenAI-compatible) — xem specs/spec-public-api-gateway.md =====

/** Một ứng viên trong chuỗi route của alias model. */
export const ApiRouteCandidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** "chat" (mặc định) hoặc "images". */
  kind: z.enum(["chat", "images"]).default("chat"),
});
export type ApiRouteCandidate = z.infer<typeof ApiRouteCandidateSchema>;

export const ApiModelAliasSchema = z.object({
  route: z.array(ApiRouteCandidateSchema).min(1),
});

export const ApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Danh sách trắng provider được phép phục vụ qua API. Provider có API key
   * nằm ngoài phạm vi (app tự gọi thẳng nhà cung cấp).
   */
  providers: z.array(z.string()).default(["codex", "claude-code", "antigravity"]),
  /**
   * Hàng đợi + trần đồng thời. Số mặc định lấy từ đo thực tế trên VPS
   * (mỗi tiến trình CLI ~220 MB RSS, máy còn ~1,1 GB trống).
   */
  queue: z
    .object({
      concurrency: z.record(z.string(), z.number().int().min(1)).default({
        codex: 4,
        "claude-code": 2,
        antigravity: 1,
      }),
      /** Trần CHUNG cho mọi tiến trình CLI (claude-code + antigravity). */
      cliTotal: z.number().int().min(1).default(2),
      /** Trần số việc chờ trong một hàng đợi; đầy → 429 ngay. */
      max: z.number().int().min(1).default(20),
      /** Chờ quá lâu → 429 + Retry-After. */
      waitMs: z.number().int().min(1000).default(30_000),
    })
    .prefault({}),
  ipAllowlist: z
    .object({
      enabled: z.boolean().default(false),
      allow: z.array(z.string()).default([]),
      /** Chỉ tin X-Forwarded-For khi kết nối TCP đến từ loopback. */
      trustProxy: z.boolean().default(true),
    })
    .prefault({}),
  rateLimit: z
    .object({
      rpm: z.number().int().min(0).default(120),
      burst: z.number().int().min(1).default(20),
      maxConcurrentPerKey: z.number().int().min(1).default(4),
    })
    .prefault({}),
  files: z
    .object({
      urlTtlHours: z.number().int().min(1).default(24),
      maxTtlHours: z.number().int().min(1).default(168),
      inlineB64MaxBytes: z.number().int().min(1024).default(1024 * 1024),
    })
    .prefault({}),
  /** Model mà key chưa có policy riêng được dùng. */
  defaultModels: z.array(z.string()).default([]),
  models: z.record(z.string(), ApiModelAliasSchema).prefault({}),
  /**
   * Dự phòng theo PROVIDER (14/09/2026): app gọi thẳng "<provider>/<model>"
   * (vd codex/gpt-5.6-sol) mà provider đó nghẽn/hết hạn mức → tự nối thêm các
   * ứng viên ở đây vào sau. Chỉ áp cho kind "chat"; ảnh đã có chuỗi riêng trong
   * alias. App không hay biết — response vẫn echo model đã xin.
   */
  fallback: z.record(z.string(), z.array(ApiRouteCandidateSchema)).prefault({}),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "màu phải dạng #rrggbb");

/**
 * Thương hiệu hiển thị trên Dashboard (tên, khẩu hiệu, logo, màu). Đổi ở file
 * cấu hình là đủ — không phải sửa mã, nên cập nhật phiên bản mới không bị đè.
 */
export const BrandingSchema = z.object({
  /** Tên hiển thị trên tiêu đề tab, trang đăng nhập, thanh trên cùng. */
  name: z.string().trim().min(1).max(40).default("PenAI"),
  /** Dòng giới thiệu dưới chữ "Đăng nhập". */
  tagline: z.string().trim().max(120).default("Nền tảng AI Agent cho doanh nghiệp"),
  /** Bộ màu có sẵn: xanh-duong (mặc định), tim, xanh-ngoc. */
  theme: z.enum(["xanh-duong", "tim", "xanh-ngoc"]).default("xanh-duong"),
  /** Màu chủ đạo riêng (#rrggbb) — đè màu của bộ theme. */
  primaryColor: HexColor.optional(),
  /** Màu điểm nhấn (ngôi sao trên logo mặc định). */
  sparkColor: HexColor.optional(),
  /** Logo riêng: đường dẫn tuyệt đối tới file .svg/.png/.jpg/.webp trên máy chủ. */
  logoFile: z.string().optional(),
  /** Hoặc URL logo (https://… hoặc đường dẫn trên chính máy chủ). */
  logoUrl: z.string().optional(),
});
export type Branding = z.infer<typeof BrandingSchema>;

/** Múi giờ mặc định: lịch hẹn, "hôm nay" của agent, giờ hiển thị. */
export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

/** Tên múi giờ IANA (vd "Asia/Ho_Chi_Minh") có dùng được trên máy này không. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Quy trình tự động (Dashboard → Quy trình) — mọi khóa có mặc định. */
export const WorkflowsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Số lần chạy song song tối đa toàn hệ thống (phần còn lại xếp hàng). */
  maxConcurrentRuns: z.number().int().min(1).max(50).default(5),
  /** Trần thời gian một lần chạy (giây). */
  maxRunSeconds: z.number().int().min(10).max(3600).default(600),
  /** Timeout mặc định của bước http/code (giây); tool/mcp/agent tối thiểu 120s. */
  stepTimeoutSeconds: z.number().int().min(1).max(600).default(30),
  /** Giữ bao nhiêu lần chạy gần nhất mỗi quy trình. */
  keepRuns: z.number().int().min(10).max(10000).default(200),
  /** Giới hạn gọi webhook mỗi phút (mỗi quy trình, ghi đè được bằng rateLimit của trigger). */
  webhookRatePerMinute: z.number().int().min(1).max(6000).default(60),
  /** Số quy trình đang bật tối đa mỗi workspace. */
  maxEnabledPerWorkspace: z.number().int().min(1).max(10000).default(100),
  maxSteps: z.number().int().min(1).max(1000).default(100),
  maxLoop: z.number().int().min(1).max(100000).default(1000),
  /** Cho phép bước shell (lệnh trong sandbox bubblewrap). Mặc định tắt. */
  allowShell: z.boolean().default(false),
  /** Bước http được gọi địa chỉ nội bộ (127.0.0.1, 10.x, 192.168.x…). Mặc định chặn. */
  allowPrivateNetwork: z.boolean().default(false),
});
export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>;

/** CSDL riêng của workspace (bảng PostgreSQL thật cho quy trình, agent, API, MCP). */
export const WorkspaceDbConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Hạn mức dung lượng mỗi workspace (MB) — vượt thì chỉ còn đọc và xóa. */
  quotaMb: z.number().int().min(1).max(1_000_000).default(500),
  /** Số dòng trả về tối đa mỗi câu lệnh. */
  maxRows: z.number().int().min(10).max(100_000).default(1000),
  /** Trần thời gian một câu lệnh (giây). */
  timeoutSeconds: z.number().int().min(1).max(600).default(15),
  /** Bản chụp tự động giữ lại (mỗi ngày một bản). 0 = tắt chụp tự động. */
  snapshotKeep: z.number().int().min(0).max(60).default(7),
  /** Không chụp khi CSDL lớn hơn mức này (MB) — dùng sudo penai backup. */
  snapshotMaxMb: z.number().int().min(1).max(10_000).default(50),
});
export type WorkspaceDbConfig = z.infer<typeof WorkspaceDbConfigSchema>;

export const PenaiConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(18800),
  host: z.string().default("127.0.0.1"),
  /** Thư mục dữ liệu file per-workspace (tool read_file bị giới hạn trong đây). */
  dataDir: z.string().default("./.data"),
  databaseUrl: z
    .string()
    .default("postgres://penai_app:penai_app@127.0.0.1:5433/penai"),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  api: ApiConfigSchema.prefault({}),
  branding: BrandingSchema.prefault({}),
  /**
   * Múi giờ của doanh nghiệp: giờ trong lịch hẹn ("at 2026-09-28 08:00", cron
   * "0 8 * * *"), ngày "hôm nay" agent thấy, giờ hiển thị. Không phụ thuộc giờ
   * của VPS (nhiều VPS để UTC — lệch 7 tiếng so với Việt Nam).
   */
  timezone: z
    .string()
    .trim()
    .default(DEFAULT_TIMEZONE)
    .refine(isValidTimeZone, { message: 'múi giờ không hợp lệ — dùng tên IANA, vd "Asia/Ho_Chi_Minh"' }),
  workflows: WorkflowsConfigSchema.prefault({}),
  workspaceDb: WorkspaceDbConfigSchema.prefault({}),
})
  // Alias model chỉ được trỏ vào provider trong danh sách trắng — sai cấu hình
  // phải chết ngay lúc khởi động, đừng để tới lúc app gọi mới lỗi.
  .superRefine((cfg, ctx) => {
    if (!cfg.api?.enabled) return;
    const allowed = new Set(cfg.api.providers);
    for (const [alias, def] of Object.entries(cfg.api.models)) {
      for (const cand of def.route) {
        if (!allowed.has(cand.provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["api", "models", alias],
            message: `provider "${cand.provider}" không nằm trong api.providers (${[...allowed].join(", ")})`,
          });
        }
      }
    }
    for (const [prov, cands] of Object.entries(cfg.api.fallback)) {
      for (const cand of cands) {
        if (!allowed.has(cand.provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["api", "fallback", prov],
            message: `provider "${cand.provider}" không nằm trong api.providers (${[...allowed].join(", ")})`,
          });
        }
        if (cand.provider === prov) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["api", "fallback", prov],
            message: `fallback của "${prov}" không được trỏ về chính nó`,
          });
        }
      }
    }
    if (cfg.api.ipAllowlist.enabled && cfg.api.ipAllowlist.allow.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["api", "ipAllowlist"],
        message: "ipAllowlist.enabled=true nhưng allow rỗng → chặn tất cả. Thêm IP hoặc tắt đi.",
      });
    }
  });
export type PenaiConfig = z.infer<typeof PenaiConfigSchema>;

/**
 * Đường dẫn file cấu hình: env PENAI_CONFIG (bản cài trên máy chủ đặt ở
 * /etc/penai/penai.config.json5, nằm NGOÀI thư mục mã để cập nhật phiên bản
 * không đè mất), không có thì penai.config.json5 ở thư mục đang chạy.
 */
export function defaultConfigPath(): string {
  return process.env.PENAI_CONFIG?.trim() || "penai.config.json5";
}

/**
 * Đọc config JSON5 + validate bằng Zod. File không tồn tại → dùng default.
 * env DATABASE_URL đè databaseUrl trong file.
 */
export function loadConfig(path = defaultConfigPath()): PenaiConfig {
  let raw: unknown = {};
  if (existsSync(path)) {
    raw = JSON5.parse(readFileSync(path, "utf8"));
  }
  const cfg = PenaiConfigSchema.parse(raw);
  if (process.env.DATABASE_URL) cfg.databaseUrl = process.env.DATABASE_URL;
  return cfg;
}

/**
 * Theo dõi file config, gọi onReload khi thay đổi (hot-reload).
 * Trả về hàm dừng watch. Lỗi parse không làm sập — chỉ bỏ qua lần đó.
 */
export async function watchConfig(
  onReload: (cfg: PenaiConfig) => void,
  path = defaultConfigPath(),
): Promise<() => Promise<void>> {
  const { watch } = await import("chokidar");
  const watcher = watch(path, { ignoreInitial: true });
  watcher.on("change", () => {
    try {
      onReload(loadConfig(path));
    } catch {
      // config sai → giữ config cũ
    }
  });
  return () => watcher.close();
}
