/**
 * Định dạng lưu trữ của quy trình (workflow) — JSON dạng CÂY: `if` chứa
 * then/else, `loop`/`while` chứa body, `parallel` chứa branches, `switch` chứa
 * cases. Cùng một JSON cho Dashboard, agent (tool workflow_*), API và nhập/xuất.
 *
 * validateDefinition() trả lỗi có đường dẫn + gợi ý tiếng Việt để AI tự sửa:
 *   "steps[2].then[0] (bao_kho).channel: kênh 'zalo:nhom-kd' không tồn tại; kênh có: …"
 */
import { checkSyntax, stripBraces, templateExprs } from "./expr.js";
import { minIntervalMs, normalizeSchedule, validateSchedule } from "../cron.js";

export const STEP_TYPES = [
  "http",
  "code",
  "if",
  "switch",
  "loop",
  "while",
  "parallel",
  "break",
  "stop",
  "wait",
  "set",
  "send",
  "tool",
  "mcp",
  "agent",
  "respond",
  "subworkflow",
  "file",
  "shell",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Nhóm (màu trên Dashboard) + mô tả một dòng của từng loại bước. */
export const STEP_INFO: Record<StepType, { label: string; group: "data" | "control" | "ai" | "output"; summary: string }> = {
  http: { label: "Gọi API", group: "data", summary: "Gọi một địa chỉ HTTP (GET/POST…), nhận JSON/text về." },
  code: { label: "Chạy mã", group: "data", summary: "Mã JavaScript tính toán, biến đổi dữ liệu (có return)." },
  if: { label: "Nếu … thì", group: "control", summary: "Rẽ nhánh theo điều kiện: then / else." },
  switch: { label: "Chọn theo giá trị", group: "control", summary: "So một giá trị với nhiều trường hợp." },
  loop: { label: "Lặp danh sách", group: "control", summary: "Chạy các bước con cho từng phần tử của một mảng." },
  while: { label: "Lặp khi còn đúng", group: "control", summary: "Lặp tới khi điều kiện sai (có trần số vòng)." },
  parallel: { label: "Chạy song song", group: "control", summary: "Chạy nhiều nhánh cùng lúc rồi gom kết quả." },
  break: { label: "Thoát vòng lặp", group: "control", summary: "Thoát vòng lặp gần nhất." },
  stop: { label: "Dừng", group: "control", summary: "Dừng quy trình (không tính là lỗi)." },
  wait: { label: "Chờ", group: "control", summary: "Chờ một khoảng thời gian hoặc tới một thời điểm." },
  set: { label: "Đặt biến", group: "data", summary: "Gán giá trị vào vars.* để dùng ở bước sau." },
  send: { label: "Gửi tin", group: "output", summary: "Gửi tin nhắn/file tới một cuộc trò chuyện trên kênh chat." },
  tool: { label: "Gọi tool", group: "data", summary: "Gọi tool có sẵn hoặc custom tool của PenAI, không qua AI." },
  mcp: { label: "Gọi MCP", group: "data", summary: "Gọi tool của một MCP server đã gắn vào PenAI, không qua AI." },
  agent: { label: "Nhờ agent", group: "ai", summary: "Gửi tin nhắn cho một agent AI làm việc; nhận câu trả lời, có thể gửi thẳng vào chat." },
  respond: { label: "Trả kết quả webhook", group: "output", summary: "Trả status/body cho bên gọi webhook." },
  subworkflow: { label: "Gọi quy trình khác", group: "control", summary: "Chạy một quy trình khác và nhận kết quả." },
  file: { label: "File", group: "data", summary: "Đọc/ghi/liệt kê file trong thư mục của quy trình." },
  shell: { label: "Lệnh shell", group: "data", summary: "Chạy lệnh trong sandbox (cần bật workflows.allowShell)." },
};

export interface WorkflowInput {
  type: "string" | "number" | "boolean" | "json";
  default?: unknown;
  required?: boolean;
  note?: string;
}

export type WorkflowTrigger =
  | { type: "schedule"; cron?: string; schedule?: string; timezone?: string }
  | {
      type: "webhook";
      methods?: Array<"GET" | "POST">;
      respond?: "async" | "wait";
      timeoutSec?: number;
      auth?: "token" | "hmac";
      rateLimit?: number;
    }
  | { type: "manual" }
  | { type: "chat" };

export interface StepBase {
  id: string;
  type: StepType;
  name?: string;
  note?: string;
  disabled?: boolean;
  retry?: { times: number; delay?: string };
  onError?: "stop" | "continue";
  timeout?: number | string;
  [k: string]: unknown;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  triggers: WorkflowTrigger[];
  inputs?: Record<string, WorkflowInput>;
  steps: StepBase[];
  settings?: {
    concurrency?: "skip" | "queue" | "parallel";
    timeoutSec?: number;
    /** Agent đang chat qua kênh ngoài (Zalo, Telegram…) được chạy quy trình này. */
    allowFromChat?: boolean;
    /** Chạy lỗi → gửi cảnh báo tới cuộc trò chuyện này (dạng như bước send). */
    notifyOnError?: { channel: string; to: string };
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface WorkflowLimits {
  maxSteps: number;
  maxDepth: number;
  maxLoop: number;
  maxRunSeconds: number;
  allowShell: boolean;
}

export const DEFAULT_LIMITS: WorkflowLimits = {
  maxSteps: 100,
  maxDepth: 5,
  maxLoop: 1000,
  maxRunSeconds: 600,
  allowShell: false,
};

/** Danh mục để kiểm tra tên kênh/tool/MCP/agent/quy trình (không có = bỏ qua kiểm tra). */
export interface WorkflowCatalog {
  channels?: Array<{ id: string; name: string; kind: string; ref: string }>;
  tools?: string[];
  mcp?: Array<{ id: string; name: string; tools: string[] | null }>;
  agents?: string[];
  workflows?: Array<{ id: string; slug: string }>;
  secrets?: string[];
}

const ID_RE = /^[a-z0-9_]{1,40}$/;
const SECRET_FIELDS: Partial<Record<StepType, string[]>> = {
  http: ["url", "headers", "query", "body"],
  mcp: ["args"],
  tool: ["args"],
  shell: ["env"],
};

/** Child step lists của một bước điều khiển, kèm tên trường. */
export function childLists(step: StepBase): Array<{ key: string; steps: StepBase[] }> {
  const out: Array<{ key: string; steps: StepBase[] }> = [];
  const arr = (k: string) => (Array.isArray(step[k]) ? (step[k] as StepBase[]) : null);
  switch (step.type) {
    case "if": {
      const t = arr("then");
      const e = arr("else");
      if (t) out.push({ key: "then", steps: t });
      if (e) out.push({ key: "else", steps: e });
      break;
    }
    case "loop":
    case "while": {
      const b = arr("body");
      if (b) out.push({ key: "body", steps: b });
      break;
    }
    case "parallel": {
      const br = Array.isArray(step.branches) ? (step.branches as unknown[]) : [];
      br.forEach((b, i) => {
        if (Array.isArray(b)) out.push({ key: `branches[${i}]`, steps: b as StepBase[] });
      });
      break;
    }
    case "switch": {
      const cases = Array.isArray(step.cases) ? (step.cases as Array<{ steps?: unknown }>) : [];
      cases.forEach((c, i) => {
        if (c && Array.isArray(c.steps)) out.push({ key: `cases[${i}].steps`, steps: c.steps as StepBase[] });
      });
      const d = arr("default");
      if (d) out.push({ key: "default", steps: d });
      break;
    }
  }
  return out;
}

/** Duyệt mọi bước (kể cả lồng), kèm đường dẫn. */
export function walkSteps(
  steps: StepBase[],
  fn: (step: StepBase, path: string, depth: number, parents: StepBase[]) => void,
  base = "steps",
  depth = 1,
  parents: StepBase[] = [],
): void {
  steps.forEach((s, i) => {
    const path = `${base}[${i}]`;
    fn(s, path, depth, parents);
    if (s && typeof s === "object") {
      for (const c of childLists(s)) walkSteps(c.steps, fn, `${path}.${c.key}`, depth + 1, [...parents, s]);
    }
  });
}

/** Tìm bước theo id (trả bước + mảng chứa + vị trí). */
export function findStep(
  steps: StepBase[],
  id: string,
): { step: StepBase; list: StepBase[]; index: number; path: string } | null {
  let found: { step: StepBase; list: StepBase[]; index: number; path: string } | null = null;
  const visit = (list: StepBase[], base: string) => {
    list.forEach((s, i) => {
      if (found) return;
      if (s?.id === id) found = { step: s, list, index: i, path: `${base}[${i}]` };
      else if (s && typeof s === "object") for (const c of childLists(s)) visit(c.steps, `${base}[${i}].${c.key}`);
    });
  };
  visit(steps, "steps");
  return found;
}

export function allStepIds(def: { steps: StepBase[] }): string[] {
  const ids: string[] = [];
  walkSteps(def.steps ?? [], (s) => {
    if (s && typeof s.id === "string") ids.push(s.id);
  });
  return ids;
}

/** "10s" | "5m" | "2h" | số giây → mili giây. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v * 1000;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** Tìm tên gần giống để gợi ý. */
function suggest(name: string, options: string[], max = 8): string {
  if (!options.length) return "(chưa có)";
  const lower = name.toLowerCase();
  const scored = options
    .map((o) => ({ o, s: o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()) ? 0 : 1 }))
    .sort((a, b) => a.s - b.s);
  const list = scored.slice(0, max).map((x) => x.o);
  return list.join(", ") + (options.length > max ? `, … (${options.length} mục)` : "");
}

/** Chuỗi có chứa tham chiếu secrets.* không. */
function mentionsSecrets(v: unknown): boolean {
  return JSON.stringify(v ?? null).includes("secrets.");
}

/** Mọi chuỗi biểu thức trong một giá trị (để kiểm cú pháp + tham chiếu). */
function collectTemplates(v: unknown, path: string, out: Array<{ path: string; expr: string }>): void {
  if (isStr(v)) {
    for (const e of templateExprs(v)) out.push({ path, expr: e });
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => collectTemplates(x, `${path}[${i}]`, out));
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) collectTemplates(x, `${path}.${k}`, out);
  }
}

