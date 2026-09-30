import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Chặn trình duyệt của agent gọi vào mạng nội bộ (SSRF — trang độc hoặc lời nhắn
 * dụ agent mở http://127.0.0.1:18800, cổng PostgreSQL, trang quản trị router…).
 * Kiểm MỌI request của trang (kể cả ảnh/script/XHR), không chỉ trang mở đầu:
 * tên máy phân giải ra địa chỉ riêng/loopback/link-local → chặn.
 * Tắt kiểm tra (chỉ khi cố ý cho agent vào mạng nội bộ): PENAI_BROWSER_ALLOW_PRIVATE=1.
 */

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, metadata đám mây
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + dành riêng
  );
}

/** Địa chỉ IP thuộc vùng riêng/nội bộ (IPv4 hoặc IPv6). Chuỗi không phải IP → true (an toàn). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true;
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]!);
  if (/^::ffff:/.test(s)) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}

const BLOCKED_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

const cache = new Map<string, { ok: boolean; at: number }>();
const CACHE_MS = 5 * 60_000;

/**
 * URL được phép tải hay không. Chỉ http/https (cùng data:/blob:/about: do trang tự
 * tạo). Tên máy phân giải lỗi → chặn (fail-closed).
 */
export async function isUrlAllowed(rawUrl: string, allowPrivate = process.env.PENAI_BROWSER_ALLOW_PRIVATE === "1"): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (allowPrivate) return true;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (isIP(host)) return !isPrivateAddress(host);
  if (BLOCKED_SUFFIX.test(host) || !host.includes(".")) return false;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let ok = false;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    ok = false;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(host, { ok, at: Date.now() });
  return ok;
}
