import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WorkspaceContext } from "@penai/shared";
import { getHooksForEvent, type DbHandle } from "@penai/db";

/** Chặn IP nội bộ (chống SSRF khi gọi hook HTTP). */
function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    return low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
  }
  return false;
}

async function safePost(url: string, body: unknown): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  const host = u.hostname;
  const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of ips) if (isBlockedIp(address)) return; // từ chối nội bộ
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

/**
 * Tạo callback onEvent cho agent loop: khi có sự kiện lifecycle, tìm hook
 * khớp (event + matcher regex trên tên tool) và POST HTTP (SSRF-guarded).
 */
export function makeHookDispatcher(db: DbHandle, ctx: WorkspaceContext) {
  return async (
    event: "pre_tool_use" | "post_tool_use" | "stop",
    data: Record<string, unknown>,
  ): Promise<void> => {
    let hookRows;
    try {
      hookRows = await getHooksForEvent(db.db, ctx, event);
    } catch {
      return;
    }
    const target = String(data.tool ?? data.finalText ?? "");
    await Promise.all(
      hookRows
        .filter((h) => {
          try {
            return new RegExp(h.matcher).test(target);
          } catch {
            return true;
          }
        })
        .map((h) => safePost(h.url, { event, ...data, workspaceId: ctx.workspaceId })),
    );
  };
}
