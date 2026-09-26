import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { ApiConfig, WorkspaceContext } from "@penai/shared";
import { apiKeyMonthTokens, getApiKeyPolicy, isOverCap, type ApiKeyPolicy, type Db } from "@penai/db";
import { ApiError } from "./errors.js";

// ===== Danh tính người gọi =====

export interface ApiCaller {
  ctx: WorkspaceContext;
  apiKeyId: string;
  requestId: string;
  policy: ApiKeyPolicy | null;
}

/**
 * Cache (apiKeyId → policy) 60 s. Policy đọc mỗi request sẽ thành một truy vấn
 * DB cho mọi lời gọi API; cache ngắn là đủ vì thay đổi policy hiếm.
 */
const policyCache = new Map<string, { at: number; policy: ApiKeyPolicy | null }>();
const POLICY_TTL_MS = 60_000;

export function invalidatePolicyCache(apiKeyId?: string): void {
  if (apiKeyId) policyCache.delete(apiKeyId);
  else policyCache.clear();
}

export async function loadPolicy(
  db: Db,
  ctx: WorkspaceContext,
  apiKeyId: string,
): Promise<ApiKeyPolicy | null> {
  const hit = policyCache.get(apiKeyId);
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.policy;
  const policy = await getApiKeyPolicy(db, ctx, apiKeyId).catch(() => null);
  policyCache.set(apiKeyId, { at: Date.now(), policy });
  return policy;
}

// ===== Chặn IP (mặc định TẮT) =====

/** So IP với một mục allowlist: địa chỉ đơn hoặc CIDR (IPv4/IPv6). */
export function ipMatches(ip: string, entry: string): boolean {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  const slash = entry.indexOf("/");
  if (slash < 0) return normalizeIp(entry) === clean;

  const base = normalizeIp(entry.slice(0, slash));
  const bits = Number(entry.slice(slash + 1));
  if (!base || !Number.isInteger(bits) || bits < 0) return false;
  const a = ipToBytes(clean);
  const b = ipToBytes(base);
  if (!a || !b || a.length !== b.length) return false;
  if (bits > a.length * 8) return false;
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
  const rem = bits & 7;
  if (rem === 0) return true;
  const mask = 0xff << (8 - rem);
  return (a[full]! & mask) === (b[full]! & mask);
}

/** ::ffff:1.2.3.4 → 1.2.3.4; bỏ zone id; chữ thường. */
function normalizeIp(ip: string): string | null {
  let s = ip.trim().toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (s.startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s : null;
}

function ipToBytes(ip: string): number[] | null {
  const v = isIP(ip);
  if (v === 4) return ip.split(".").map(Number);
  if (v !== 6) return null;
  // Mở rộng "::" rồi tách 8 nhóm 16-bit
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail ? tail.split(":").filter(Boolean) : [];
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array<string>(ip.includes("::") ? fill : 0).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n)) return null;
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  return out;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * IP thật của client. X-Forwarded-For CHỈ được tin khi kết nối TCP đến từ
 * loopback (nginx cùng máy) — tin mù thì ai cũng giả được IP và allowlist
 * thành vô nghĩa.
 */
export function realClientIp(req: FastifyRequest, trustProxy: boolean): string {
  const socketIp = req.socket.remoteAddress ?? req.ip ?? "";
  if (trustProxy && LOOPBACK.has(socketIp)) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (xff) return xff;
  }
  return socketIp;
}

export function checkIpAllowlist(req: FastifyRequest, cfg: ApiConfig): void {
  if (!cfg.ipAllowlist.enabled) return; // mặc định: chấp nhận mọi IP
  const ip = realClientIp(req, cfg.ipAllowlist.trustProxy);
  if (cfg.ipAllowlist.allow.some((entry) => ipMatches(ip, entry))) return;
  throw new ApiError("ip_not_allowed", `IP ${ip} không nằm trong danh sách cho phép`);
}

// ===== Rate limit theo key (token bucket) =====

interface Bucket {
  tokens: number;
  last: number;
  inflight: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimitCheck(
  key: string,
  cfg: ApiConfig,
  policy: ApiKeyPolicy | null,
): void {
  const rpm = policy?.rpm ?? cfg.rateLimit.rpm;
  if (rpm <= 0) return;
  const burst = Math.max(1, cfg.rateLimit.burst);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now, inflight: 0 };
    buckets.set(key, b);
  }
  const refill = ((now - b.last) / 60_000) * rpm;
  b.tokens = Math.min(burst, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) {
    const waitSec = Math.max(1, Math.ceil(((1 - b.tokens) / rpm) * 60));
    throw new ApiError("rate_limit_exceeded", `Vượt ${rpm} request/phút`, {
      retryAfterSec: waitSec,
    });
  }
  b.tokens -= 1;
}

/** Trần số request đang chạy cùng lúc của MỘT key. */
export function concurrencyEnter(
  key: string,
  cfg: ApiConfig,
  policy: ApiKeyPolicy | null,
): () => void {
  const limit = policy?.maxConcurrent ?? cfg.rateLimit.maxConcurrentPerKey;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: cfg.rateLimit.burst, last: Date.now(), inflight: 0 };
    buckets.set(key, b);
  }
  if (b.inflight >= limit) {
    throw new ApiError("too_many_concurrent", `Key đang chạy ${b.inflight}/${limit} request`, {
      retryAfterSec: 5,
    });
  }
  b.inflight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    b!.inflight = Math.max(0, b!.inflight - 1);
  };
}

/** Dọn bucket cũ định kỳ (tránh phình bộ nhớ khi nhiều key). */
export function sweepBuckets(maxIdleMs = 30 * 60_000): void {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.inflight === 0 && now - b.last > maxIdleMs) buckets.delete(k);
  }
}

// ===== Hạn mức token =====

export async function checkQuota(
  db: Db,
  caller: ApiCaller,
): Promise<void> {
  if (caller.policy?.paused) {
    throw new ApiError("key_paused", "API key đang bị tạm dừng");
  }
  if (await isOverCap(db, caller.ctx.workspaceId).catch(() => false)) {
    throw new ApiError("quota_exceeded", "Workspace đã vượt hạn mức token tháng này", {
      retryAfterSec: 3600,
    });
  }
  const keyCap = caller.policy?.monthlyTokens;
  if (keyCap && keyCap > 0) {
    const used = await apiKeyMonthTokens(db, caller.ctx, caller.apiKeyId).catch(() => 0);
    if (used >= keyCap) {
      throw new ApiError("quota_exceeded", `API key đã dùng ${used}/${keyCap} token tháng này`, {
        retryAfterSec: 3600,
      });
    }
  }
}

// ===== Allowlist model / agent =====

export function assertModelAllowed(
  model: string,
  cfg: ApiConfig,
  policy: ApiKeyPolicy | null,
): void {
  const allow = policy?.models ?? (cfg.defaultModels.length ? cfg.defaultModels : null);
  // Không có policy và cũng không khai báo defaultModels → cho mọi alias đã cấu hình.
  if (!allow) return;
  if (allow.includes("*") || allow.includes(model)) return;
  throw new ApiError("model_not_allowed", `Key không được dùng model "${model}"`, {
    param: "model",
  });
}

export function assertAgentAllowed(
  agentKey: string,
  policy: ApiKeyPolicy | null,
): void {
  const allow = policy?.agents;
  if (!allow) return;
  if (allow.includes("*") || allow.includes(agentKey)) return;
  throw new ApiError("agent_not_allowed", `Key không được dùng agent "${agentKey}"`, {
    param: "model",
  });
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
