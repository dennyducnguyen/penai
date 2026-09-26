import type { ApiConfig, ApiRouteCandidate } from "@penai/shared";
import { ApiError } from "./errors.js";

/**
 * Phân giải tên model của app → danh sách ứng viên, và giữ trạng thái cooldown
 * để không đập mãi vào một tài khoản đang nghẽn.
 *
 * Lưu ý phân tầng: xoay vòng TÀI KHOẢN trong một provider là việc của provider
 * (CodexAccounts.pickOrder tự làm). Ở đây chỉ xoay giữa các ỨNG VIÊN
 * provider/model.
 */

export type ResolvedModel =
  | { mode: "agent"; agentRef: string; raw: string }
  | { mode: "raw"; candidates: ApiRouteCandidate[]; raw: string; alias: string | null };

export function resolveModel(raw: string, cfg: ApiConfig): ResolvedModel {
  const model = raw.trim();
  if (!model) {
    throw new ApiError("invalid_request", "Thiếu trường model", { param: "model" });
  }

  if (model.startsWith("agent:")) {
    const ref = model.slice("agent:".length).trim();
    if (!ref) {
      throw new ApiError("invalid_request", 'model "agent:" thiếu tên agent', { param: "model" });
    }
    return { mode: "agent", agentRef: ref, raw: model };
  }

  // <provider>/<model> — ép provider, dùng để debug
  const slash = model.indexOf("/");
  if (slash > 0) {
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    if (!cfg.providers.includes(provider)) {
      throw new ApiError(
        "provider_not_allowed",
        `Provider "${provider}" không phục vụ qua API (được phép: ${cfg.providers.join(", ")})`,
        { param: "model" },
      );
    }
    return {
      mode: "raw",
      alias: null,
      raw: model,
      candidates: withFallback([{ provider, model: modelId, kind: "chat" }], cfg),
    };
  }

  const alias = cfg.models[model];
  if (!alias) {
    throw new ApiError(
      "model_not_found",
      `Model "${model}" không tồn tại. Xem GET /v1/models.`,
      { param: "model" },
    );
  }
  return { mode: "raw", alias: model, raw: model, candidates: withFallback(alias.route, cfg) };
}

/**
 * Nối ứng viên dự phòng theo provider (api.fallback) vào sau chuỗi — dùng cho
 * app gọi thẳng "codex/gpt-5.6-sol" mà codex chạm limit 5 giờ: cùng lời gọi
 * đó chuyển sang antigravity, app không hay biết. Chỉ áp cho kind "chat";
 * bỏ ứng viên đã có trong chuỗi để không thử hai lần.
 */
