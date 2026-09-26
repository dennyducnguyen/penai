/**
 * Thương hiệu Dashboard: ráp tên/khẩu hiệu/màu/logo từ config vào INDEX_HTML
 * và dựng logo SVG mặc định của PenAI (ngòi bút + tia sáng) theo màu theme.
 *
 * Mọi giá trị từ config đều được escape trước khi chèn — config do quản trị
 * viên sửa, nhưng một dấu < lọt vào tên cũng đủ làm vỡ trang đăng nhập.
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { Branding } from "@penai/shared";

type ThemeColors = {
  accent: string;
  accent2: string;
  accentDark: string;
  accent2Dark: string;
  spark: string;
  /** Nền trang đăng nhập: vầng sáng chính, vầng sáng phụ, 3 nấc nền tối. */
  loginGlow: string;
  loginGlow2: string;
  loginBg: [string, string, string];
};

export const THEMES: Record<Branding["theme"], ThemeColors> = {
  "xanh-duong": {
    accent: "#2563eb",
    accent2: "#1d4ed8",
    accentDark: "#3b82f6",
    accent2Dark: "#60a5fa",
    spark: "#f59e0b",
    loginGlow: "#2563eb",
    loginGlow2: "#f59e0b33",
    loginBg: ["#0b1f4d", "#0a1733", "#070f22"],
  },
  tim: {
    accent: "#7c3aed",
    accent2: "#6d28d9",
    accentDark: "#8b5cf6",
    accent2Dark: "#a78bfa",
    spark: "#f472b6",
    loginGlow: "#7c3aed",
    loginGlow2: "#f472b633",
    loginBg: ["#2e1065", "#1e0b45", "#12072b"],
  },
  "xanh-ngoc": {
    accent: "#0f766e",
    accent2: "#0d9488",
    accentDark: "#14b8a6",
    accent2Dark: "#2dd4bf",
    spark: "#f59e0b",
    loginGlow: "#0d9488",
    loginGlow2: "#f59e0b33",
    loginBg: ["#042f2e", "#06302b", "#031a18"],
  },
};

/** Màu thật đang dùng: theme + màu riêng (nếu có) đè lên. */
export function brandColors(b: Branding): ThemeColors {
  const t = { ...THEMES[b.theme] };
  if (b.primaryColor) {
    t.accent = b.primaryColor;
    t.accent2 = b.primaryColor;
    t.accentDark = b.primaryColor;
    t.accent2Dark = b.primaryColor;
    t.loginGlow = b.primaryColor;
  }
  if (b.sparkColor) {
    t.spark = b.sparkColor;
    t.loginGlow2 = `${b.sparkColor}33`;
  }
  return t;
}

/** Logo mặc định: ô vuông bo góc màu chủ đạo, ngòi bút trắng, tia sáng màu nhấn. */
export function defaultLogoSvg(b: Branding): string {
  const c = brandColors(b);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeHtml(b.name)}">
<rect width="64" height="64" rx="15" fill="${c.accent}"/>
<g transform="rotate(-35 30 34)">
<rect x="21" y="7" width="18" height="5" rx="2" fill="#fff" opacity=".85"/>
<path d="M22 13h16l3 15-11 22-11-22z" fill="#fff"/>
<path d="M30 30v17" stroke="${c.accent}" stroke-width="2.6" stroke-linecap="round"/>
<circle cx="30" cy="28" r="3.4" fill="${c.accent}"/>
</g>
<path d="M49 7l2.2 6.3 6.3 2.2-6.3 2.2L49 24l-2.2-6.3-6.3-2.2 6.3-2.2z" fill="${c.spark}"/>
</svg>`;
}

const LOGO_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** File logo riêng hợp lệ (tồn tại + đuôi ảnh hỗ trợ) → content-type, không thì null. */
export function customLogoType(b: Branding): string | null {
  if (!b.logoFile) return null;
  const type = LOGO_TYPES[extname(b.logoFile).toLowerCase()];
  return type && existsSync(b.logoFile) ? type : null;
}

/** URL logo cho thẻ <img>: logoUrl > logoFile (/brand/logo) > logo mặc định. */
export function logoUrl(b: Branding): string {
  if (b.logoUrl) return b.logoUrl;
  if (customLogoType(b)) return "/brand/logo";
  return "/brand/logo.svg";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Thay các ô %%BRAND_*%% trong INDEX_HTML. */
export function renderIndexHtml(template: string, b: Branding): string {
  const c = brandColors(b);
  const css =
    `:root{--accent:${c.accent};--accent2:${c.accent2};--star:${c.spark};` +
    `--login-glow:${c.loginGlow};--login-glow2:${c.loginGlow2};` +
    `--login-bg1:${c.loginBg[0]};--login-bg2:${c.loginBg[1]};--login-bg3:${c.loginBg[2]}}` +
    `@media (prefers-color-scheme: dark){:root{--accent:${c.accentDark};--accent2:${c.accent2Dark}}}`;
  // JSON đặt trong <script>: chặn "</script>" và ký tự tách dòng của JS cũ.
  const json = JSON.stringify({ name: b.name, tagline: b.tagline })
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
  const logo = escapeHtml(logoUrl(b));
  return template
    .replaceAll("%%BRAND_NAME%%", escapeHtml(b.name))
    .replaceAll("%%BRAND_TAGLINE%%", escapeHtml(b.tagline))
    .replaceAll("%%BRAND_LOGO%%", logo)
    .replaceAll("%%BRAND_CSS%%", css)
    .replaceAll("%%BRAND_JSON%%", json);
}
