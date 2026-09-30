/**
 * Cookie cho hồ sơ trình duyệt: đọc các định dạng người dùng hay có, chuẩn hóa về
 * định dạng Playwright (context.addCookies), gộp và lọc theo tên miền.
 *
 * Định dạng nhận:
 *  1. JSON xuất từ tiện ích Chrome Cookie-Editor / EditThisCookie (mảng object có
 *     domain, name, value, expirationDate, hostOnly, sameSite…), hoặc object
 *     { cookies: [...] } (storageState của Playwright).
 *  2. File cookies.txt kiểu Netscape (7 cột cách nhau bằng tab).
 *  3. Chuỗi header "ten1=gia-tri1; ten2=gia-tri2" chép từ DevTools — cần kèm tên miền.
 */

export interface BrowserCookie {
  name: string;
  value: string;
  /** ".shopee.vn" = cả tên miền con; "shopee.vn" (không dấu chấm) = chỉ đúng host đó. */
  domain: string;
  path: string;
  /** Giây Unix; -1 = cookie phiên (hết khi đóng trình duyệt). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** Thông tin hiển thị cookie — KHÔNG có giá trị. */
export interface CookieMeta {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  valueLength: number;
}

export const MAX_COOKIES_PER_PROFILE = 500;
const MAX_VALUE_LEN = 8192;

export class CookieParseError extends Error {}

const cleanDomain = (d: string): string => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

function normSameSite(v: unknown): BrowserCookie["sameSite"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "none" || s === "no_restriction") return "None";
  return "Lax";
}

function finalize(c: BrowserCookie): BrowserCookie | null {
  if (!c.name || /[\s;=]/.test(c.name)) return null;
  if (!c.domain || !/^\.?[a-z0-9.-]+$/.test(c.domain)) return null;
  if (c.value.length > MAX_VALUE_LEN) return null;
  // Chromium từ chối SameSite=None không kèm Secure → hạ về Lax thay vì mất cookie
  if (c.sameSite === "None" && !c.secure) c.sameSite = "Lax";
  if (!c.path.startsWith("/")) c.path = "/";
  if (!Number.isFinite(c.expires) || c.expires <= 0) c.expires = -1;
  else c.expires = Math.floor(c.expires);
  return c;
}

function fromJsonItem(o: Record<string, unknown>): BrowserCookie | null {
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const value = typeof o.value === "string" ? o.value : o.value == null ? "" : String(o.value);
  let domain = typeof o.domain === "string" ? cleanDomain(o.domain) : "";
  if (!domain && typeof o.url === "string") {
    try {
      domain = new URL(o.url).hostname.toLowerCase();
    } catch {
      domain = "";
    }
  }
  // Cookie-Editor: hostOnly=false mà domain thiếu dấu chấm đầu → cookie cho cả tên miền con
  if (o.hostOnly === false && domain && !domain.startsWith(".")) domain = "." + domain;
  if (o.hostOnly === true) domain = domain.replace(/^\./, "");
  const expRaw = o.expirationDate ?? o.expires ?? o.expiry;
  const session = o.session === true;
  const expires = session ? -1 : Number(expRaw ?? -1);
  return finalize({
    name,
    value,
    domain,
    path: typeof o.path === "string" && o.path ? o.path : "/",
    expires,
    httpOnly: o.httpOnly === true,
    secure: o.secure === true,
    sameSite: normSameSite(o.sameSite),
  });
}

function parseNetscape(text: string): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    }
    if (!line.trim() || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [dom, sub, path, secure, exp, name, ...rest] = f;
    let domain = cleanDomain(dom!);
    if (sub!.toUpperCase() === "TRUE" && !domain.startsWith(".")) domain = "." + domain;
    const c = finalize({
      name: name!.trim(),
      value: rest.join("\t"),
      domain,
      path: path || "/",
      expires: Number(exp),
      httpOnly,
      secure: secure!.toUpperCase() === "TRUE",
      sameSite: "Lax",
    });
    if (c) out.push(c);
  }
  return out;
}

