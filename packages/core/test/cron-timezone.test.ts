import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatDuration,
  formatInZone,
  localDateKey,
  minIntervalMs,
  nextRun,
  normalizeSchedule,
  weekdayVi,
} from "../src/cron.js";

const VN = "Asia/Ho_Chi_Minh";
// 15:29:16 Chủ nhật 27/09/2026 giờ Việt Nam
const now = new Date("2026-09-27T08:29:16Z");

describe("lịch theo múi giờ (không phụ thuộc giờ máy chủ)", () => {
  it('"at" không ghi múi giờ → hiểu theo múi giờ của job', () => {
    expect(nextRun("at 2026-09-28 08:00", now, VN)).toEqual(new Date("2026-09-28T01:00:00Z"));
    expect(nextRun("at 2026-09-28 08:00", now, "UTC")).toEqual(new Date("2026-09-28T08:00:00Z"));
  });

  it('"at" có múi giờ tường minh → giữ đúng thời điểm đó', () => {
    expect(nextRun("at 2026-09-28T08:00:00+07:00", now, "UTC")).toEqual(new Date("2026-09-28T01:00:00Z"));
    expect(nextRun("at 2026-12-31T23:59:00Z", now, VN)).toEqual(new Date("2026-12-31T23:59:00Z"));
  });

  it("cron theo múi giờ của job", () => {
    // 8:00 hằng ngày giờ VN = 01:00 UTC
    expect(nextRun("0 8 * * *", now, VN)).toEqual(new Date("2026-09-28T01:00:00Z"));
    expect(nextRun("0 8 * * *", now, "UTC")).toEqual(new Date("2026-09-28T08:00:00Z"));
    // 17:30 thứ Hai–thứ Sáu: hôm nay Chủ nhật → thứ Hai 28/09
    expect(nextRun("30 17 * * 1-5", now, VN)).toEqual(new Date("2026-09-28T10:30:00Z"));
  });

  it("every không phụ thuộc múi giờ; one-shot đã qua → null", () => {
    expect(nextRun("every 2h", now, VN)!.getTime()).toBe(now.getTime() + 7_200_000);
    expect(nextRun("at 2026-09-27 15:00", now, VN)).toBeNull();
  });

  it('"in ..." không được lưu thẳng', () => {
    expect(() => nextRun("in 30m", now, VN)).toThrow(/normalizeSchedule/);
  });
});

describe("normalizeSchedule", () => {
  it('"in 30m" → thời điểm cụ thể theo giờ địa phương', () => {
    expect(normalizeSchedule("in 30m", now, VN)).toBe("at 2026-09-27 15:59:16");
    expect(normalizeSchedule("in 2 giờ", now, VN)).toBe("at 2026-09-27 17:29:16");
    expect(normalizeSchedule("in 1d", now, VN)).toBe("at 2026-09-28 15:29:16");
  });

  it("nhiều cách viết thời điểm", () => {
    expect(normalizeSchedule("at 28/09/2026 8h30", now, VN)).toBe("at 2026-09-28 08:30");
    expect(normalizeSchedule("at 2026-09-28T08:00", now, VN)).toBe("at 2026-09-28 08:00");
    expect(normalizeSchedule("at 2026-9-28 7:05", now, VN)).toBe("at 2026-09-28 07:05");
    expect(normalizeSchedule("at 2026-09-28T01:00:00Z", now, VN)).toBe("at 2026-09-28 08:00");
  });

  it("every + cron", () => {
    expect(normalizeSchedule("every 2 giờ", now, VN)).toBe("every 2h");
    expect(normalizeSchedule("every 15 minutes", now, VN)).toBe("every 15m");
    expect(normalizeSchedule("  0   8 * * 1-5 ", now, VN)).toBe("0 8 * * 1-5");
  });

  it("báo lỗi dễ hiểu", () => {
    expect(() => normalizeSchedule("at 2026-09-28", now, VN)).toThrow(/Thiếu giờ/);
    expect(() => normalizeSchedule("at 30/02/2026 08:00", now, VN)).toThrow(/Không có thời điểm/);
    expect(() => normalizeSchedule("at 2026-09-28 25:00", now, VN)).toThrow(/không hợp lệ/);
    expect(() => normalizeSchedule("every 0m", now, VN)).toThrow(/lớn hơn 0/);
    expect(() => normalizeSchedule("mai 8h", now, VN)).toThrow(/Lịch không hợp lệ/);
    expect(() => normalizeSchedule("99 99 * * *", now, VN)).toThrow(/Lịch không hợp lệ/);
  });
});

describe("minIntervalMs", () => {
  it("chu kỳ ngắn nhất", () => {
    expect(minIntervalMs("every 5m", now, VN)).toBe(300_000);
    expect(minIntervalMs("*/2 * * * *", now, VN)).toBe(120_000);
    expect(minIntervalMs("0 8 * * *", now, VN)).toBe(86_400_000);
    expect(minIntervalMs("at 2026-09-28 08:00", now, VN)).toBe(Infinity);
  });
});

describe("hiển thị", () => {
  it("formatInZone / localDateKey / formatDuration", () => {
    expect(formatInZone(new Date("2026-09-28T01:00:00Z"), VN)).toBe("08:00 thứ Hai 28/09/2026");
    expect(formatInZone(now, VN)).toBe("15:29 Chủ nhật 27/09/2026");
    // 23:30 UTC ngày 27 = 06:30 sáng 28 ở Việt Nam
    expect(localDateKey(new Date("2026-09-27T23:30:00Z"), VN)).toBe("2026-09-28");
    expect(localDateKey(new Date("2026-09-27T23:30:00Z"), "UTC")).toBe("2026-09-27");
    expect(weekdayVi(new Date("2026-09-27T23:30:00Z"), VN)).toBe("thứ Hai");
    expect(weekdayVi(now, VN)).toBe("Chủ nhật");
    expect(formatDuration(16 * 3_600_000 + 31 * 60_000)).toBe("16 giờ 31 phút");
    expect(formatDuration(26 * 3_600_000)).toBe("1 ngày 2 giờ");
    expect(formatDuration(20_000)).toBe("dưới 1 phút");
  });

  it("describeSchedule", () => {
    expect(describeSchedule("at 2026-09-28 08:00", VN)).toBe("một lần lúc 08:00 thứ Hai 28/09/2026");
    expect(describeSchedule("every 2h", VN)).toBe("lặp lại mỗi 2 giờ");
    expect(describeSchedule("0 8 * * *", VN)).toBe("08:00 hằng ngày");
    expect(describeSchedule("30 17 * * 1-5", VN)).toBe("17:30 từ thứ Hai đến thứ Sáu");
    expect(describeSchedule("0 9 * * 1", VN)).toBe("09:00 mỗi thứ Hai");
    expect(describeSchedule("0 9 * * 0,3", VN)).toBe("09:00 các ngày Chủ nhật, thứ Tư");
    expect(describeSchedule("0 9 1 * *", VN)).toBe("09:00 ngày 1 hằng tháng");
    expect(describeSchedule("*/15 * * * *", VN)).toBe("mỗi 15 phút");
    expect(describeSchedule("0 9 1 1 *", VN)).toBe('theo lịch cron "0 9 1 1 *"');
  });
});
