/**
 * Ánh xạ dòng mã Markdown ↔ vị trí trên bản xem (trình soạn tách đôi của Thư viện, 28/10/2026).
 * Hàm thuần, không đụng DOM: được đóng gói vào apps/server/static/vendor/penai-editor.js (esbuild) và test bằng vitest.
 *
 * Bản xem gắn `data-line` (dòng nguồn bắt đầu, đếm từ 0) cho mọi khối. Mỗi khối là một "mốc" {line, top}; giữa hai mốc
 * nội suy tuyến tính → cuộn song song mượt cả với đoạn văn dài, bảng, sơ đồ.
 */
export interface LineAnchor { line: number; top: number }

/** Sắp theo dòng, mỗi dòng giữ mốc đầu tiên, bỏ mốc làm vị trí đi lùi (phần tử ẩn trong <details> đóng có top = 0). */
export function normalizeAnchors(raw: LineAnchor[]): LineAnchor[] {
  const sorted = raw
    .filter((a) => Number.isFinite(a.line) && Number.isFinite(a.top))
    .slice()
    .sort((a, b) => a.line - b.line || a.top - b.top);
  const out: LineAnchor[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && last.line === a.line) continue;
    if (last && a.top < last.top) continue;
    out.push({ line: a.line, top: a.top });
  }
  return out;
}

/** Dòng (có phần lẻ) → vị trí cuộn trên bản xem. */
export function lineToOffset(anchors: LineAnchor[], line: number): number {
  if (!anchors.length) return 0;
  let i = 0;
  for (let k = 0; k < anchors.length; k++) if (anchors[k]!.line <= line) i = k; else break;
  const a = anchors[i]!;
  const b = anchors[i + 1];
  if (!b || line <= a.line) return a.top;
  return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top);
}

/** Vị trí cuộn trên bản xem → dòng (có phần lẻ). */
export function offsetToLine(anchors: LineAnchor[], top: number): number {
  if (!anchors.length) return 0;
  let i = 0;
  for (let k = 0; k < anchors.length; k++) if (anchors[k]!.top <= top) i = k; else break;
  const a = anchors[i]!;
  let j = i + 1;
  while (j < anchors.length && anchors[j]!.top <= a.top) j++;
  const b = anchors[j];
  if (!b || top <= a.top) return a.line;
  return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line);
}

/**
 * Dòng chính xác bên trong một khối khi bấm vào bản xem: khối [start, end) cao `height`, bấm cách đỉnh `dy`
 * → dòng tương ứng theo tỉ lệ (đoạn văn 10 dòng mã bấm giữa khối → dòng thứ 5).
 */
export function lineInBlock(start: number, end: number, dy: number, height: number): number {
  const span = Math.max(1, end - start);
  if (!(height > 0)) return start;
  const frac = Math.min(0.999, Math.max(0, dy / height));
  return start + Math.floor(frac * span);
}

/**
 * Frontmatter `---…---` ở đầu tệp (skill, prompt) → khối rào ```frontmatter để bản xem hiện gọn mà GIỮ ĐÚNG số dòng
 * (mốc data-line vẫn khớp dòng trong ô mã).
 */
export function prepareMarkdownSource(src: string): string {
  const text = src.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return text;
  const lines = text.split("\n");
  for (let i = 1; i < Math.min(lines.length, 60); i++) {
    if (lines[i] === "---") {
      lines[0] = "```frontmatter";
      lines[i] = "```";
      return lines.join("\n");
    }
  }
  return text;
}