function parseHeader(text: string, defaultDomain: string): BrowserCookie[] {
  const domain = cleanDomain(defaultDomain);
  if (!domain) {
    throw new CookieParseError(
      'Chuỗi dạng "ten=gia-tri; ..." không có tên miền — nhập ô Tên miền (vd shopee.vn) rồi thử lại.',
    );
  }
  const d = domain.startsWith(".") ? domain : "." + domain;
  const body = text.replace(/^\s*cookie\s*:\s*/i, "");
  const out: BrowserCookie[] = [];
  for (const part of body.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const c = finalize({
      name: part.slice(0, i).trim(),
      value: part.slice(i + 1).trim(),
      domain: d,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
    if (c) out.push(c);
  }
  return out;
}

/**
 * Đọc cookie từ nội dung người dùng dán/tải lên. Ném CookieParseError (thông báo
 * tiếng Việt) khi không nhận ra định dạng hoặc không có cookie hợp lệ nào.
 */
export function parseCookieInput(text: string, opts: { defaultDomain?: string } = {}): BrowserCookie[] {
  const t = text.trim().replace(/^﻿/, "");
  if (!t) throw new CookieParseError("Nội dung cookie trống");
  let cookies: BrowserCookie[];
  if (t.startsWith("[") || t.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      throw new CookieParseError("Nội dung giống JSON nhưng không đọc được — kiểm tra lại đã chép đủ chưa.");
    }
    const arr = Array.isArray(j)
      ? j
      : j && typeof j === "object" && Array.isArray((j as { cookies?: unknown }).cookies)
        ? (j as { cookies: unknown[] }).cookies
        : null;
    if (!arr) throw new CookieParseError("JSON phải là danh sách cookie (mảng) hoặc có khóa \"cookies\".");
    cookies = arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map(fromJsonItem)
      .filter((c): c is BrowserCookie => c !== null);
  } else if (/\t/.test(t) && /^(#|\.?[a-z0-9.-]+\t)/im.test(t)) {
    cookies = parseNetscape(t);
  } else {
    cookies = parseHeader(t, opts.defaultDomain ?? "");
  }
  if (!cookies.length) throw new CookieParseError("Không tìm thấy cookie hợp lệ nào trong nội dung đã dán.");
  return dedupe(cookies);
}

const keyOf = (c: Pick<BrowserCookie, "name" | "domain" | "path">) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

function dedupe(list: BrowserCookie[]): BrowserCookie[] {
  const m = new Map<string, BrowserCookie>();
  for (const c of list) m.set(keyOf(c), c);
  return [...m.values()];
}

/** Gộp: cookie mới thay cookie cũ cùng tên + tên miền + đường dẫn. */
export function mergeCookies(base: BrowserCookie[], incoming: BrowserCookie[]): BrowserCookie[] {
  return dedupe([...base, ...incoming]).slice(-MAX_COOKIES_PER_PROFILE);
}

/** Bỏ cookie đã hết hạn (cookie phiên giữ lại). */
export function dropExpired(list: BrowserCookie[], nowSec = Date.now() / 1000): BrowserCookie[] {
  return list.filter((c) => c.expires === -1 || c.expires > nowSec);
}

/** Tên miền gốc để so khớp: ".shopee.vn" / "shopee.vn" → "shopee.vn". */
export const baseDomain = (d: string): string => d.replace(/^\./, "").toLowerCase();

/** Cookie `c` thuộc một trong các tên miền `domains` (hoặc tên miền con của chúng). */
export function cookieInDomains(c: Pick<BrowserCookie, "domain">, domains: string[]): boolean {
  const d = baseDomain(c.domain);
  return domains.some((x) => {
    const b = baseDomain(x);
    return d === b || d.endsWith("." + b);
  });
}

/**
 * Lưu lại cookie sau phiên duyệt: chỉ nhận cookie thuộc các tên miền hồ sơ ĐÃ CÓ
 * (không gom cookie quảng cáo của mọi trang đã ghé), thay bản cũ cùng khóa.
 */
export function mergeSessionCookies(profile: BrowserCookie[], fromSession: BrowserCookie[]): BrowserCookie[] {
  const domains = [...new Set(profile.map((c) => baseDomain(c.domain)))];
  if (!domains.length) return profile;
  const keep = fromSession.filter((c) => cookieInDomains(c, domains));
  return dropExpired(mergeCookies(profile, keep));
}

export function cookieMeta(list: BrowserCookie[]): CookieMeta[] {
  return list
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      valueLength: c.value.length,
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** Đọc lại danh sách cookie đã lưu (JSON sau giải mã) — bỏ phần tử hỏng. */
export function loadCookieJson(json: string | null | undefined): BrowserCookie[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((o) =>
        finalize({
          name: String(o.name ?? ""),
          value: String(o.value ?? ""),
          domain: String(o.domain ?? ""),
          path: String(o.path ?? "/"),
          expires: Number(o.expires ?? -1),
          httpOnly: o.httpOnly === true,
          secure: o.secure === true,
          sameSite: normSameSite(o.sameSite),
        }),
      )
      .filter((c): c is BrowserCookie => c !== null);
  } catch {
    return [];
  }
}
