/**
 * Mức suy luận (reasoning.effort) hợp lệ thay đổi theo từng model ChatGPT:
 * họ gpt-5.x nhận minimal/low/medium/high, họ gpt-6 bỏ "minimal" và thêm
 * none/xhigh/max (26/09/2026: agent để Thinking=minimal với gpt-6-luna nhận
 * 400 "Unsupported value: 'minimal' is not supported with the 'gpt-6-luna'
 * model"). Không ghi cứng theo tên model — đọc danh sách mức được phép ngay
 * trong thông báo lỗi 400 rồi nhớ lại theo model.
 */

/** Thứ tự từ ít suy luận nhất tới nhiều nhất. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Lỗi 400 của Codex có phải do reasoning.effort không hợp lệ không; nếu có,
 * trả danh sách mức model chấp nhận (đúng thứ tự trong thông báo).
 */
export function parseSupportedEfforts(errorText: string): string[] | null {
  if (!errorText.includes("reasoning.effort")) return null;
  const tail = /Supported values are:?([^"\n]*)/i.exec(errorText)?.[1];
  if (!tail) return null;
  const levels = [...tail.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  return levels.length ? levels : null;
}

/**
 * Chọn mức hợp lệ gần nhất: ưu tiên mức thấp nhất mà KHÔNG ít suy luận hơn
 * mức người dùng chọn (minimal → low, không xuống none); model không có mức
 * nào cao hơn thì lấy mức cao nhất nó có.
 */
export function pickSupportedEffort(requested: string, supported: string[]): string {
  if (!supported.length || supported.includes(requested)) return requested;
  const rank = (e: string) => {
    const i = EFFORT_ORDER.indexOf(e);
    return i < 0 ? EFFORT_ORDER.length : i;
  };
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  const want = rank(requested);
  return sorted.find((e) => rank(e) >= want) ?? sorted[sorted.length - 1]!;
}
