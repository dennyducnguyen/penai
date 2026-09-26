import { Cron } from "croner";

/**
 * Tính lần chạy kế tiếp cho một lịch. Hỗ trợ 3 dạng:
 * - "every 30s" | "every 5m" | "every 2h" | "every 1d" — lặp theo chu kỳ
 * - "at 2026-07-10T09:00:00" — chạy 1 lần tại thời điểm (ISO, giờ local)
 * - cron expression 5-6 trường: "0 9 * * *"
 *
 * @param from mốc thời gian tham chiếu (ms). Truyền vào để test được (Date.now cấm trong workflow).
 * @returns thời điểm kế tiếp (Date) hoặc null nếu không còn (one-shot đã qua).
 */
export function nextRun(schedule: string, from: Date): Date | null {
  const s = schedule.trim();

  const every = /^every\s+(\d+)\s*(s|m|h|d)$/i.exec(s);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.toLowerCase();
    const ms = n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "s"]!;
    return new Date(from.getTime() + ms);
  }

  const at = /^at\s+(.+)$/i.exec(s);
  if (at) {
    const t = new Date(at[1]!.trim());
    if (Number.isNaN(t.getTime())) throw new Error(`Thời điểm không hợp lệ: ${at[1]}`);
    return t.getTime() > from.getTime() ? t : null;
  }

  // Cron expression
  try {
    const c = new Cron(s);
    return c.nextRun(from) ?? null;
  } catch (err) {
    throw new Error(`Lịch không hợp lệ "${s}": ${(err as Error).message}`);
  }
}

/** Kiểm tra một chuỗi lịch có hợp lệ không (dùng khi tạo cron job). */
export function validateSchedule(schedule: string): void {
  nextRun(schedule, new Date(0));
}
