import { Cron } from "croner";

/**
 * Lịch chạy agent. Dạng lưu trong DB (cột cron_jobs.schedule):
 * - "every 30s" | "every 5m" | "every 2h" | "every 1d" — lặp theo chu kỳ
 * - "at 2026-09-28 08:00" — chạy 1 lần. Không ghi múi giờ → hiểu theo múi giờ
 *   của job (cột timezone); job cũ không có múi giờ → giờ của máy chủ như trước.
 * - cron expression 5-6 trường: "0 9 * * *" — theo múi giờ của job.
 *
 * Lúc tạo lịch còn nhận thêm "in 30m" (sau một khoảng) — normalizeSchedule đổi
 * ngay thành "at <thời điểm>" vì lịch tương đối không lưu được.
 */

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** Đơn vị người dùng/AI hay viết → đơn vị chuẩn. */
const UNIT_ALIASES: Record<string, Unit> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s", "giây": "s",
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m", "phút": "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h", "giờ": "h", "tiếng": "h",
  d: "d", day: "d", days: "d", "ngày": "d",
};

const UNIT_VI: Record<Unit, string> = { s: "giây", m: "phút", h: "giờ", d: "ngày" };

const RELATIVE_RE = /^(every|in)\s+(\d+)\s*(\p{L}+)$/iu;
const AT_RE = /^at\s+(.+)$/i;
/** Thời điểm có múi giờ tường minh ở cuối: "Z", "+07:00", "-0500". */
const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

const WEEKDAY_VI = ["Chủ nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function relative(s: string): { kind: "every" | "in"; n: number; unit: Unit } | null {
  const m = RELATIVE_RE.exec(s);
  if (!m) return null;
  const unit = UNIT_ALIASES[m[3]!.toLowerCase()];
  if (!unit) return null;
  return { kind: m[1]!.toLowerCase() as "every" | "in", n: Number(m[2]), unit };
}

/** Múi giờ máy chủ — chỉ dùng cho lịch cũ chưa lưu múi giờ. */
function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Giờ đồng hồ (năm, tháng, ngày, giờ...) của thời điểm `at` tại múi giờ `timeZone`. */
function wallClockOf(at: Date, timeZone: string): WallClock & { weekday: number } {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY_EN.indexOf(p.weekday ?? ""),
  };
}

