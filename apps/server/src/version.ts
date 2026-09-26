/**
 * Phiên bản đang chạy: đọc release.json (script cài/cập nhật ghi vào gốc thư
 * mục mã: phiên bản, tag/nhánh, commit, thời điểm cài), không có thì lấy
 * "version" trong package.json gốc. Đọc một lần lúc khởi động.
 */
import { readFileSync } from "node:fs";

export interface ReleaseInfo {
  version: string;
  ref?: string;
  commit?: string;
  installedAt?: string;
}

function readJson(rel: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function load(): ReleaseInfo {
  const pkg = readJson("../../../package.json");
  const version = typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  const rel = readJson("../../../release.json");
  if (!rel) return { version };
  const str = (k: string) => (typeof rel[k] === "string" ? (rel[k] as string) : undefined);
  const info: ReleaseInfo = { version: str("version") ?? version };
  for (const k of ["ref", "commit", "installedAt"] as const) {
    const v = str(k);
    if (v) info[k] = v;
  }
  return info;
}

export const RELEASE: ReleaseInfo = load();
