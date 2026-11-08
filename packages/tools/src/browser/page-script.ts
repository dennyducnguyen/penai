/**
 * Script chạy TRONG trang (page.evaluate dạng chuỗi — gói tools không nạp kiểu DOM).
 * Đánh số các phần tử bấm/nhập được đang hiện (ưu tiên phần đang thấy trên màn
 * hình) bằng thuộc tính data-penai-ref="eN" để tool click/type tìm lại đúng phần tử.
 */

export interface SnapshotItem {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type: string;
  value: string;
  href: string;
  checked: boolean;
  disabled: boolean;
  inView: boolean;
}

export interface PageSnapshot {
  title: string;
  url: string;
  scrollY: number;
  scrollH: number;
  vh: number;
  total: number;
  items: SnapshotItem[];
  text: string;
}

export const REF_ATTR = "data-penai-ref";

export function snapshotScript(maxItems: number): string {
  return `(() => {
  var MAX = ${Math.max(10, Math.min(400, Math.floor(maxItems)))};
  var ATTR = "${REF_ATTR}";
  var REPEATED = {};
  ["tải về", "tải xuống", "download", "pdf", "xem", "xem thêm", "chi tiết", "view", "details", "mở", "open", "sửa", "edit",
   "xóa", "delete", "lược đồ", "mua", "mua ngay", "thêm vào giỏ", "add to cart"].forEach(function (k) { REPEATED[k] = 1; });
  Array.prototype.forEach.call(document.querySelectorAll("[" + ATTR + "]"), function (e) { e.removeAttribute(ATTR); });
  var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[role=switch],[role=textbox],' +
    '[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"]),[class*="cursor-pointer"]';
  var vh = window.innerHeight, vw = window.innerWidth;
  var inView = [], below = [];
  var nodes = document.querySelectorAll(SEL);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var st = window.getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    // Phần tử chỉ khớp nhờ class cursor-pointer (như tab div trên vbpl.vn): chỉ nhận
    // phần tử lá hoặc ngắn gọn để tránh lấy nhầm cả khối container lớn.
    var tagLow = el.tagName.toLowerCase();
    if (tagLow !== "a" && tagLow !== "button" && tagLow !== "input" && tagLow !== "select" && tagLow !== "textarea" &&
        tagLow !== "summary" && !el.getAttribute("role") && !el.getAttribute("onclick") && !el.getAttribute("tabindex") &&
        !el.isContentEditable) {
      var txt = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (el.children.length > 3 || !txt || txt.length > 320 || r.height > 120) continue;
    }
    var vis = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    (vis ? inView : below).push({ el: el, vis: vis });
  }
  var ordered = inView.concat(below);
  var out = [];
  for (var j = 0; j < ordered.length && out.length < MAX; j++) {
    var e = ordered[j].el;
    var tag = e.tagName.toLowerCase();
    var type = (e.getAttribute("type") || "").toLowerCase();
    var name = (e.getAttribute("aria-label") || "").trim();
    if (!name && (tag === "input" || tag === "textarea")) name = e.getAttribute("placeholder") || e.getAttribute("name") || "";
    if (!name && tag === "select") { var o = e.options && e.options[e.selectedIndex]; name = o ? o.text : (e.getAttribute("name") || ""); }
    if (!name) name = (e.innerText || e.textContent || "").trim();
    if (!name) { var img = e.querySelector("img[alt]"); if (img) name = img.getAttribute("alt") || ""; }
    if (!name) name = e.getAttribute("title") || "";
    // Nút chỉ có biểu tượng (SVG/icon font) hoặc nút "Tải xuống" trong danh sách file: lấy chữ của
    // dòng bao quanh làm nhãn ngữ cảnh (vd "Tải xuống: Nghị định 15-2026.docx")
    var isDl = /^(tải xuống|download)$/i.test(String(name).trim());
    if ((!name || isDl) && (tag === "button" || tag === "a" || e.getAttribute("role") === "button")) {
      var p = e.parentElement;
      for (var k = 0; k < 4 && p; k++, p = p.parentElement) {
        var pr = p.getBoundingClientRect();
        if (pr.height > 120) break;
        var pt = String(p.innerText || p.textContent || "").replace(/\\s+/g, " ").replace(/Tải xuống|Download/gi, "").trim();
        if (pt && pt.length <= 180) { name = (isDl ? name + ": " : "Nút biểu tượng — ") + pt; isDl = false; break; }
      }
    }
    // Nút hành động lặp lại trên từng thẻ/dòng ("Tải về", "PDF", "Xem", "Chi tiết"…): gắn kèm tiêu đề
    // của thẻ chứa nó, để mô hình phân biệt nút của mục nào (danh sách văn bản, sản phẩm, đơn hàng…)
    if (REPEATED[String(name).trim().toLowerCase()] && (tag === "button" || tag === "a" || e.getAttribute("role") === "button")) {
      var cp = e.parentElement;
      for (var ck = 0; ck < 5 && cp; ck++, cp = cp.parentElement) {
        if (cp.getBoundingClientRect().height > 600) break;
        var titleEl = cp.querySelector && cp.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="Title"], [class*="name" i]');
        if (titleEl && titleEl !== e && !titleEl.contains(e)) {
          var tt = String(titleEl.innerText || titleEl.textContent || "").replace(/\\s+/g, " ").trim();
          if (tt && tt.length >= 3) { name = name + " — " + tt.slice(0, 110); break; }
        }
      }
    }
    name = String(name).replace(/\\s+/g, " ").trim().slice(0, 140);
    var ref = "e" + (out.length + 1);
    e.setAttribute(ATTR, ref);
    var val = "";
    if (tag === "input" || tag === "textarea" || tag === "select") val = type === "password" ? (e.value ? "***" : "") : String(e.value || "").slice(0, 80);
    out.push({
      ref: ref, tag: tag, role: e.getAttribute("role") || "", name: name, type: type, value: val,
      href: tag === "a" ? (e.getAttribute("href") || "") : "",
      checked: e.checked === true, disabled: e.disabled === true, inView: ordered[j].vis
    });
  }
  return {
    title: document.title || "", url: location.href, scrollY: Math.round(window.scrollY),
    scrollH: Math.round(document.documentElement.scrollHeight), vh: vh,
    total: ordered.length, items: out, text: document.body ? document.body.innerText || "" : ""
  };
})()`;
}