/** Độ lệch (ms) của múi giờ so với UTC tại thời điểm `at` (+7h → 25_200_000). */
function offsetMs(at: Date, timeZone: string): number {
  const w = wallClockOf(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (at.getTime() - at.getUTCMilliseconds());
}

/** Giờ đồng hồ tại một múi giờ → thời điểm tuyệt đối. Ngày/giờ không tồn tại → lỗi. */
function wallClockToDate(w: WallClock, timeZone: string): Date {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let t = asUtc - offsetMs(new Date(asUtc), timeZone);
  // Múi giờ có đổi giờ mùa hè: độ lệch tại thời điểm thật có thể khác lần đoán đầu
  t = asUtc - offsetMs(new Date(t), timeZone);
  const back = wallClockOf(new Date(t), timeZone);
  if (
    back.year !== w.year ||
    back.month !== w.month ||
    back.day !== w.day ||
    back.hour !== w.hour ||
    back.minute !== w.minute
  ) {
    throw new Error(
      `Không có thời điểm ${pad(w.day)}/${pad(w.month)}/${w.year} ${pad(w.hour)}:${pad(w.minute)} theo múi giờ ${timeZone}`,
    );
  }
  return new Date(t);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Đọc "2026-09-28 08:00", "2026-09-28T08:00:30", "28/09/2026 8h30"... thành giờ
 * đồng hồ. Bắt buộc có giờ — "ngày 28" không đủ để hẹn giờ.
 */
function parseWallClock(text: string): WallClock {
  const hint = 'dạng đúng: "2026-09-28 08:00" hoặc "28/09/2026 08:00"';
  const m = /^(\S+?)(?:[T\s]+(\S+))?$/.exec(text.trim());
  if (!m) throw new Error(`Thời điểm không hợp lệ: ${text} (${hint})`);
  const [, datePart, timePart] = m;
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart!);
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(datePart!);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (vn) {
    [day, month, year] = [Number(vn[1]), Number(vn[2]), Number(vn[3])];
  } else {
    throw new Error(`Thời điểm không hợp lệ: ${text} (${hint})`);
  }
  if (!timePart) throw new Error(`Thiếu giờ trong "${text}" (${hint})`);
  const t = /^(\d{1,2})(?:[:hH](\d{2})?)?(?::(\d{2}))?$/.exec(timePart);
  if (!t) throw new Error(`Giờ không hợp lệ trong "${text}" (${hint})`);
  const hour = Number(t[1]);
  const minute = Number(t[2] ?? 0);
  const second = Number(t[3] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Thời điểm không hợp lệ: ${text} (${hint})`);
  }
  return { year, month, day, hour, minute, second };
}

/** Thời điểm của lịch "at ...". Không có múi giờ (job cũ) → Date tự hiểu như trước. */
function parseAt(text: string, timezone?: string | null): Date {
  const s = text.trim();
  if (!timezone || OFFSET_RE.test(s)) {
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) throw new Error(`Thời điểm không hợp lệ: ${s}`);
    return t;
  }
  return wallClockToDate(parseWallClock(s), timezone);
}

function cronOf(expr: string, timezone?: string | null): Cron {
  try {
    return timezone ? new Cron(expr, { timezone }) : new Cron(expr);
  } catch (err) {
    throw new Error(`Lịch không hợp lệ "${expr}": ${(err as Error).message}`);
  }
}

/**
 * Tính lần chạy kế tiếp cho một lịch.
 *
 * @param from mốc thời gian tham chiếu — truyền vào để test được.
 * @param timezone múi giờ của job; bỏ trống = giờ máy chủ (job tạo trước 1.2.0).
 * @returns thời điểm kế tiếp (Date) hoặc null nếu không còn (one-shot đã qua).
 */
export function nextRun(schedule: string, from: Date, timezone?: string | null): Date | null {
  const s = schedule.trim().normalize("NFC");

  const rel = relative(s);
  if (rel?.kind === "every") return new Date(from.getTime() + rel.n * UNIT_MS[rel.unit]);
  if (rel?.kind === "in") {
    throw new Error(`"${s}" là lịch tương đối — đổi sang "at ..." bằng normalizeSchedule trước khi lưu`);
  }

  const at = AT_RE.exec(s);
  if (at) {
    const t = parseAt(at[1]!, timezone);
    return t.getTime() > from.getTime() ? t : null;
  }

  return cronOf(s, timezone).nextRun(from) ?? null;
}

/** Kiểm tra một chuỗi lịch đã lưu có hợp lệ không. */
export function validateSchedule(schedule: string, timezone?: string | null): void {
  nextRun(schedule, new Date(0), timezone);
}

/**
 * Chuẩn hóa lịch người dùng/AI nhập lúc tạo hoặc sửa job: "in 30m" → "at <giờ cụ
 * thể>", "at 28/09/2026 8h" → "at 2026-09-28 08:00", "every 2 giờ" → "every 2h".
 * Ném lỗi (tiếng Việt, kèm ví dụ) nếu không hiểu được.
 */
export function normalizeSchedule(input: string, now: Date, timezone: string): string {
  const s = input.trim().normalize("NFC").replace(/\s+/g, " ");
  if (!s) throw new Error("Thiếu lịch");

  const rel = relative(s);
  if (rel) {
    if (rel.n <= 0) throw new Error("Khoảng thời gian phải lớn hơn 0");
    if (rel.kind === "every") return `every ${rel.n}${rel.unit}`;
    return `at ${formatWallClock(new Date(now.getTime() + rel.n * UNIT_MS[rel.unit]), timezone)}`;
  }

  const at = AT_RE.exec(s);
  if (at) return `at ${formatWallClock(parseAt(at[1]!, timezone), timezone)}`;

  const fields = s.split(" ");
  if (fields.length < 5 || fields.length > 6) {
    throw new Error(
      `Lịch không hợp lệ "${s}" — dùng "in 30m" (sau 30 phút), "at 2026-09-28 08:00" (một lần), ` +
        `"every 2h" (mỗi 2 giờ) hoặc cron 5 trường "phút giờ ngày tháng thứ" như "0 8 * * *"`,
    );
  }
  cronOf(s, timezone);
  return s;
}

/** "2026-09-28 08:00" (thêm ":ss" nếu giây khác 0) theo múi giờ. */
function formatWallClock(at: Date, timeZone: string): string {
  const w = wallClockOf(at, timeZone);
  const base = `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
  return w.second ? `${base}:${pad(w.second)}` : base;
}

/**
 * Khoảng cách ngắn nhất giữa hai lần chạy liên tiếp (ms) — chặn lịch quá dày.
 * Lịch một lần → Infinity.
 */
export function minIntervalMs(schedule: string, from: Date, timezone?: string | null): number {
  const s = schedule.trim().normalize("NFC");
  const rel = relative(s);
  if (rel?.kind === "every") return rel.n * UNIT_MS[rel.unit];
  if (AT_RE.test(s)) return Infinity;
  const runs = cronOf(s, timezone).nextRuns(6, from);
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) {
    min = Math.min(min, runs[i]!.getTime() - runs[i - 1]!.getTime());
  }
  return min;
}

/** "08:00 thứ Hai 28/09/2026" theo múi giờ (bỏ trống = giờ máy chủ). */
export function formatInZone(at: Date, timezone?: string | null): string {
  const w = wallClockOf(at, timezone || serverTimeZone());
  return `${pad(w.hour)}:${pad(w.minute)} ${WEEKDAY_VI[w.weekday] ?? ""} ${pad(w.day)}/${pad(w.month)}/${w.year}`;
}

/** "YYYY-MM-DD" của ngày hiện tại theo múi giờ — "hôm nay" của agent. */
export function localDateKey(at: Date, timezone?: string | null): string {
  const w = wallClockOf(at, timezone || serverTimeZone());
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Thứ trong tuần theo múi giờ: "thứ Hai" … "Chủ nhật". */
export function weekdayVi(at: Date, timezone?: string | null): string {
  return WEEKDAY_VI[wallClockOf(at, timezone || serverTimeZone()).weekday] ?? "";
}

/** "2 ngày 3 giờ 15 phút" — khoảng thời gian dễ đọc. */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 1) return "dưới 1 phút";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d ? `${d} ngày` : "", h ? `${h} giờ` : "", m ? `${m} phút` : ""].filter(Boolean).join(" ");
}

