/**
 * Biểu thức của quy trình: `{{ ... }}` trong chuỗi, `cond`/`over` và bước `code`
 * đều là JavaScript, chạy trong máy ảo QuickJS (WebAssembly) — không có
 * require/fetch/process/hệ thống file, có giới hạn thời gian và bộ nhớ.
 *
 * Mỗi lần chạy quy trình dùng MỘT ngữ cảnh QuickJS: kết quả từng bước được nạp
 * vào biến toàn cục `steps` một lần (không chép lại cả ngữ cảnh mỗi lần tính).
 */
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Nạp máy ảo QuickJS (một lần cho cả tiến trình). */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS();
  return modulePromise;
}

export class ExprError extends Error {
  constructor(message: string, public readonly expr?: string) {
    super(message);
    this.name = "ExprError";
  }
}

const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const TEMPLATE_RE = /\{\{([\s\S]+?)\}\}/g;
const SOLE_TEMPLATE_RE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;

/** Thư viện hàm tiện ích có sẵn trong mọi biểu thức (chạy trong QuickJS). */
const PRELUDE = String.raw`
"use strict";
globalThis.__host = (...a) => JSON.parse(__hostRaw(JSON.stringify(a)));
globalThis.json = (v, space) => JSON.stringify(v, null, space);
globalThis.parseJson = (s, def) => { try { return JSON.parse(s); } catch { return def === undefined ? null : def; } };
globalThis.get = (obj, path, def) => {
  const parts = String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur == null) return def; cur = cur[p]; }
  return cur === undefined ? def : cur;
};
const __pick = (x, key) => key == null ? x : (typeof key === "function" ? key(x) : get(x, key));
globalThis.num = (v, def) => {
  if (typeof v === "number") return isFinite(v) ? v : (def === undefined ? 0 : def);
  if (v == null || v === "") return def === undefined ? 0 : def;
  let s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return isFinite(n) ? n : (def === undefined ? 0 : def);
};
globalThis.sum = (arr, key) => (arr || []).reduce((a, x) => a + num(__pick(x, key)), 0);
globalThis.avg = (arr, key) => (arr && arr.length ? sum(arr, key) / arr.length : 0);
globalThis.min = (arr, key) => (arr && arr.length ? Math.min(...arr.map((x) => num(__pick(x, key)))) : null);
globalThis.max = (arr, key) => (arr && arr.length ? Math.max(...arr.map((x) => num(__pick(x, key)))) : null);
globalThis.count = (arr, fn) => (arr || []).filter(fn || Boolean).length;
globalThis.groupBy = (arr, key) => {
  const map = new Map();
  for (const x of arr || []) {
    const k = __pick(x, key);
    const kk = k === undefined || k === null ? "" : k;
    if (!map.has(kk)) map.set(kk, []);
    map.get(kk).push(x);
  }
  return [...map.entries()].map(([k, items]) => ({ key: k, items, count: items.length }));
};
globalThis.uniq = (arr, key) => {
  const seen = new Set(); const out = [];
  for (const x of arr || []) { const k = JSON.stringify(__pick(x, key)); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};
globalThis.sortBy = (arr, key, desc) => [...(arr || [])].sort((a, b) => {
  const x = __pick(a, key), y = __pick(b, key);
  const r = x < y ? -1 : x > y ? 1 : 0;
  return desc ? -r : r;
});
globalThis.pluck = (arr, key) => (arr || []).map((x) => __pick(x, key));
globalThis.chunk = (arr, size) => { const out = []; for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size)); return out; };
globalThis.range = (a, b) => { if (b === undefined) { b = a; a = 0; } const out = []; for (let i = a; i < b && out.length < 100000; i++) out.push(i); return out; };
globalThis.round = (n, d) => { const f = Math.pow(10, d || 0); return Math.round(num(n) * f) / f; };
globalThis.keys = (o) => Object.keys(o || {});
globalThis.values = (o) => Object.values(o || {});
globalThis.entries = (o) => Object.entries(o || {});
globalThis.pick = (o, ...ks) => { const out = {}; for (const k of ks.flat()) if (o && k in o) out[k] = o[k]; return out; };
globalThis.omit = (o, ...ks) => { const out = { ...(o || {}) }; for (const k of ks.flat()) delete out[k]; return out; };
globalThis.len = (v) => (v == null ? 0 : typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : v.length || 0);
globalThis.isEmpty = (v) => len(v) === 0;
globalThis.lower = (s) => String(s == null ? "" : s).toLowerCase();
globalThis.upper = (s) => String(s == null ? "" : s).toUpperCase();
globalThis.trim = (s) => String(s == null ? "" : s).trim();
globalThis.truncate = (s, n, tail) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + (tail === undefined ? "…" : tail) : s; };
const __group3 = (intPart, sep) => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
globalThis.formatNumber = (n, digits) => {
  const v = num(n); const neg = v < 0; const fixed = Math.abs(v).toFixed(digits || 0);
  const [i, f] = fixed.split(".");
  return (neg ? "-" : "") + __group3(i, ".") + (f ? "," + f : "");
};
globalThis.formatVND = (n) => formatNumber(Math.round(num(n))) + " ₫";
globalThis.slugify = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
globalThis.uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); });
// Ngày giờ theo múi giờ doanh nghiệp: tính ở Node (QuickJS không có Intl)
globalThis.now = () => __host("now");
globalThis.today = (offsetDays) => __host("today", offsetDays || 0);
globalThis.formatDate = (d, fmt) => __host("formatDate", d === undefined ? null : d, fmt || "DD/MM/YYYY HH:mm");
globalThis.addDays = (d, n) => __host("addDays", d, n || 0);
globalThis.addHours = (d, n) => __host("addHours", d, n || 0);
globalThis.diffDays = (a, b) => __host("diffDays", a, b === undefined ? null : b);
globalThis.weekday = (d) => __host("weekday", d === undefined ? null : d);
globalThis.base64 = (s) => __host("base64", String(s));
globalThis.unbase64 = (s) => __host("unbase64", String(s));
globalThis.urlencode = (s) => encodeURIComponent(String(s == null ? "" : s));
globalThis.sha256 = (s) => __host("sha256", String(s));
globalThis.hmacSha256 = (key, s) => __host("hmacSha256", String(key), String(s));
globalThis.__deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) __deepFreeze(o[k]); } return o; };
globalThis.steps = {};
globalThis.vars = {};
`;