const STEP_REF_RE = /\bsteps\.([A-Za-z0-9_]+)/g;
const STEP_REF_BRACKET_RE = /\bsteps\[["']([A-Za-z0-9_]+)["']\]/g;
const SECRET_REF_RE = /\bsecrets\.([A-Za-z0-9_]+)/g;

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Định nghĩa đã chuẩn hóa (lịch "in 30m" → "at …", type "ai" → "agent"…). */
  definition: WorkflowDefinition;
}

/**
 * Kiểm tra + chuẩn hóa định nghĩa. Không ném lỗi — mọi vấn đề nằm trong errors.
 */
export async function validateDefinition(
  input: unknown,
  opts: { limits?: Partial<WorkflowLimits>; catalog?: WorkflowCatalog; timezone?: string; now?: Date } = {},
): Promise<ValidationResult> {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  const tz = opts.timezone ?? "Asia/Ho_Chi_Minh";

  let raw: unknown = input;
  if (isStr(raw)) {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      err("", `JSON không hợp lệ: ${(e as Error).message}`);
      return { ok: false, errors, warnings, definition: { name: "", triggers: [], steps: [] } };
    }
  }
  if (!isObj(raw)) {
    err("", "Định nghĩa phải là một object JSON { name, triggers, steps, … }");
    return { ok: false, errors, warnings, definition: { name: "", triggers: [], steps: [] } };
  }
  const def = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  // Trường meta khi xuất JSON (id, version, enabled…) — bỏ khỏi định nghĩa
  for (const k of ["id", "version", "enabled", "slug", "createdAt", "updatedAt", "webhookUrl"]) delete def[k];

  if (!isStr(def.name) || !def.name.trim()) err("name", "Thiếu tên quy trình (name)");
  else if (def.name.length > 120) err("name", "Tên tối đa 120 ký tự");
  if (def.description !== undefined && !isStr(def.description)) err("description", "description phải là chuỗi");

  // ---- triggers ----
  if (def.triggers === undefined) def.triggers = [{ type: "manual" }];
  if (!Array.isArray(def.triggers)) err("triggers", "triggers phải là mảng, vd [{ \"type\": \"manual\" }]");
  else {
    const seen = new Set<string>();
    def.triggers.forEach((t: unknown, i: number) => {
      const p = `triggers[${i}]`;
      if (!isObj(t)) return err(p, "Mỗi trigger là một object có type");
      const type = t.type;
      if (type === "schedule") {
        const s = isStr(t.cron) ? t.cron : isStr(t.schedule) ? t.schedule : "";
        if (!s.trim()) return err(p, 'Lịch cần "cron" (vd "0 8 * * 1-5") hoặc "schedule" (vd "every 2h")');
        const zone = isStr(t.timezone) ? t.timezone : tz;
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone });
        } catch {
          return err(`${p}.timezone`, `Múi giờ "${zone}" không hợp lệ (vd Asia/Ho_Chi_Minh)`);
        }
        try {
          const norm = normalizeSchedule(s, opts.now ?? new Date(), zone);
          validateSchedule(norm, zone);
          if (!/^at\s/i.test(norm) && minIntervalMs(norm, opts.now ?? new Date(), zone) < 60_000) {
            err(p, "Lịch dày quá — tối thiểu 1 phút một lần");
          }
          if (isStr(t.cron)) t.cron = norm;
          else t.schedule = norm;
        } catch (e) {
          err(p, `Lịch "${s}" không hợp lệ: ${(e as Error).message}`);
        }
      } else if (type === "webhook") {
        if (seen.has("webhook")) err(p, "Chỉ cần một trigger webhook");
        if (t.methods !== undefined) {
          if (!Array.isArray(t.methods) || !t.methods.every((m) => m === "GET" || m === "POST")) {
            err(`${p}.methods`, 'methods là mảng gồm "GET" và/hoặc "POST"');
          }
        }
        if (t.respond !== undefined && t.respond !== "async" && t.respond !== "wait") {
          err(`${p}.respond`, 'respond là "async" (trả ngay runId) hoặc "wait" (chờ kết quả)');
        }
        if (t.timeoutSec !== undefined && (typeof t.timeoutSec !== "number" || t.timeoutSec < 1 || t.timeoutSec > 120)) {
          err(`${p}.timeoutSec`, "timeoutSec từ 1 đến 120 giây");
        }
        if (t.auth !== undefined && t.auth !== "token" && t.auth !== "hmac") err(`${p}.auth`, 'auth là "token" hoặc "hmac"');
        if (t.rateLimit !== undefined && (typeof t.rateLimit !== "number" || t.rateLimit < 1 || t.rateLimit > 6000)) {
          err(`${p}.rateLimit`, "rateLimit (số lần gọi mỗi phút) từ 1 đến 6000");
        }
      } else if (type === "manual" || type === "chat") {
        // không có trường
      } else {
        err(`${p}.type`, `Loại trigger "${String(type)}" không có — dùng schedule, webhook, manual`);
      }
      if (isStr(type)) seen.add(type);
    });
  }

  // ---- inputs ----
  if (def.inputs !== undefined) {
    if (!isObj(def.inputs)) err("inputs", 'inputs là object, vd { "ngay": { "type": "string" } }');
    else {
      for (const [k, v] of Object.entries(def.inputs)) {
        const p = `inputs.${k}`;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) err(p, "Tên tham số chỉ gồm chữ không dấu, số, _ (không bắt đầu bằng số)");
        if (isStr(v)) {
          (def.inputs as Record<string, unknown>)[k] = { type: v };
          continue;
        }
        if (!isObj(v)) {
          err(p, 'Mỗi tham số là { "type": "string|number|boolean|json", "default"?, "note"? }');
          continue;
        }
        if (v.type === undefined) v.type = "string";
        if (!["string", "number", "boolean", "json"].includes(String(v.type))) {
          err(`${p}.type`, "type là string, number, boolean hoặc json");
        }
      }
    }
  }

  // ---- settings ----
  if (def.settings !== undefined) {
    if (!isObj(def.settings)) err("settings", "settings là object");
    else {
      const s = def.settings;
      if (s.concurrency !== undefined && !["skip", "queue", "parallel"].includes(String(s.concurrency))) {
        err("settings.concurrency", 'concurrency là "skip" (bỏ lượt mới nếu đang chạy), "queue" (xếp hàng) hoặc "parallel"');
      }
      if (s.timeoutSec !== undefined && (typeof s.timeoutSec !== "number" || s.timeoutSec < 1 || s.timeoutSec > limits.maxRunSeconds)) {
        err("settings.timeoutSec", `timeoutSec từ 1 đến ${limits.maxRunSeconds} giây`);
      }
      if (s.notifyOnError !== undefined) {
        const n = s.notifyOnError;
        if (!isObj(n) || !isStr(n.channel) || !isStr(n.to)) err("settings.notifyOnError", '{ "channel": "<kênh>", "to": "<cuộc trò chuyện>" }');
        else checkChannel("settings.notifyOnError.channel", n.channel);
      }
    }
  }

  // ---- steps ----
  if (!Array.isArray(def.steps)) {
    err("steps", "steps phải là mảng các bước");
    def.steps = [];
  }
  const steps = def.steps as StepBase[];
  const idCount = new Map<string, number>();
  let total = 0;
  const syntaxJobs: Array<{ path: string; code: string; kind: "expr" | "code" }> = [];

  function checkChannel(path: string, ref: string) {
    const ch = opts.catalog?.channels;
    if (!ch || ref.includes("{{")) return;
    const r = ref.trim().toLowerCase();
    const hit = ch.find(
      (c) => c.id === ref || c.ref.toLowerCase() === r || c.name.toLowerCase() === r || `${c.kind}:${c.name}`.toLowerCase() === r,
    );
    if (!hit) err(path, `Kênh "${ref}" không tồn tại; kênh có: ${suggest(ref, ch.map((c) => c.ref))}`);
  }

  // Lượt 1: chuẩn hóa + đếm id
  walkSteps(steps, (s, path, depth, parents) => {
    total++;
    if (!isObj(s)) return err(path, "Mỗi bước là một object { id, type, … }");
    if ((s.type as string) === "ai") s.type = "agent";
    if (s.type === "agent" && s.message === undefined && isStr(s.prompt)) {
      s.message = s.prompt;
      delete s.prompt;
    }
    const label = isStr(s.id) ? `${path} (${s.id})` : path;
    if (!isStr(s.id) || !ID_RE.test(s.id)) {
      err(`${path}.id`, `id bước bắt buộc, dạng [a-z0-9_] tối đa 40 ký tự (vd "lay_don")${isStr(s.id) ? `, đang là "${s.id}"` : ""}`);
    } else idCount.set(s.id, (idCount.get(s.id) ?? 0) + 1);
    if (!STEP_TYPES.includes(s.type)) {
      err(`${label}.type`, `Loại bước "${String(s.type)}" không có — dùng: ${STEP_TYPES.join(", ")}`);
      return;
    }
    if (depth > limits.maxDepth) err(label, `Lồng quá ${limits.maxDepth} cấp`);
    if (s.type === "break" && !parents.some((p) => p.type === "loop" || p.type === "while")) {
      err(label, "break chỉ dùng bên trong loop hoặc while");
    }
    if (s.retry !== undefined) {
      const r = s.retry as unknown;
      if (!isObj(r) || typeof r.times !== "number" || r.times < 0 || r.times > 10) err(`${label}.retry`, '{ "times": 0–10, "delay": "10s" }');
      else if (r.delay !== undefined && parseDuration(r.delay) === null) err(`${label}.retry.delay`, 'delay dạng "10s", "2m"');
    }
    if (s.onError !== undefined && s.onError !== "stop" && s.onError !== "continue") {
      err(`${label}.onError`, 'onError là "stop" (mặc định) hoặc "continue"');
    }
    if (s.timeout !== undefined) {
      const ms = parseDuration(s.timeout);
      if (ms === null || ms <= 0) err(`${label}.timeout`, 'timeout là số giây hoặc "30s", "2m"');
      else if (ms > limits.maxRunSeconds * 1000) err(`${label}.timeout`, `timeout tối đa ${limits.maxRunSeconds}s`);
    }

    const need = (k: string, what: string) => {
      if (s[k] === undefined || s[k] === null || s[k] === "") err(`${label}.${k}`, `Thiếu ${k}: ${what}`);
    };
    const expr = (k: string) => {
      if (isStr(s[k])) syntaxJobs.push({ path: `${label}.${k}`, code: s[k] as string, kind: "expr" });
    };
    const list = (k: string, required = false) => {
      if (s[k] === undefined) {
        if (required) err(`${label}.${k}`, `Thiếu ${k} (mảng các bước)`);
        else s[k] = [];
      } else if (!Array.isArray(s[k])) err(`${label}.${k}`, `${k} phải là mảng các bước`);
    };

    switch (s.type) {
      case "http": {
        need("url", "địa chỉ https://…");
        const m = String(s.method ?? "GET").toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(m)) err(`${label}.method`, "method là GET, POST, PUT, PATCH, DELETE, HEAD");
        s.method = m;
        if (s.headers !== undefined && !isObj(s.headers)) err(`${label}.headers`, 'headers là object { "Tên": "giá trị" }');
        if (s.query !== undefined && !isObj(s.query)) err(`${label}.query`, "query là object");
        if (s.bodyType !== undefined && !["json", "text", "form"].includes(String(s.bodyType))) {
          err(`${label}.bodyType`, 'bodyType là "json", "text" hoặc "form"');
        }
        break;
      }
      case "code":
        need("code", "mã JavaScript có return, vd: return steps.lay_don.output.body.length;");
        if (isStr(s.code)) syntaxJobs.push({ path: `${label}.code`, code: s.code, kind: "code" });
        break;
      case "if":
        need("cond", "biểu thức JS đúng/sai, vd steps.tong_hop.output.tong > 0");
        expr("cond");
        list("then", true);
        list("else");
        break;
      case "switch":
        need("value", "biểu thức JS lấy giá trị để so, vd inputs.loai");
        expr("value");
        if (!Array.isArray(s.cases)) err(`${label}.cases`, 'cases là mảng [{ "value": "a", "steps": [...] }]');
        else
          (s.cases as unknown[]).forEach((c, i) => {
            if (!isObj(c) || !Array.isArray(c.steps)) err(`${label}.cases[${i}]`, '{ "value": <giá trị>, "steps": [...] }');
            else if (c.value === undefined && c.when === undefined) err(`${label}.cases[${i}]`, 'Cần "value" (so bằng) hoặc "when" (biểu thức JS)');
            else if (isStr(c.when)) syntaxJobs.push({ path: `${label}.cases[${i}].when`, code: c.when, kind: "expr" });
          });
        list("default");
        break;
      case "loop":
        need("over", "biểu thức JS trả về mảng, vd steps.lay_don.output.body.items");
        expr("over");
        if (typeof s.max !== "number" || s.max < 1 || s.max > limits.maxLoop) {
          if (s.max === undefined) s.max = Math.min(100, limits.maxLoop);
          else err(`${label}.max`, `max (số vòng tối đa) từ 1 đến ${limits.maxLoop}`);
        }
        if (s.as !== undefined && (!isStr(s.as) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.as) || ["steps", "inputs", "vars", "trigger", "secrets", "loop", "index"].includes(s.as))) {
          err(`${label}.as`, 'as là tên biến hợp lệ (vd "don"), không trùng steps/inputs/vars/trigger/secrets/loop/index');
        }
        list("body", true);
        break;
      case "while":
        need("cond", "biểu thức JS, lặp khi còn đúng");
        expr("cond");
        if (typeof s.max !== "number" || s.max < 1 || s.max > limits.maxLoop) {
          if (s.max === undefined) s.max = Math.min(100, limits.maxLoop);
          else err(`${label}.max`, `max từ 1 đến ${limits.maxLoop}`);
        }
        list("body", true);
        break;
      case "parallel":
        if (!Array.isArray(s.branches) || !s.branches.length) err(`${label}.branches`, "branches là mảng các nhánh, mỗi nhánh là một mảng bước: [[...], [...]]");
        else if (s.branches.length > 10) err(`${label}.branches`, "Tối đa 10 nhánh");
        else (s.branches as unknown[]).forEach((b, i) => {
          if (!Array.isArray(b)) err(`${label}.branches[${i}]`, "Mỗi nhánh là một mảng bước");
        });
        break;
      case "wait":
        if (s.duration === undefined && s.until === undefined) err(label, 'Cần "duration" (vd "30s", "5m") hoặc "until" (thời điểm ISO / biểu thức)');
        if (s.duration !== undefined && !isStr(s.duration) && typeof s.duration !== "number") err(`${label}.duration`, 'duration dạng "30s", "5m"');
        else if (s.duration !== undefined && !String(s.duration).includes("{{")) {
          const ms = parseDuration(s.duration);
          if (ms === null) err(`${label}.duration`, 'duration dạng "30s", "5m"');
          else if (ms > limits.maxRunSeconds * 1000) err(`${label}.duration`, `Chờ tối đa ${limits.maxRunSeconds}s (giới hạn một lần chạy) — chờ lâu hơn thì tách thành quy trình chạy theo lịch`);
        }
        break;
      case "set":
        if (!isObj(s.values) || !Object.keys(s.values).length) err(`${label}.values`, 'values là object { "ten_bien": "{{ biểu thức }}" }');
        else for (const k of Object.keys(s.values)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) err(`${label}.values.${k}`, "Tên biến không hợp lệ");
        break;
      case "send":
        need("channel", 'kênh chat, vd "telegram:Bot bán hàng" (xem workflow_catalog)');
        need("to", "cuộc trò chuyện nhận tin (chatKey / id nhóm / id người)");
        if (s.text === undefined && s.files === undefined) err(`${label}.text`, "Cần text hoặc files");
        if (s.files !== undefined && !Array.isArray(s.files) && !isStr(s.files)) err(`${label}.files`, "files là mảng đường dẫn file");
        if (isStr(s.channel)) checkChannel(`${label}.channel`, s.channel);
        break;
      case "tool": {
        need("tool", "tên tool, vd http_fetch hoặc tên custom tool");
        if (s.args !== undefined && !isObj(s.args) && !isStr(s.args)) err(`${label}.args`, "args là object tham số");
        const tl = opts.catalog?.tools;
        if (tl && isStr(s.tool) && !tl.includes(s.tool)) {
          err(`${label}.tool`, `Tool "${s.tool}" không có; tool có: ${suggest(s.tool, tl, 12)}`);
        }
        if (isStr(s.agent) && opts.catalog?.agents && !opts.catalog.agents.includes(s.agent)) {
          err(`${label}.agent`, `Agent "${s.agent}" không có; agent có: ${suggest(s.agent, opts.catalog.agents)}`);
        }
        break;
      }
      case "mcp": {
        need("server", "tên MCP server");
        need("tool", "tên tool của MCP server");
        if (s.args !== undefined && !isObj(s.args) && !isStr(s.args)) err(`${label}.args`, "args là object tham số");
        const ms = opts.catalog?.mcp;
        if (ms && isStr(s.server)) {
          const srv = ms.find((m) => m.id === s.server || m.name.toLowerCase() === String(s.server).toLowerCase());
          if (!srv) err(`${label}.server`, `MCP server "${s.server}" không có; server có: ${suggest(s.server, ms.map((m) => m.name))}`);
          else if (srv.tools && isStr(s.tool) && !srv.tools.includes(s.tool)) {
            err(`${label}.tool`, `MCP "${srv.name}" không có tool "${s.tool}"; tool có: ${suggest(s.tool, srv.tools, 12)}`);
          }
        }
        break;
      }
      case "agent": {
        need("agent", "key của agent, vd tro-ly");
        need("message", "tin nhắn / việc giao cho agent");
        const al = opts.catalog?.agents;
        if (al && isStr(s.agent) && !s.agent.includes("{{") && !al.includes(s.agent)) {
          err(`${label}.agent`, `Agent "${s.agent}" không có; agent có: ${suggest(s.agent, al)}`);
        }
        if (s.deliver !== undefined) {
          const d = s.deliver;
          if (!isObj(d) || !isStr(d.channel) || !isStr(d.to)) err(`${label}.deliver`, '{ "channel": "<kênh>", "to": "<cuộc trò chuyện>" }');
          else checkChannel(`${label}.deliver.channel`, d.channel);
        }
        break;
      }
      case "respond":
        if (s.status !== undefined && (typeof s.status !== "number" || s.status < 100 || s.status > 599)) {
          if (!(isStr(s.status) && s.status.includes("{{"))) err(`${label}.status`, "status là mã HTTP 100–599");
        }
        break;
      case "subworkflow": {
        need("workflow", "id hoặc slug của quy trình cần gọi");
        const wl = opts.catalog?.workflows;
        if (wl && isStr(s.workflow) && !wl.some((w) => w.id === s.workflow || w.slug === s.workflow)) {
          err(`${label}.workflow`, `Quy trình "${s.workflow}" không có; có: ${suggest(s.workflow, wl.map((w) => w.slug))}`);
        }
        break;
      }
      case "file":
        if (!["read", "write", "append", "list", "delete"].includes(String(s.action))) err(`${label}.action`, "action là read, write, append, list, delete");
        if (s.action !== "list") need("path", "đường dẫn tương đối trong thư mục của quy trình, vd bao-cao/ngay.csv");
        if ((s.action === "write" || s.action === "append") && s.content === undefined) err(`${label}.content`, "Thiếu content");
        break;
      case "shell":
        need("command", "lệnh shell");
        if (!limits.allowShell) warn(label, "Bước shell đang bị tắt trên máy chủ này (cấu hình workflows.allowShell) — chạy sẽ báo lỗi");
        if (s.env !== undefined && !isObj(s.env)) err(`${label}.env`, "env là object");
        break;
      case "stop":
      case "break":
        break;
    }

    // Biểu thức trong chuỗi + secrets đặt sai chỗ
    const allowSecrets = SECRET_FIELDS[s.type] ?? [];
    for (const [k, v] of Object.entries(s)) {
      if (["id", "type", "then", "else", "body", "branches", "cases", "default", "code", "cond", "over", "value"].includes(k)) continue;
      const tpls: Array<{ path: string; expr: string }> = [];
      collectTemplates(v, `${label}.${k}`, tpls);
      for (const t of tpls) syntaxJobs.push({ path: t.path, code: t.expr, kind: "expr" });
      if (!allowSecrets.includes(k) && mentionsSecrets(v)) {
        err(`${label}.${k}`, `secrets.* chỉ dùng được trong ${allowSecrets.length ? allowSecrets.join(", ") : "http (url/headers/query/body), mcp.args, tool.args, shell.env"} — không dùng ở ${s.type}.${k}`);
      }
    }
    for (const k of ["code", "cond", "over", "value"]) {
      if (isStr(s[k]) && mentionsSecrets(s[k])) err(`${label}.${k}`, "Không dùng secrets.* trong mã/biểu thức điều kiện (tránh lộ khóa)");
    }
  });

  if (total > limits.maxSteps) err("steps", `Quá nhiều bước (${total}); tối đa ${limits.maxSteps}`);
  for (const [id, n] of idCount) if (n > 1) err("steps", `id bước "${id}" bị trùng ${n} lần — id phải duy nhất trong toàn quy trình`);

  // Tham chiếu steps.<id> / secrets.<TEN>
  const ids = new Set(idCount.keys());
  const refCheck = (path: string, code: string) => {
    for (const re of [STEP_REF_RE, STEP_REF_BRACKET_RE]) {
      for (const m of code.matchAll(re)) {
        if (!ids.has(m[1]!)) err(path, `Tham chiếu steps.${m[1]} nhưng không có bước nào id "${m[1]}"; id có: ${suggest(m[1]!, [...ids])}`);
      }
    }
    const sec = opts.catalog?.secrets;
    if (sec) {
      for (const m of code.matchAll(SECRET_REF_RE)) {
        if (!sec.includes(m[1]!)) err(path, `Khóa bí mật secrets.${m[1]} chưa có — tạo ở Dashboard → Quy trình → Khóa bí mật; đang có: ${suggest(m[1]!, sec)}`);
      }
    }
  };

  // Kiểm cú pháp song song có giới hạn
  for (const j of syntaxJobs) {
    refCheck(j.path, j.code);
    const msg = await checkSyntax(j.code, j.kind);
    if (msg) err(j.path, `Lỗi cú pháp JavaScript: ${msg}${j.kind === "expr" ? ` — biểu thức: ${stripBraces(j.code).slice(0, 120)}` : ""}`);
  }

  if (!steps.length) warn("steps", "Quy trình chưa có bước nào");
  const triggers = Array.isArray(def.triggers) ? (def.triggers as WorkflowTrigger[]) : [];
  if (triggers.some((t) => t.type !== "webhook") && JSON.stringify(steps).includes('"type":"respond"') && !triggers.some((t) => t.type === "webhook")) {
    warn("steps", "Có bước respond nhưng không có trigger webhook — bước này chỉ ghi log");
  }

  return { ok: errors.length === 0, errors, warnings, definition: def as unknown as WorkflowDefinition };
}

