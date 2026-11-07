/**
 * Engine chạy quy trình — thuần logic, không biết database/kênh/tool cụ thể:
 * mọi việc có tác dụng ra ngoài đi qua `WorkflowHost` (máy chủ cung cấp), nhờ
 * vậy test được không cần PostgreSQL.
 *
 * Duyệt cây bước theo thứ tự; mỗi bước: thay `{{ }}` → gọi handler theo type →
 * ghi nhật ký bước → nạp `steps.<id>` cho các bước sau.
 */
import { ExprEnv, ExprError, stripBraces } from "./expr.js";
import { parseDuration, type StepBase, type WorkflowDefinition, type WorkflowInput } from "./definition.js";

export type RunStatus = "running" | "success" | "failed" | "stopped" | "timeout" | "cancelled";
export type StepStatus = "success" | "failed" | "skipped" | "dry_run";

export interface StepLog {
  stepId: string;
  type: string;
  path: string;
  iteration: number | null;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  durationMs: number;
  attempts: number;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface WorkflowHost {
  http(req: HttpRequest): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  send(input: { channel: string; to: string; text: string; files: string[]; signal: AbortSignal }): Promise<unknown>;
  tool(input: { tool: string; args: Record<string, unknown>; agent?: string; approved: boolean; signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  mcp(input: { server: string; tool: string; args: Record<string, unknown>; signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  agent(input: {
    agent: string;
    message: string;
    json: boolean;
    deliver?: { channel: string; to: string };
    dryRun: boolean;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<{ text: string; json?: unknown; usage?: unknown; delivered?: unknown }>;
  subworkflow(input: { workflow: string; inputs: Record<string, unknown>; wait: boolean; dryRun: boolean; signal: AbortSignal }): Promise<unknown>;
  file(input: { action: string; path: string; content?: string; signal: AbortSignal }): Promise<unknown>;
  shell(input: { command: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }): Promise<unknown>;
}

export interface RunOptions {
  definition: WorkflowDefinition;
  host: WorkflowHost;
  inputs?: Record<string, unknown>;
  trigger: Record<string, unknown>;
  /** Khóa bí mật của workspace — chỉ thay ở http/mcp/tool args/shell env, che trong log. */
  secrets?: Record<string, string>;
  workflow?: { id: string; name: string; runId: string; version?: number };
  timezone: string;
  /** Trần một lần chạy (ms). */
  maxRunMs?: number;
  /** Timeout mặc định của bước. */
  stepTimeoutMs?: number;
  /** Không gửi thật: send/mcp/tool/http ghi/shell/file ghi chỉ mô tả việc sẽ làm. */
  dryRun?: boolean;
  allowShell?: boolean;
  signal?: AbortSignal;
  onStep?: (log: StepLog) => void | Promise<void>;
  /** Bước respond đầu tiên (webhook chờ kết quả). */
  onRespond?: (res: { status: number; headers: Record<string, string>; body: unknown }) => void;
  /** Trần số dòng nhật ký bước mỗi lần chạy. */
  maxStepLogs?: number;
}

export interface RunResult {
  status: Exclude<RunStatus, "running">;
  output: unknown;
  error: string | null;
  response: { status: number; headers: Record<string, string>; body: unknown } | null;
  stepCount: number;
  durationMs: number;
}

class StopSignal {
  constructor(public reason: string) {}
}
class BreakSignal {}
class RunTimeout extends Error {}

const LOG_LIMIT = 64 * 1024;

/** Cắt giá trị lớn trước khi ghi nhật ký (giữ dạng JSON đọc được). */
export function truncateForLog(v: unknown, limit = LOG_LIMIT): unknown {
  if (v === undefined) return null;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return String(v);
  }
  if (s === undefined) return null;
  if (s.length <= limit) return v;
  return { _truncated: true, size: s.length, preview: s.slice(0, limit) };
}

/** Thay mọi giá trị bí mật xuất hiện trong dữ liệu bằng ***. */
export function maskSecrets(v: unknown, secretValues: string[]): unknown {
  const vals = secretValues.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length);
  if (!vals.length) return v;
  const mask = (s: string) => {
    let out = s;
    for (const x of vals) if (out.includes(x)) out = out.split(x).join("***");
    return out;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return mask(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) o[k] = walk(val);
      return o;
    }
    return x;
  };
  return walk(v);
}

/** Gộp inputs: mặc định + giá trị truyền vào, ép kiểu theo khai báo. */
export function coerceInputs(
  decl: Record<string, WorkflowInput> | undefined,
  given: Record<string, unknown>,
  render: (v: unknown) => unknown,
): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = { ...given };
  const errors: string[] = [];
  for (const [k, d] of Object.entries(decl ?? {})) {
    let v = given[k];
    if (v === undefined || v === "") {
      if (d.default !== undefined) v = render(d.default);
      else if (d.required) {
        errors.push(`Thiếu tham số bắt buộc "${k}"${d.note ? ` (${d.note})` : ""}`);
        continue;
      } else {
        values[k] = d.type === "boolean" ? false : null;
        continue;
      }
    }
    switch (d.type) {
      case "number": {
        const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
        if (!Number.isFinite(n)) errors.push(`Tham số "${k}" phải là số (nhận "${String(v)}")`);
        values[k] = n;
        break;
      }
      case "boolean":
        values[k] = v === true || v === "true" || v === "1" || v === 1 || v === "on" || v === "yes";
        break;
      case "json":
        if (typeof v === "string") {
          try {
            values[k] = JSON.parse(v);
          } catch {
            errors.push(`Tham số "${k}" phải là JSON hợp lệ`);
          }
        } else values[k] = v;
        break;
      default:
        values[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  }
  return { values, errors };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("Đã hủy"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("Đã hủy"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Chạy một promise với trần thời gian + tín hiệu hủy. */
async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal, what: string): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p(ctrl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort(new Error(`${what}: quá thời gian ${Math.round(ms / 1000)}s`));
          reject(new Error(`${what}: quá thời gian ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
      new Promise<never>((_, reject) => {
        if (parent.aborted) reject(parent.reason);
        parent.addEventListener("abort", () => reject(parent.reason), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const toStr = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Chạy một quy trình tới khi xong. Không ném lỗi — kết quả nằm trong RunResult. */
export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const def = opts.definition;
  const maxRunMs = Math.min(opts.maxRunMs ?? 600_000, (def.settings?.timeoutSec ?? Infinity) * 1000);
  const stepTimeoutDefault = opts.stepTimeoutMs ?? 30_000;
  const secrets = opts.secrets ?? {};
  const secretValues = Object.values(secrets);
  const dry = opts.dryRun === true;
  const maxLogs = opts.maxStepLogs ?? 2000;
  const runCtrl = new AbortController();
  const parentSignal = opts.signal;
  const onParentAbort = () => runCtrl.abort(parentSignal?.reason ?? new Error("Đã hủy"));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const runTimer = setTimeout(() => runCtrl.abort(new RunTimeout(`Quá thời gian chạy tối đa ${Math.round(maxRunMs / 1000)}s`)), maxRunMs);
  const signal = runCtrl.signal;

  let env: ExprEnv | null = null;
  let response: RunResult["response"] = null;
  let lastOutput: unknown = null;
  let stepCount = 0;
  let logCount = 0;
  const pendingLogs: Array<Promise<void>> = [];

  const log = (l: StepLog) => {
    stepCount++;
    if (!opts.onStep || logCount >= maxLogs) return;
    logCount++;
    const masked: StepLog = {
      ...l,
      input: truncateForLog(maskSecrets(l.input, secretValues)),
      output: truncateForLog(maskSecrets(l.output, secretValues)),
      error: l.error ? String(maskSecrets(l.error, secretValues)) : null,
    };
    try {
      const r = opts.onStep(masked);
      if (r && typeof (r as Promise<void>).then === "function") pendingLogs.push((r as Promise<void>).catch(() => {}));
    } catch {
      // nhật ký lỗi không làm hỏng lần chạy
    }
  };

  const finish = async (status: RunResult["status"], error: string | null): Promise<RunResult> => {
    clearTimeout(runTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
    env?.dispose();
    await Promise.all(pendingLogs);
    return {
      status,
      output: truncateForLog(maskSecrets(response ? response.body : lastOutput, secretValues), 256 * 1024),
      error: error ? String(maskSecrets(error, secretValues)) : null,
      response: response ? (maskSecrets(response, secretValues) as RunResult["response"]) : null,
      stepCount,
      durationMs: Date.now() - started,
    };
  };

  try {
    env = await ExprEnv.create({ timezone: opts.timezone, timeoutMs: stepTimeoutDefault });
  } catch (err) {
    return finish("failed", `Không khởi tạo được máy ảo biểu thức: ${(err as Error).message}`);
  }
  const ex = env;

  // ---- ngữ cảnh ban đầu ----
  ex.setGlobal("trigger", opts.trigger);
  ex.setGlobal("workflow", opts.workflow ?? { id: "", name: def.name, runId: "" });
  const inp = coerceInputs(def.inputs, opts.inputs ?? {}, (v) => ex.render(v));
  if (inp.errors.length) return finish("failed", inp.errors.join("; "));
  ex.setGlobal("inputs", inp.values);

  /** Thay biểu thức; secrets chỉ nạp khi trường được phép. */
  const renderWith = (v: unknown, allowSecrets: boolean): unknown => {
    if (!allowSecrets || !secretValues.length) return ex.render(v);
    ex.setGlobal("secrets", secrets);
    try {
      return ex.render(v);
    } finally {
      ex.deleteGlobal("secrets");
    }
  };

  const loopVars: string[] = [];

  async function runSteps(list: StepBase[], path: string, iteration: number | null): Promise<unknown> {
    let out: unknown = null;
    for (let i = 0; i < list.length; i++) {
      if (signal.aborted) throw signal.reason;
      const s = list[i]!;
      out = await runStep(s, `${path}[${i}]`, iteration);
    }
    return out;
  }

  async function runStep(s: StepBase, path: string, iteration: number | null): Promise<unknown> {
    if (s.disabled) {
      log({ stepId: s.id, type: s.type, path, iteration, status: "skipped", input: null, output: null, error: null, startedAt: new Date(), durationMs: 0, attempts: 0 });
      return lastOutput;
    }
    const t0 = Date.now();
    const startedAt = new Date();
    const timeoutMs = parseDuration(s.timeout) ?? (["agent", "mcp", "tool", "subworkflow", "shell"].includes(s.type) ? Math.max(stepTimeoutDefault, 120_000) : stepTimeoutDefault);
    const retries = s.retry?.times ?? 0;
    const retryDelay = parseDuration(s.retry?.delay) ?? 5000;
    let attempts = 0;
    let lastErr: unknown = null;
    let input: unknown = null;

    while (attempts <= retries) {
      attempts++;
      try {
        const res = await execStep(s, path, iteration, timeoutMs, (x) => (input = x));
        const status: StepStatus = res.dry ? "dry_run" : "success";
        ex.setStep(s.id, { output: res.output, status, durationMs: Date.now() - t0 });
        if (!isContainer(s.type)) lastOutput = res.output;
        log({ stepId: s.id, type: s.type, path, iteration, status, input, output: res.output, error: null, startedAt, durationMs: Date.now() - t0, attempts });
        return res.output;
      } catch (err) {
        if (err instanceof StopSignal || err instanceof BreakSignal || err instanceof RunTimeout) {
          if (err instanceof StopSignal && s.type === "stop") {
            log({ stepId: s.id, type: s.type, path, iteration, status: "success", input, output: { reason: err.reason }, error: null, startedAt, durationMs: Date.now() - t0, attempts });
          }
          throw err;
        }
        if (signal.aborted) throw signal.reason;
        if (err instanceof StepFailed && isContainer(s.type)) {
          // Lỗi của bước con: không thử lại cả khối, chỉ đánh dấu khối lỗi
          ex.setStep(s.id, { output: null, error: err.message, status: "failed", durationMs: Date.now() - t0 });
          log({ stepId: s.id, type: s.type, path, iteration, status: "failed", input, output: null, error: err.message, startedAt, durationMs: Date.now() - t0, attempts });
          if (s.onError === "continue") return null;
          throw err;
        }
        lastErr = err;
        // Lỗi cú pháp/biểu thức không thử lại
        if (err instanceof ExprError || attempts > retries) break;
        await sleep(retryDelay, signal);
      }
    }
    const msg = errorMessage(lastErr);
    ex.setStep(s.id, { output: null, error: msg, status: "failed", durationMs: Date.now() - t0 });
    log({ stepId: s.id, type: s.type, path, iteration, status: "failed", input, output: null, error: msg, startedAt, durationMs: Date.now() - t0, attempts });
    if (s.onError === "continue") return null;
    throw new StepFailed(s.id, msg);
  }

  async function execStep(
    s: StepBase,
    path: string,
    iteration: number | null,
    timeoutMs: number,
    setInput: (x: unknown) => void,
  ): Promise<{ output: unknown; dry?: boolean }> {
    const label = s.name ? `${s.id} (${s.name})` : s.id;
    switch (s.type) {
      case "code": {
        setInput({ code: String(s.code ?? "").slice(0, 2000) });
        return { output: ex.runCode(String(s.code ?? ""), timeoutMs) };
      }
      case "set": {
        const values = asRecord(ex.render(s.values));
        setInput(values);
        for (const [k, v] of Object.entries(values)) ex.setVar(k, v);
        return { output: values };
      }
      case "if": {
        const cond = !!ex.evaluate(String(s.cond));
        setInput({ cond: String(s.cond) });
        const branch = cond ? "then" : "else";
        const list = (s[branch] as StepBase[] | undefined) ?? [];
        ex.setStep(s.id, { output: { branch }, status: "success", durationMs: 0 });
        await runSteps(list, `${path}.${branch}`, iteration);
        return { output: { branch, result: cond } };
      }
      case "switch": {
        const value = ex.evaluate(String(s.value));
        setInput({ value });
        const cases = (s.cases as Array<{ value?: unknown; when?: string; steps: StepBase[] }>) ?? [];
        let idx = -1;
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i]!;
          if (typeof c.when === "string") {
            ex.setGlobal("value", value);
            const hit = !!ex.evaluate(c.when);
            ex.deleteGlobal("value");
            if (hit) {
              idx = i;
              break;
            }
          } else {
            const cv = ex.render(c.value);
            const eq = Array.isArray(cv) ? cv.some((x) => String(x) === String(value)) : String(cv) === String(value);
            if (eq) {
              idx = i;
              break;
            }
          }
        }
        const list = idx >= 0 ? cases[idx]!.steps : ((s.default as StepBase[] | undefined) ?? []);
        ex.setStep(s.id, { output: { case: idx >= 0 ? idx : "default", value }, status: "success", durationMs: 0 });
        await runSteps(list, idx >= 0 ? `${path}.cases[${idx}].steps` : `${path}.default`, iteration);
        return { output: { case: idx >= 0 ? idx : "default", value } };
      }
      case "loop": {
        const arrRaw = ex.evaluate(String(s.over));
        const arr = Array.isArray(arrRaw)
          ? arrRaw
          : arrRaw && typeof arrRaw === "object"
            ? Object.entries(arrRaw as Record<string, unknown>).map(([key, value]) => ({ key, value }))
            : typeof arrRaw === "number"
              ? Array.from({ length: Math.max(0, Math.floor(arrRaw)) }, (_, i) => i)
              : null;
        if (!arr) throw new Error(`over phải trả về mảng (nhận ${arrRaw === null ? "null" : typeof arrRaw})`);
        const max = Number(s.max ?? 100);
        if (arr.length > max) throw new Error(`Mảng có ${arr.length} phần tử, vượt max=${max} của vòng lặp — tăng max hoặc lọc bớt`);
        setInput({ over: String(s.over), count: arr.length });
        const as = typeof s.as === "string" && s.as ? s.as : "item";
        const body = (s.body as StepBase[]) ?? [];
        const items: unknown[] = [];
        let broke = false;
        loopVars.push(as);
        try {
          for (let i = 0; i < arr.length; i++) {
            if (signal.aborted) throw signal.reason;
            ex.setGlobal(as, arr[i]);
            ex.setGlobal("index", i);
            ex.setGlobal("loop", { index: i, first: i === 0, last: i === arr.length - 1, count: arr.length });
            try {
              items.push(await runSteps(body, `${path}.body`, i));
            } catch (err) {
              if (err instanceof BreakSignal) {
                broke = true;
                break;
              }
              throw err;
            }
          }
        } finally {
          loopVars.pop();
          ex.deleteGlobal(as);
          ex.deleteGlobal("index");
          ex.deleteGlobal("loop");
        }
        return { output: { count: items.length, items: items.map((x) => truncateForLog(x, 16 * 1024)), broke } };
      }
      case "while": {
        const max = Number(s.max ?? 100);
        const body = (s.body as StepBase[]) ?? [];
        const items: unknown[] = [];
        let n = 0;
        setInput({ cond: String(s.cond), max });
        let broke = false;
        try {
          while (n < max) {
            if (signal.aborted) throw signal.reason;
            ex.setGlobal("index", n);
            ex.setGlobal("loop", { index: n, first: n === 0 });
            if (!ex.evaluate(String(s.cond))) break;
            try {
              items.push(await runSteps(body, `${path}.body`, n));
            } catch (err) {
              if (err instanceof BreakSignal) {
                broke = true;
                break;
              }
              throw err;
            }
            n++;
          }
          if (n >= max && !broke && ex.evaluate(String(s.cond))) {
            throw new Error(`while chạm trần max=${max} vòng mà điều kiện vẫn đúng`);
          }
        } finally {
          ex.deleteGlobal("index");
          ex.deleteGlobal("loop");
        }
        return { output: { count: items.length, items: items.map((x) => truncateForLog(x, 16 * 1024)), broke } };
      }
      case "parallel": {
        const branches = (s.branches as StepBase[][]) ?? [];
        setInput({ branches: branches.length });
        const results = await Promise.allSettled(branches.map((b, i) => runSteps(b, `${path}.branches[${i}]`, iteration)));
        const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        if (failed) throw failed.reason;
        return { output: results.map((r) => (r as PromiseFulfilledResult<unknown>).value) };
      }
      case "break":
        throw new BreakSignal();
      case "stop": {
        const reason = toStr(ex.render(s.reason ?? "Dừng theo quy trình"));
        setInput({ reason });
        throw new StopSignal(reason);
      }
      case "wait": {
        let ms: number;
        if (s.until !== undefined) {
          const until = ex.render(s.until);
          const at = new Date(String(until)).getTime();
          if (Number.isNaN(at)) throw new Error(`until "${String(until)}" không phải thời điểm hợp lệ`);
          ms = Math.max(0, at - Date.now());
        } else {
          const d = ex.render(s.duration);
          const parsed = parseDuration(d);
          if (parsed === null) throw new Error(`duration "${String(d)}" không hợp lệ`);
          ms = parsed;
        }
        setInput({ ms });
        const remaining = maxRunMs - (Date.now() - started) - 1000;
        if (ms > remaining) throw new Error(`Chờ ${Math.round(ms / 1000)}s vượt thời gian còn lại của lần chạy (${Math.round(remaining / 1000)}s)`);
        if (!dry) await sleep(ms, signal);
        return { output: { waitedMs: dry ? 0 : ms }, ...(dry ? { dry: true } : {}) };
      }
      case "http": {
        const method = String(s.method ?? "GET").toUpperCase();
        let url = toStr(renderWith(s.url, true));
        const query = asRecord(renderWith(s.query ?? {}, true));
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(asRecord(renderWith(s.headers ?? {}, true)))) headers[k] = toStr(v);
        if (Object.keys(query).length) {
          const u = new URL(url);
          for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, toStr(v));
          url = u.toString();
        }
        let body: string | undefined;
        if (s.body !== undefined && method !== "GET" && method !== "HEAD") {
          const b = renderWith(s.body, true);
          const bodyType = String(s.bodyType ?? (typeof b === "string" ? "text" : "json"));
          if (bodyType === "form") {
            body = new URLSearchParams(Object.entries(asRecord(b)).map(([k, v]): [string, string] => [k, toStr(v)])).toString();
            headers["content-type"] ??= "application/x-www-form-urlencoded";
          } else if (bodyType === "text") {
            body = toStr(b);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "text/plain; charset=utf-8";
          } else {
            body = JSON.stringify(b);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
          }
        }
        setInput({ method, url, headers, ...(body !== undefined ? { body: body.length > 4000 ? body.slice(0, 4000) + "…" : body } : {}) });
        const writes = method !== "GET" && method !== "HEAD";
        if (dry && writes) return { output: { dryRun: true, method, url }, dry: true };
        const res = await withTimeout((sig) => opts.host.http({ method, url, headers, ...(body !== undefined ? { body } : {}), timeoutMs, signal: sig }), timeoutMs, signal, `Bước ${label}`);
        if (s.failOnStatus !== false && res.status >= 400) {
          const preview = typeof res.body === "string" ? res.body.slice(0, 300) : JSON.stringify(res.body).slice(0, 300);
          const e = new Error(`HTTP ${res.status} từ ${new URL(url).host}: ${preview}`);
          (e as Error & { output?: unknown }).output = res;
          throw e;
        }
        return { output: res };
      }
      case "send": {
        const channel = toStr(ex.render(s.channel));
        const to = toStr(ex.render(s.to));
        const text = toStr(ex.render(s.text ?? ""));
        const filesRaw = ex.render(s.files ?? []);
        const files = (Array.isArray(filesRaw) ? filesRaw : [filesRaw]).map(toStr).filter(Boolean);
        setInput({ channel, to, text, files });
        if (!text.trim() && !files.length) return { output: { skipped: "Nội dung trống — không gửi" } };
        if (dry) return { output: { dryRun: true, channel, to, text, files }, dry: true };
        return { output: await withTimeout((sig) => opts.host.send({ channel, to, text, files, signal: sig }), timeoutMs, signal, `Bước ${label}`) };
      }
      case "tool": {
        const tool = toStr(ex.render(s.tool));
        const argsRaw = renderWith(s.args ?? {}, true);
        const args = typeof argsRaw === "string" ? asRecord(JSON.parse(argsRaw)) : asRecord(argsRaw);
        setInput({ tool, args, ...(s.agent ? { agent: s.agent } : {}) });
        if (dry && s.readOnly !== true) return { output: { dryRun: true, tool, args }, dry: true };
        return {
          output: await withTimeout(
            (sig) => opts.host.tool({ tool, args, ...(typeof s.agent === "string" ? { agent: s.agent } : {}), approved: s.approved === true, signal: sig, timeoutMs }),
            timeoutMs,
            signal,
            `Bước ${label}`,
          ),
        };
      }
      case "mcp": {
        const server = toStr(ex.render(s.server));
        const tool = toStr(ex.render(s.tool));
        const argsRaw = renderWith(s.args ?? {}, true);
        const args = typeof argsRaw === "string" ? asRecord(JSON.parse(argsRaw)) : asRecord(argsRaw);
        setInput({ server, tool, args });
        if (dry && s.readOnly !== true) return { output: { dryRun: true, server, tool, args }, dry: true };
        return { output: await withTimeout((sig) => opts.host.mcp({ server, tool, args, signal: sig, timeoutMs }), timeoutMs, signal, `Bước ${label}`) };
      }
      case "agent": {
        const agent = toStr(ex.render(s.agent));
        const message = toStr(ex.render(s.message));
        const deliverRaw = s.deliver ? asRecord(ex.render(s.deliver)) : null;
        const deliver = deliverRaw && deliverRaw.channel && deliverRaw.to ? { channel: toStr(deliverRaw.channel), to: toStr(deliverRaw.to) } : undefined;
        setInput({ agent, message, ...(deliver ? { deliver } : {}), ...(s.json ? { json: true } : {}) });
        const out = await withTimeout(
          (sig) => opts.host.agent({ agent, message, json: s.json === true, ...(deliver ? { deliver } : {}), dryRun: dry, signal: sig, timeoutMs }),
          timeoutMs,
          signal,
          `Bước ${label}`,
        );
        return { output: out };
      }
      case "respond": {
        const status = Number(ex.render(s.status ?? 200)) || 200;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(asRecord(ex.render(s.headers ?? {})))) headers[k] = toStr(v);
        const body = ex.render(s.body ?? null);
        setInput({ status });
        const res = { status, headers, body };
        if (!response) {
          response = res;
          try {
            opts.onRespond?.(maskSecrets(res, secretValues) as typeof res);
          } catch {
            // bỏ qua
          }
        }
        return { output: res };
      }
      case "subworkflow": {
        const workflow = toStr(ex.render(s.workflow));
        const inputs = asRecord(ex.render(s.inputs ?? {}));
        const wait = s.wait !== false;
        setInput({ workflow, inputs, wait });
        return {
          output: await withTimeout((sig) => opts.host.subworkflow({ workflow, inputs, wait, dryRun: dry, signal: sig }), Math.max(timeoutMs, 60_000), signal, `Bước ${label}`),
        };
      }
      case "file": {
        const action = String(s.action);
        const p = toStr(ex.render(s.path ?? ""));
        const content = s.content !== undefined ? ex.render(s.content) : undefined;
        const contentStr = content === undefined ? undefined : typeof content === "string" ? content : JSON.stringify(content, null, 2);
        setInput({ action, path: p, ...(contentStr !== undefined ? { content: contentStr.slice(0, 2000) } : {}) });
        const writes = action !== "read" && action !== "list";
        if (dry && writes) return { output: { dryRun: true, action, path: p }, dry: true };
        return { output: await withTimeout((sig) => opts.host.file({ action, path: p, ...(contentStr !== undefined ? { content: contentStr } : {}), signal: sig }), timeoutMs, signal, `Bước ${label}`) };
      }
      case "shell": {
        if (!opts.allowShell) throw new Error("Bước shell đang tắt trên máy chủ này (cấu hình workflows.allowShell: true để bật)");
        if (s.approved !== true) throw new Error("Bước shell cần quản trị viên tick \"Cho phép chạy\" trên Dashboard");
        const command = toStr(ex.render(s.command));
        const envVars: Record<string, string> = {};
        for (const [k, v] of Object.entries(asRecord(renderWith(s.env ?? {}, true)))) envVars[k] = toStr(v);
        setInput({ command, env: Object.keys(envVars) });
        if (dry) return { output: { dryRun: true, command }, dry: true };
        return { output: await withTimeout((sig) => opts.host.shell({ command, env: envVars, timeoutMs, signal: sig }), timeoutMs + 2000, signal, `Bước ${label}`) };
      }
      default:
        throw new Error(`Loại bước "${s.type}" không có`);
    }
  }

  try {
    await runSteps(def.steps ?? [], "steps", null);
    return finish("success", null);
  } catch (err) {
    if (err instanceof StopSignal) return finish("stopped", err.reason);
    if (err instanceof BreakSignal) return finish("success", null);
    if (err instanceof RunTimeout || (signal.aborted && signal.reason instanceof RunTimeout)) {
      return finish("timeout", (signal.reason as Error)?.message ?? (err as Error).message);
    }
    if (signal.aborted) return finish("cancelled", errorMessage(signal.reason ?? err));
    return finish("failed", errorMessage(err));
  }
}

class StepFailed extends Error {
  constructor(public stepId: string, msg: string) {
    super(`Bước "${stepId}" lỗi: ${msg}`);
  }
}

function isContainer(t: string): boolean {
  return t === "if" || t === "switch" || t === "loop" || t === "while" || t === "parallel";
}

function errorMessage(err: unknown): string {
  if (err instanceof StepFailed) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export { stripBraces };