export interface ExprEnvOptions {
  /** Múi giờ IANA cho today()/formatDate()… */
  timezone: string;
  /** Trần thời gian mỗi lần tính (ms). */
  timeoutMs?: number;
  /** Trần bộ nhớ của máy ảo (byte). */
  memoryLimit?: number;
}

/** Hàm ngày giờ chạy ở Node, gọi từ trong QuickJS qua __host(). */
function hostCall(tz: string, fn: string, args: unknown[]): unknown {
  const toDate = (v: unknown): Date => {
    if (v === null || v === undefined || v === "") return new Date();
    if (typeof v === "number") return new Date(v);
    const s = String(v);
    // "YYYY-MM-DD" → nửa đêm theo múi giờ doanh nghiệp
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return zonedMidnight(s, tz);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Không hiểu ngày "${s}"`);
    return d;
  };
  switch (fn) {
    case "now":
      return new Date().toISOString();
    case "today": {
      const d = new Date(Date.now() + Number(args[0] ?? 0) * 86_400_000);
      return formatZoned(d, tz, "YYYY-MM-DD");
    }
    case "formatDate":
      return formatZoned(toDate(args[0]), tz, String(args[1] ?? "DD/MM/YYYY HH:mm"));
    case "addDays": {
      const s = args[0];
      const n = Number(args[1] ?? 0);
      if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return formatZoned(new Date(zonedMidnight(s, tz).getTime() + n * 86_400_000 + 12 * 3_600_000), tz, "YYYY-MM-DD");
      }
      return new Date(toDate(s).getTime() + n * 86_400_000).toISOString();
    }
    case "addHours":
      return new Date(toDate(args[0]).getTime() + Number(args[1] ?? 0) * 3_600_000).toISOString();
    case "diffDays": {
      const a = toDate(args[0]);
      const b = toDate(args[1]);
      return Math.round((a.getTime() - b.getTime()) / 86_400_000);
    }
    case "weekday": {
      const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(toDate(args[0]));
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    }
    case "base64":
      return Buffer.from(String(args[0]), "utf8").toString("base64");
    case "unbase64":
      return Buffer.from(String(args[0]), "base64").toString("utf8");
    case "sha256":
      return createHashSync("sha256", String(args[0]));
    case "hmacSha256":
      return createHmacSync(String(args[0]), String(args[1]));
    default:
      throw new Error(`Hàm ${fn} không có`);
  }
}

import { createHash, createHmac } from "node:crypto";
function createHashSync(alg: string, s: string): string {
  return createHash(alg).update(s).digest("hex");
}
function createHmacSync(key: string, s: string): string {
  return createHmac("sha256", key).update(s).digest("hex");
}

function zonedParts(d: Date, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

/** Định dạng ngày theo múi giờ: YYYY MM DD HH mm ss. */
export function formatZoned(d: Date, tz: string, fmt: string): string {
  const p = zonedParts(d, tz);
  return fmt
    .replace(/YYYY/g, p.year!)
    .replace(/MM/g, p.month!)
    .replace(/DD/g, p.day!)
    .replace(/HH/g, p.hour!)
    .replace(/mm/g, p.minute!)
    .replace(/ss/g, p.second!);
}

function zonedMidnight(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const p = zonedParts(guess, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Bỏ `{{ }}` bao ngoài (AI hay viết cond: "{{ x > 0 }}"). */
export function stripBraces(expr: string): string {
  const m = SOLE_TEMPLATE_RE.exec(expr);
  return (m ? m[1]! : expr).trim();
}

export function hasTemplate(s: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(s);
}

/** Mọi biểu thức `{{ }}` trong một chuỗi. */
export function templateExprs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TEMPLATE_RE)) out.push(m[1]!.trim());
  return out;
}

const UNDEF = "__penai_undefined__";

/**
 * Môi trường tính biểu thức cho một lần chạy. Nhớ gọi dispose().
 */
export class ExprEnv {
  private rt: QuickJSRuntime;
  private vm: QuickJSContext;
  private timeoutMs: number;
  private disposed = false;

  private constructor(qjs: QuickJSWASMModule, private opts: ExprEnvOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.rt = qjs.newRuntime();
    this.rt.setMemoryLimit(opts.memoryLimit ?? 128 * 1024 * 1024);
    this.rt.setMaxStackSize(1024 * 1024);
    this.vm = this.rt.newContext();
    const host = this.vm.newFunction("__hostRaw", (argHandle) => {
      try {
        const args = JSON.parse(this.vm.getString(argHandle)) as unknown[];
        const res = hostCall(opts.timezone, String(args[0]), args.slice(1));
        return this.vm.newString(JSON.stringify(res === undefined ? null : res));
      } catch (err) {
        return { error: this.vm.newError((err as Error).message) };
      }
    });
    this.vm.setProp(this.vm.global, "__hostRaw", host);
    host.dispose();
    this.exec(PRELUDE, 5000);
  }

  static async create(opts: ExprEnvOptions): Promise<ExprEnv> {
    return new ExprEnv(await loadQuickJS(), opts);
  }

  /** Chạy mã, trả chuỗi kết quả (mã phải tự trả về chuỗi). */
  private exec(code: string, timeoutMs = this.timeoutMs): string {
    if (this.disposed) throw new ExprError("Môi trường biểu thức đã đóng");
    this.rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const r = this.vm.evalCode(code);
    if (r.error) {
      const e = this.vm.dump(r.error) as { name?: string; message?: string } | string;
      r.error.dispose();
      const msg = typeof e === "string" ? e : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
      if (/interrupted/i.test(msg)) throw new ExprError(`Quá thời gian chạy (${Math.round(timeoutMs / 1000)}s)`);
      if (/out of memory/i.test(msg)) throw new ExprError("Vượt giới hạn bộ nhớ của mã");
      throw new ExprError(msg);
    }
    const out = this.vm.typeof(r.value) === "string" ? this.vm.getString(r.value) : String(this.vm.dump(r.value));
    r.value.dispose();
    return out;
  }

  private wrapResult(body: string): string {
    return `(function(){ const __v = (function(){ ${body} })(); return __v === undefined ? ${JSON.stringify(UNDEF)} : JSON.stringify(__v); })()`;
  }

  private decode(s: string): unknown {
    if (s === UNDEF) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }

  /** Đặt biến toàn cục (bản sao JSON, đóng băng — biểu thức không sửa được). */
  setGlobal(name: string, value: unknown): void {
    this.exec(
      `globalThis[${JSON.stringify(name)}] = __deepFreeze(${value === undefined ? "undefined" : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`}); ""`,
      10_000,
    );
  }

  deleteGlobal(name: string): void {
    this.exec(`delete globalThis[${JSON.stringify(name)}]; ""`, 1000);
  }

  /** Ghi kết quả một bước vào `steps.<id>`. */
  setStep(id: string, rec: { output: unknown; error?: string | null; status: string; durationMs: number }): void {
    this.exec(
      `globalThis.steps = Object.assign({}, globalThis.steps, { [${JSON.stringify(id)}]: __deepFreeze(JSON.parse(${JSON.stringify(
        JSON.stringify({ output: rec.output ?? null, error: rec.error ?? null, status: rec.status, durationMs: rec.durationMs }),
      )})) }); ""`,
      10_000,
    );
  }

  setVar(name: string, value: unknown): void {
    this.exec(
      `globalThis.vars = Object.assign({}, globalThis.vars, { [${JSON.stringify(name)}]: __deepFreeze(${
        value === undefined ? "null" : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`
      }) }); ""`,
      10_000,
    );
  }

  /** Tính một biểu thức JS. */
  evaluate(expr: string): unknown {
    const e = stripBraces(expr);
    if (!e) return undefined;
    return this.decode(this.exec(this.wrapResult(`return (${e}\n);`)));
  }

  /** Chạy thân hàm của bước code (có `return`). */
  runCode(code: string, timeoutMs?: number): unknown {
    return this.decode(this.exec(this.wrapResult(`"use strict";\n${code}\n`), timeoutMs));
  }

  /** Thay `{{ }}` trong chuỗi. Chuỗi CHỈ gồm một `{{ expr }}` → giữ nguyên kiểu. */
  renderString(s: string): unknown {
    const sole = SOLE_TEMPLATE_RE.exec(s);
    if (sole) return this.evaluate(sole[1]!);
    if (!hasTemplate(s)) return s;
    return s.replace(TEMPLATE_RE, (_m, e: string) => {
      const v = this.evaluate(e);
      if (v === undefined || v === null) return "";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }

  /** Thay `{{ }}` đệ quy trong object/mảng. */
  render(value: unknown): unknown {
    if (typeof value === "string") return this.renderString(value);
    if (Array.isArray(value)) return value.map((v) => this.render(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.render(v);
      return out;
    }
    return value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.vm.dispose();
      this.rt.dispose();
    } catch {
      // QuickJS báo rò handle khi giải phóng — không ảnh hưởng kết quả
    }
  }
}

/** Kiểm tra cú pháp (không chạy). Trả thông báo lỗi hoặc null. */
export async function checkSyntax(code: string, kind: "expr" | "code"): Promise<string | null> {
  const qjs = await loadQuickJS();
  const vm = qjs.newContext();
  try {
    const body = kind === "expr" ? `return (${stripBraces(code)}\n);` : `"use strict";\n${code}\n`;
    const r = vm.evalCode(`new Function(${JSON.stringify(body)}); ""`);
    if (r.error) {
      const e = vm.dump(r.error) as { message?: string } | string;
      r.error.dispose();
      return typeof e === "string" ? e : (e?.message ?? "lỗi cú pháp");
    }
    r.value.dispose();
    return null;
  } finally {
    try {
      vm.dispose();
    } catch {
      // bỏ qua
    }
  }
}

export const isSimplePath = (e: string) => PATH_RE.test(e.trim());