/** Mô tả lịch bằng tiếng Việt cho người dùng/AI đọc. */
export function describeSchedule(schedule: string, timezone?: string | null): string {
  const s = schedule.trim().normalize("NFC");
  const rel = relative(s);
  if (rel?.kind === "every") return `lặp lại mỗi ${rel.n} ${UNIT_VI[rel.unit]}`;
  const at = AT_RE.exec(s);
  if (at) {
    try {
      return `một lần lúc ${formatInZone(parseAt(at[1]!, timezone), timezone)}`;
    } catch {
      return s;
    }
  }
  return describeCron(s) ?? `theo lịch cron "${s}"`;
}

/** Các mẫu cron hay gặp → câu tiếng Việt; mẫu khác trả null. */
function describeCron(expr: string): string | null {
  const f = expr.split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const step = /^\*\/(\d+)$/;
  const allRest = (...xs: string[]) => xs.every((x) => x === "*");
  const miStep = step.exec(mi);
  if (miStep && allRest(h, dom, mon, dow)) return `mỗi ${miStep[1]} phút`;
  if (!/^\d{1,2}$/.test(mi)) return null;
  if (allRest(h, dom, mon, dow)) return `phút thứ ${Number(mi)} của mỗi giờ`;
  const hStep = step.exec(h);
  if (hStep && allRest(dom, mon, dow)) return `mỗi ${hStep[1]} giờ (vào phút ${Number(mi)})`;
  if (!/^\d{1,2}$/.test(h) || mon !== "*") return null;
  const time = `${pad(Number(h))}:${pad(Number(mi))}`;
  if (dom === "*" && dow === "*") return `${time} hằng ngày`;
  if (dom === "*") {
    if (dow === "1-5") return `${time} từ thứ Hai đến thứ Sáu`;
    if (dow === "1-6") return `${time} từ thứ Hai đến thứ Bảy`;
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const names = dow.split(",").map((d) => WEEKDAY_VI[Number(d) % 7]!);
      return names.length === 1 ? `${time} mỗi ${names[0]}` : `${time} các ngày ${names.join(", ")}`;
    }
    return null;
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom)) return `${time} ngày ${Number(dom)} hằng tháng`;
  return null;
}