/** Chuỗi lỗi gọn cho AI/người đọc. */
export function formatIssues(issues: ValidationIssue[], max = 30): string {
  const lines = issues.slice(0, max).map((i) => `- ${i.path ? `${i.path}: ` : ""}${i.message}`);
  if (issues.length > max) lines.push(`- … và ${issues.length - max} lỗi khác`);
  return lines.join("\n");
}

/** Trigger lịch → chuỗi lịch đã chuẩn hóa. */
export function scheduleOf(t: WorkflowTrigger): string | null {
  if (t.type !== "schedule") return null;
  return (t.cron ?? t.schedule ?? "").trim() || null;
}

/** Danh sách bước thay đổi giữa hai bản (thêm/xóa/đổi). */
export function diffDefinitions(a: WorkflowDefinition | null, b: WorkflowDefinition): Array<{ kind: "added" | "removed" | "changed"; id: string; type?: string }> {
  const map = (d: WorkflowDefinition | null) => {
    const m = new Map<string, string>();
    if (!d) return m;
    walkSteps(d.steps ?? [], (s) => {
      if (!s?.id) return;
      const shallow: Record<string, unknown> = { ...s };
      for (const c of childLists(s)) delete shallow[c.key.split("[")[0]!];
      m.set(s.id, JSON.stringify(shallow));
    });
    return m;
  };
  const ma = map(a);
  const mb = map(b);
  const out: Array<{ kind: "added" | "removed" | "changed"; id: string; type?: string }> = [];
  for (const [id, v] of mb) {
    const t = (JSON.parse(v) as { type?: string }).type;
    if (!ma.has(id)) out.push({ kind: "added", id, ...(t ? { type: t } : {}) });
    else if (ma.get(id) !== v) out.push({ kind: "changed", id, ...(t ? { type: t } : {}) });
  }
  for (const [id, v] of ma) if (!mb.has(id)) out.push({ kind: "removed", id, type: (JSON.parse(v) as { type?: string }).type ?? "" });
  if (a && JSON.stringify(a.triggers) !== JSON.stringify(b.triggers)) out.push({ kind: "changed", id: "(triggers)" });
  return out;
}

/** Bỏ secrets ở các trường không được phép? (không cần — validator chặn). Các bước cần admin duyệt (tool có requiresApproval). */
export function stepsNeedingApproval(def: WorkflowDefinition, approvalTools: Set<string>): string[] {
  const out: string[] = [];
  walkSteps(def.steps, (s) => {
    if ((s.type === "tool" && isStr(s.tool) && approvalTools.has(s.tool)) || s.type === "shell") {
      if (s.approved !== true) out.push(s.id);
    }
  });
  return out;
}