/** Trang xác minh chống robot (CAPTCHA, "verify you are human", chặn truy cập). */
export function looksLikeChallenge(s: Pick<PageSnapshot, "url" | "title" | "text">): boolean {
  let path = "";
  try {
    path = new URL(s.url).pathname + new URL(s.url).search;
  } catch {
    path = s.url;
  }
  if (/captcha|\/verify\/|challenge|cdn-cgi\/challenge|px-captcha|\/sorry\//i.test(path)) return true;
  const head = `${s.title}
${s.text.slice(0, 1500)}`;
  return /captcha|verify (you are|to continue)|are you a robot|not a robot|trượt để hoàn thành|xác minh (để tiếp tục|bạn là người)|kiểm tra bảo mật|unusual traffic/i.test(head);
}

/** Nhãn loại phần tử cho người/AI đọc. */
function kindOf(it: SnapshotItem): string {
  if (it.tag === "a") return "link";
  if (it.tag === "select") return "danh sách chọn";
  if (it.tag === "textarea") return "ô nhập nhiều dòng";
  if (it.tag === "input") {
    if (it.type === "checkbox") return "ô tick";
    if (it.type === "radio") return "lựa chọn";
    if (it.type === "submit" || it.type === "button") return "nút";
    return `ô nhập${it.type && it.type !== "text" ? ` (${it.type})` : ""}`;
  }
  if (it.tag === "button" || it.role === "button") return "nút";
  if (it.role) return it.role;
  return it.tag;
}

function shortHref(href: string, pageUrl: string): string {
  if (!href || href.startsWith("javascript:") || href === "#") return "";
  try {
    const u = new URL(href, pageUrl);
    const base = new URL(pageUrl);
    const s = u.host === base.host ? u.pathname + u.search : u.href;
    return s.length > 280 ? s.slice(0, 277) + "…" : s;
  } catch {
    return "";
  }
}

/**
 * Văn bản mô tả trang cho agent: tiêu đề, vị trí cuộn, phần tử tương tác (ref),
 * nội dung chữ (cửa sổ textOffset..textOffset+textChars).
 */
export function formatSnapshot(
  s: PageSnapshot,
  opts: { maxItems: number; textChars: number; textOffset?: number; notes?: string[] },
): string {
  const lines: string[] = [];
  for (const n of opts.notes ?? []) lines.push(`⚠️ ${n}`);
  if (looksLikeChallenge(s)) {
    lines.push(
      "⚠️ Đây có vẻ là trang xác minh chống robot (CAPTCHA / kiểm tra truy cập). KHÔNG tự giải — dừng thao tác, " +
        "báo người dùng: trang web đang chặn truy cập tự động (thử lại sau, hoặc quản trị viên cập nhật cookie mới trong Dashboard → Trình duyệt).",
    );
  }
  lines.push(`Trang: ${s.title || "(không có tiêu đề)"}`);
  lines.push(`URL: ${s.url.length > 160 ? s.url.slice(0, 157) + "…" : s.url}`);
  const bottom = Math.min(s.scrollH, s.scrollY + s.vh);
  const pct = s.scrollH > 0 ? Math.round((bottom / s.scrollH) * 100) : 100;
  lines.push(`Đang xem: ${s.scrollY}–${bottom}px / cao ${s.scrollH}px (${pct}% trang)`);
  const items = s.items.slice(0, opts.maxItems);
  if (opts.maxItems > 0) {
  lines.push("");
  lines.push(
    `--- Phần tử bấm/nhập được (${items.length}/${s.total}; ★ = đang thấy trên màn hình; dùng ref cho click/type/select) ---`,
  );
  }
  for (const it of items) {
    const href = it.tag === "a" ? shortHref(it.href, s.url) : "";
    lines.push(
      `[${it.ref}]${it.inView ? "★" : ""} ${kindOf(it)} "${it.name}"` +
        (it.value ? ` = "${it.value}"` : "") +
        (it.checked ? " (đã chọn)" : "") +
        (it.disabled ? " (bị khóa)" : "") +
        (href ? ` → ${href}` : ""),
    );
  }
  if (!items.length && opts.maxItems > 0) lines.push("(không thấy phần tử nào)");
  const clean = s.text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const off = Math.max(0, Math.min(opts.textOffset ?? 0, clean.length));
  const chunk = clean.slice(off, off + opts.textChars);
  lines.push("");
  lines.push(
    `--- Nội dung chữ (ký tự ${off}–${off + chunk.length} / ${clean.length}` +
      (off + chunk.length < clean.length ? `; đọc tiếp: action "text" offset ${off + chunk.length}` : "") +
      ") ---",
  );
  lines.push(chunk || "(trang không có chữ)");
  return lines.join("\n");
}
