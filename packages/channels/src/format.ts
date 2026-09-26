/**
 * Chuyển Markdown do LLM viết sang HTML mà Telegram hiểu, và chia tin dài
 * thành nhiều phần ≤ 4096 ký tự.
 *
 * Telegram chỉ nhận một số thẻ: <b> <i> <s> <u> <code> <pre> <a> <blockquote>,
 * không có bảng, tiêu đề hay danh sách → tiêu đề thành chữ đậm, danh sách thành
 * dấu •, bảng thành khối <pre> căn cột.
 *
 * Cách làm: tách khối code (```) ra trước, phần còn lại dựng theo từng dòng;
 * trong mỗi dòng tách `code nội dòng` ra rồi mới áp định dạng chữ — nên dấu *
 * hay _ nằm trong code không bao giờ bị hiểu nhầm thành in đậm/nghiêng.
 */

const TELEGRAM_MAX = 4096;

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ---------------------------------------------------------------------------
// Định dạng trong một dòng

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s")]+)\)/g;

/** Áp định dạng chữ lên đoạn đã escape (không chứa code nội dòng). */
function styleText(escaped: string): string {
  return escaped
    .replace(LINK, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
}

/** Một dòng markdown → HTML: đoạn `code` giữ nguyên chữ, phần còn lại được định dạng. */
function renderInline(line: string): string {
  let html = "";
  let rest = line;
  for (;;) {
    const open = rest.indexOf("`");
    const close = open >= 0 ? rest.indexOf("`", open + 1) : -1;
    if (open < 0 || close < 0 || close === open + 1) {
      return html + styleText(escapeHtml(rest));
    }
    html += styleText(escapeHtml(rest.slice(0, open)));
    html += "<code>" + escapeHtml(rest.slice(open + 1, close)) + "</code>";
    rest = rest.slice(close + 1);
  }
}

// ---------------------------------------------------------------------------
// Bảng → <pre> căn cột

/** Ký tự chiếm 2 ô khi hiển thị bằng font đơn cách (chữ Hán/Hàn/Nhật, emoji). */
const WIDE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}　-〿！-｠]/u;

function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isDividerRow = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));

function renderTable(lines: string[]): string {
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
    .filter((cells) => !isDividerRow(cells));
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.max(...rows.map((r) => cellWidth(r[col] ?? ""))),
  );
  const text = rows
    .map((r) =>
      widths
        .map((w, col) => {
          const cell = r[col] ?? "";
          return cell + " ".repeat(Math.max(0, w - cellWidth(cell)));
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  return "<pre>" + escapeHtml(text) + "</pre>";
}

// ---------------------------------------------------------------------------
// Dựng cả văn bản

/** Tách văn bản thành các đoạn thường và khối code ```…```. */
function splitFences(md: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const fence = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
  let from = 0;
  for (const m of md.matchAll(fence)) {
    const at = m.index ?? 0;
    if (at > from) parts.push({ code: false, text: md.slice(from, at) });
    parts.push({ code: true, text: (m[1] ?? "").replace(/\n$/, "") });
    from = at + m[0].length;
  }
  if (from < md.length) parts.push({ code: false, text: md.slice(from) });
  return parts;
}

function renderLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    if (isTableLine(line)) {
      let end = i;
      while (end < lines.length && isTableLine(lines[end] ?? "")) end++;
      const block = lines.slice(i, end);
      out.push(...(block.length >= 2 ? [renderTable(block)] : block.map(renderInline)));
      i = end;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (heading) out.push("<b>" + renderInline(heading[1] ?? "") + "</b>");
    else if (quote) out.push("<blockquote>" + renderInline(quote[1] ?? "") + "</blockquote>");
    else if (bullet) out.push((bullet[1] ?? "") + "• " + renderInline(bullet[2] ?? ""));
    else out.push(renderInline(line));
    i++;
  }
  return out.join("\n");
}

/** Markdown của LLM → HTML Telegram. */
export function markdownToTelegramHtml(md: string): string {
  return splitFences(md)
    .map((part) => (part.code ? "<pre><code>" + escapeHtml(part.text) + "</code></pre>" : renderLines(part.text)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Chia tin dài

const PRE_OPEN = "<pre><code>";
const PRE_CLOSE = "</code></pre>";

/** Chỗ cắt đẹp nhất trong `s` không vượt `limit`: đoạn trống > xuống dòng > dấu cách. */
function bestCut(s: string, limit: number): number {
  for (const sep of ["\n\n", "\n", " "]) {
    const at = s.lastIndexOf(sep, limit);
    if (at >= limit * 0.3) return at;
  }
  return limit;
}

/**
 * Chia HTML thành các phần ≤ max ký tự. Khối <pre> được giữ nguyên nếu vừa một
 * phần; khối quá dài thì cắt thành nhiều khối, mỗi khối tự mở/đóng thẻ.
 */
export function chunkHtml(html: string, max = TELEGRAM_MAX): string[] {
  if (html.length <= max) return [html];

  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };
  const addText = (text: string) => {
    let rest = text;
    while (current.length + rest.length > max) {
      const cut = bestCut(rest, max - current.length);
      current += rest.slice(0, cut);
      push();
      rest = rest.slice(cut).trimStart();
    }
    current += rest;
  };
  const addPre = (block: string) => {
    if (current.length + block.length <= max) {
      current += block;
      return;
    }
    push();
    if (block.length <= max) {
      current = block;
      return;
    }
    const inner = block.replace(/^<pre>(<code>)?/, "").replace(/(<\/code>)?<\/pre>$/, "");
    const room = max - PRE_OPEN.length - PRE_CLOSE.length;
    for (let at = 0; at < inner.length; at += room) {
      chunks.push(PRE_OPEN + inner.slice(at, at + room) + PRE_CLOSE);
    }
  };

  const pre = /<pre>[\s\S]*?<\/pre>/g;
  let from = 0;
  for (const m of html.matchAll(pre)) {
    const at = m.index ?? 0;
    if (at > from) addText(html.slice(from, at));
    addPre(m[0]);
    from = at + m[0].length;
  }
  if (from < html.length) addText(html.slice(from));
  push();
  return chunks.length > 0 ? chunks : [html.slice(0, max)];
}

/** Bỏ định dạng markdown thành chữ trơn (dự phòng khi Telegram từ chối HTML). */
export function stripToPlain(md: string): string {
  return splitFences(md)
    .map((part) =>
      part.code
        ? part.text
        : part.text
            .replace(/`([^`\n]+)`/g, "$1")
            .replace(/\*\*([^*\n]+)\*\*/g, "$1")
            .replace(/\*([^*\n]+)\*/g, "$1")
            .replace(/~~([^~\n]+)~~/g, "$1")
            .replace(LINK, "$1 ($2)")
            .replace(/^#{1,6}\s+/gm, ""),
    )
    .join("");
}