function withFallback(route: ApiRouteCandidate[], cfg: ApiConfig): ApiRouteCandidate[] {
  const out = [...route];
  const seen = new Set(out.map((c) => `${c.provider}:${c.model}:${c.kind}`));
  for (const c of route) {
    if (c.kind !== "chat") continue;
    for (const fb of cfg.fallback[c.provider] ?? []) {
      const cand: ApiRouteCandidate = { ...fb, kind: "chat" };
      const k = `${cand.provider}:${cand.model}:${cand.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(cand);
    }
  }
  return out;
}

// ===== Cooldown =====

interface CooldownEntry {
  until: number;
  streak: number;
  lastError: string;
}

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 15 * 60_000;

export class RouteState {
  private entries = new Map<string, CooldownEntry>();
  /** conversationId → key ứng viên đã dùng lần trước (sticky, giữ prompt cache). */
  private sticky = new Map<string, { key: string; at: number }>();
  private stickyTtlMs = 15 * 60_000;

  private static key(c: ApiRouteCandidate): string {
    return `${c.provider}:${c.model}:${c.kind}`;
  }

  available(c: ApiRouteCandidate): boolean {
    const e = this.entries.get(RouteState.key(c));
    return !e || e.until <= Date.now();
  }

  blockReason(c: ApiRouteCandidate): string | null {
    const e = this.entries.get(RouteState.key(c));
    if (!e || e.until <= Date.now()) return null;
    return `${c.provider}/${c.model}: ${e.lastError} (còn ${Math.ceil((e.until - Date.now()) / 1000)}s)`;
  }

  markFailure(c: ApiRouteCandidate, err: unknown): void {
    const k = RouteState.key(c);
    const prev = this.entries.get(k);
    const streak = (prev && prev.until > Date.now() - COOLDOWN_MAX_MS ? prev.streak : 0) + 1;
    const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
    const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (streak - 1), COOLDOWN_MAX_MS);
    const waitMs = retryAfterMs && retryAfterMs > 0 ? Math.max(retryAfterMs, 1000) : backoff;
    this.entries.set(k, {
      until: Date.now() + waitMs,
      streak,
      lastError: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    });
  }

  markSuccess(c: ApiRouteCandidate): void {
    this.entries.delete(RouteState.key(c));
  }

  /** Ghi nhận ứng viên đã phục vụ một hội thoại (sticky để giữ prompt cache). */
  noteSticky(conversationId: string | undefined, c: ApiRouteCandidate): void {
    if (!conversationId) return;
    this.sticky.set(conversationId, { key: RouteState.key(c), at: Date.now() });
    if (this.sticky.size > 5000) {
      const cutoff = Date.now() - this.stickyTtlMs;
      for (const [k, v] of this.sticky) if (v.at < cutoff) this.sticky.delete(k);
    }
  }

  /**
   * Sắp thứ tự ứng viên: bỏ cái đang cooldown xuống cuối (vẫn giữ để khi mọi
   * ứng viên đều nghẽn thì còn cái mà thử), và đẩy ứng viên "sticky" lên đầu.
   */
  order(
    candidates: ApiRouteCandidate[],
    conversationId?: string,
  ): { ordered: ApiRouteCandidate[]; blocked: string[] } {
    const ready: ApiRouteCandidate[] = [];
    const cooling: ApiRouteCandidate[] = [];
    const blocked: string[] = [];
    for (const c of candidates) {
      if (this.available(c)) ready.push(c);
      else {
        cooling.push(c);
        const r = this.blockReason(c);
        if (r) blocked.push(r);
      }
    }
    const s = conversationId ? this.sticky.get(conversationId) : undefined;
    if (s && Date.now() - s.at < this.stickyTtlMs) {
      const i = ready.findIndex((c) => RouteState.key(c) === s.key);
      if (i > 0) ready.unshift(...ready.splice(i, 1));
    }
    return { ordered: [...ready, ...cooling], blocked };
  }

  snapshot(): Array<{ key: string; cooldownSec: number; streak: number; lastError: string }> {
    const now = Date.now();
    return [...this.entries.entries()]
      .filter(([, e]) => e.until > now)
      .map(([key, e]) => ({
        key,
        cooldownSec: Math.ceil((e.until - now) / 1000),
        streak: e.streak,
        lastError: e.lastError,
      }));
  }
}

/** Lỗi tạm thời (đáng thử ứng viên khác) vs lỗi vĩnh viễn (trả thẳng cho client). */
/** 400 báo model không dùng được → ứng viên KẾ (model khác) có thể chạy được. */
function isModelUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /is not supported|not supported when using|does not exist|unknown model|model_not_found|Unsupported value/i.test(
    msg,
  );
}

export function isRetryableProviderError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    if (status === 429 || status >= 500) return true;
    // 404 hoặc 400 "model không dùng được": ứng viên kế dùng model khác nên
    // vẫn đáng thử. Đây là tình huống thật ngày 13/09/2026 khi OpenAI gỡ
    // gpt-5.6-sol giữa ngày — trước đó 400 làm dừng luôn, không failover.
    if (status === 404) return true;
    if (status === 400) return isModelUnavailableError(err);
    return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/context|token limit|too long/i.test(msg)) return false; // để compaction xử lý
  if (/policy|safety|refus/i.test(msg)) return false; // không đốt quota tài khoản khác
  // "terminated"/"other side closed": undici báo upstream đóng kết nối giữa chừng
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|timeout|socket|EAI_AGAIN|abort|terminated|other side closed|kết thúc bất thường/i.test(
    msg,
  );
}
