import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const MAX_BYTES = 128 * 1024;

const schema = z.object({
  url: z.string().url().describe("URL http(s) cần tải."),
  method: z.enum(["GET", "POST"]).default("GET"),
  body: z.string().optional().describe("Body cho POST (tùy chọn)."),
});

/** Chặn IP nội bộ/loopback/link-local — chống SSRF. */
function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number) as [number, number, number, number];
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("fe80") ||
      low.startsWith("::ffff:127.") ||
      low.startsWith("::ffff:10.")
    );
  }
  return false;
}

/**
 * Tải nội dung web. Chống SSRF: chỉ http/https, resolve DNS và chặn IP nội bộ
 * TRƯỚC khi request, giới hạn kích thước, không follow redirect ra host khác lén.
 */
export const httpFetchTool: ToolHandler<typeof schema> = {
  name: "http_fetch",
  description:
    "Tải nội dung một trang web/API công khai (http/https). Chỉ host công khai.",
  schema,
  async execute(args) {
    const u = new URL(args.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("Chỉ hỗ trợ http/https");
    }
    // Resolve host → chặn IP nội bộ
    const host = u.hostname;
    const ips = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    for (const { address } of ips) {
      if (isBlockedIp(address)) {
        throw new Error(`Từ chối: host trỏ tới IP nội bộ (${address})`);
      }
    }

    const res = await fetch(args.url, {
      method: args.method,
      redirect: "manual",
      ...(args.body ? { body: args.body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      return `HTTP ${res.status} redirect → ${res.headers.get("location") ?? "?"} (không tự follow vì lý do an toàn)`;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, MAX_BYTES).toString("utf8");
    const truncated = buf.length > MAX_BYTES ? "\n...(đã cắt bớt)" : "";
    return `HTTP ${res.status} ${res.headers.get("content-type") ?? ""}\n\n${text}${truncated}`;
  },
};
