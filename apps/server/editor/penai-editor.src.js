/**
 * TRÌNH SOẠN MARKDOWN TÁCH ĐÔI (Thư viện file — lấy từ bản Helix 28/10/2026).
 * Nguồn của apps/server/static/vendor/penai-editor.js; đóng gói lại bằng `node scripts/build-editor-vendor.mjs`.
 *
 * Trái: CodeMirror 6 (số dòng, gập mục, tìm kiếm, Ctrl+S). Phải: markdown-it (bảng, danh sách việc, liên kết) + Mermaid
 * (nạp chậm từ /static/vendor/mermaid.min.js khi gặp khối ```mermaid đầu tiên). Không cho HTML thô trong Markdown.
 * Cuộn song song và bấm nhảy hai chiều theo SỐ DÒNG (mỗi khối bản xem mang data-line), không theo tỉ lệ phần trăm.
 *
 *   const ed = PenaiEditor.mount(el, { value, readOnly, onChange(v), onSave() });
 *   ed.getValue(); ed.setValue(v); ed.setReadOnly(b); ed.goToLine(n); ed.destroy();
 *   PenaiEditor.render(markdown) → HTML (cùng bộ dựng, dùng cho chỗ chỉ xem)
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from "@codemirror/language";
import MarkdownIt from "markdown-it";
import { normalizeAnchors, lineToOffset, offsetToLine, lineInBlock, prepareMarkdownSource } from "../src/md-linemap.ts";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------- markdown-it ----------------
const mdi = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
const BLOCK_WITH_MAP = new Set(["paragraph_open", "heading_open", "bullet_list_open", "ordered_list_open", "list_item_open", "blockquote_open",
  "table_open", "tr_open", "hr", "code_block", "html_block"]);
mdi.core.ruler.push("hx_data_line", (state) => {
  for (const t of state.tokens) {
    if (!t.map || !BLOCK_WITH_MAP.has(t.type)) continue;
    t.attrSet("data-line", String(t.map[0]));
    t.attrSet("data-line-end", String(t.map[1]));
  }
});
// Danh sách việc: "- [ ] việc" / "- [x] việc"
mdi.core.ruler.after("inline", "hx_tasks", (state) => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const first = t.children && t.children[0];
    if (!first || first.type !== "text") continue;
    const m = first.content.match(/^\[([ xX])\]\s+/);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = '<input type="checkbox" disabled' + (m[1] !== " " ? " checked" : "") + "> ";
    t.children.unshift(box);
    toks[i - 2].attrJoin("class", "hx-task");
  }
});
const defaultFence = mdi.renderer.rules.fence;
mdi.renderer.rules.fence = (tokens, idx, opts, env, slf) => {
  const t = tokens[idx];
  const lang = (t.info || "").trim().split(/\s+/)[0];
  const dl = t.map ? ` data-line="${t.map[0]}" data-line-end="${t.map[1]}"` : "";
  if (lang === "mermaid") return `<div class="hx-mermaid"${dl} data-code="${esc(t.content)}"><pre class="hx-mermaid-src">${esc(t.content)}</pre></div>`;
  if (lang === "tham-so" || lang === "frontmatter") {
    return `<details class="hx-params"${dl}><summary>${lang === "tham-so" ? "Tham số máy đọc (tham-so)" : "Frontmatter"}</summary><pre><code>${esc(t.content)}</code></pre></details>`;
  }
  return `<div class="hx-fence"${dl}>${defaultFence(tokens, idx, opts, env, slf)}</div>`;
};
const defaultLinkOpen = mdi.renderer.rules.link_open || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts));
mdi.renderer.rules.link_open = (tokens, idx, opts, env, slf) => {
  const href = tokens[idx].attrGet("href") || "";
  if (!href.startsWith("#")) { tokens[idx].attrSet("target", "_blank"); tokens[idx].attrSet("rel", "noopener noreferrer"); }
  return defaultLinkOpen(tokens, idx, opts, env, slf);
};

export function render(src) { return mdi.render(prepareMarkdownSource(String(src == null ? "" : src))); }

// ---------------- Mermaid (nạp chậm) ----------------
let mermaidP = null;
let mermaidSeq = 0;
const svgCache = new Map();
const isDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
function loadMermaid() {
  if (!mermaidP) {
    mermaidP = new Promise((ok, fail) => {
      const init = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" }); ok(window.mermaid); };
      if (window.mermaid) return init();
      const s = document.createElement("script");
      s.src = "/static/vendor/mermaid.min.js";
      s.onload = init;
      s.onerror = () => { mermaidP = null; fail(new Error("Không tải được thư viện vẽ sơ đồ (Mermaid)")); };
      document.head.appendChild(s);
    });
  }
  return mermaidP;
}
export async function renderMermaid(root) {
  const blocks = root.querySelectorAll(".hx-mermaid");
  if (!blocks.length) return false;
  let m;
  try { m = await loadMermaid(); } catch (e) { blocks.forEach((b) => b.insertAdjacentHTML("afterbegin", `<div class="hx-mermaid-err">${esc(e.message)}</div>`)); return false; }
  for (const b of blocks) {
    if (!b.isConnected) continue;
    const code = b.getAttribute("data-code") || "";
    if (svgCache.has(code)) { b.innerHTML = svgCache.get(code); continue; }
    try {
      const { svg } = await m.render("hxm" + ++mermaidSeq, code);
      svgCache.set(code, svg);
      if (svgCache.size > 200) svgCache.delete(svgCache.keys().next().value);
      b.innerHTML = svg;
    } catch (e) {
      b.innerHTML = `<div class="hx-mermaid-err">Lỗi sơ đồ: ${esc((e && e.message) || e)}</div><pre>${esc(code)}</pre>`;
      document.querySelectorAll("body > [id^='dhxm'], body > [id^='hxm']").forEach((n) => n.remove()); // mermaid để lại nút lỗi
    }
  }
  return true;
}

// ---------------- CSS ----------------
let cssDone = false;
function injectCss() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement("style");
  s.textContent = [
    ".hx-ed{display:flex;flex-direction:column;height:100%;min-height:0}",
    ".hx-tabs{display:none;gap:6px;margin-bottom:6px}",
    ".hx-tabs button.on{background:var(--accent,#046a38);color:#fff;border-color:var(--accent,#046a38)}",
    ".hx-panes{flex:1;display:flex;min-height:0;border:1px solid var(--border,#8883);border-radius:10px;overflow:hidden}",
    ".hx-code,.hx-view{flex:1 1 50%;min-width:0;min-height:0}",
    ".hx-code{border-right:1px solid var(--border,#8883);display:flex}",
    ".hx-code .cm-editor{flex:1;height:100%}",
    ".hx-view{overflow:auto;padding:14px 20px 40vh;line-height:1.55}",
    ".hx-view [data-line]{border-radius:4px;transition:background-color .25s}",
    ".hx-view .hx-hl{background:rgba(10,138,74,.12);box-shadow:-6px 0 0 rgba(10,138,74,.12),6px 0 0 rgba(10,138,74,.12)}",
    ".hx-view table{border-collapse:collapse;margin:8px 0}.hx-view th,.hx-view td{border:1px solid var(--border,#8883);padding:4px 8px;text-align:left;vertical-align:top}",
    ".hx-view pre{background:rgba(127,127,127,.1);padding:8px 10px;border-radius:6px;overflow:auto;font-size:.82rem}",
    ".hx-view code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}",
    ".hx-view blockquote{margin:6px 0;padding:2px 12px;border-left:4px solid var(--border,#8883);opacity:.85}",
    ".hx-view img{max-width:100%}.hx-view li.hx-task{list-style:none;margin-left:-1.2em}",
    ".hx-view .hx-mermaid{margin:10px 0;text-align:center;overflow:auto}.hx-view .hx-mermaid svg{max-width:100%;height:auto}",
    ".hx-view .hx-mermaid-src{text-align:left;opacity:.6}.hx-mermaid-err{color:#c0392b;font-size:.85rem;text-align:left;margin-bottom:4px}",
    ".hx-view details.hx-params{margin:8px 0;border:1px dashed var(--border,#8883);border-radius:6px;padding:4px 8px}",
    ".hx-view details.hx-params summary{cursor:pointer;font-size:.8rem;opacity:.75}",
    ".hx-view h1{font-size:1.45rem;margin:.2em 0 .5em}.hx-view h2{font-size:1.2rem;margin:1.1em 0 .4em}.hx-view h3{font-size:1.05rem;margin:1em 0 .3em}",
    ".hx-view h1,.hx-view h2{border-bottom:1px solid var(--border,#8883);padding-bottom:.2em}",
    "@media (max-width:800px){.hx-tabs{display:flex}.hx-ed[data-tab=code] .hx-view{display:none}.hx-ed[data-tab=view] .hx-code{display:none}.hx-code{border-right:0}}",
  ].join("");
  document.head.appendChild(s);
}

const cmTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "inherit" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.55" },
  ".cm-content": { paddingBottom: "40vh" },
  ".cm-gutters": { backgroundColor: "transparent", color: "rgba(127,127,127,.75)", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(10,138,74,.08)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(10,138,74,.14)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "currentColor" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(10,138,74,.25) !important" },
});

// ---------------- mount ----------------
export function mount(host, opts = {}) {
  injectCss();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "hx-ed";
  root.setAttribute("data-tab", "code");
  root.innerHTML = '<div class="hx-tabs"><button type="button" class="ghost sm on" data-tab="code">&lt;/&gt; Mã</button><button type="button" class="ghost sm" data-tab="view">👁 Xem</button></div>' +
    '<div class="hx-panes"><div class="hx-code"></div><div class="hx-view md-rule"></div></div>';
  host.appendChild(root);
  const codeEl = root.querySelector(".hx-code");
  const viewEl = root.querySelector(".hx-view");
  root.querySelectorAll(".hx-tabs button").forEach((b) => {
    b.onclick = () => {
      root.setAttribute("data-tab", b.getAttribute("data-tab"));
      root.querySelectorAll(".hx-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      anchors = null;
      if (b.getAttribute("data-tab") === "view") syncViewFromCode(); else view.requestMeasure();
    };
  });

  const ro = new Compartment();
  let anchors = null;
  let lock = null, lockTimer = 0;
  let renderTimer = 0;
  let destroyed = false;
  let renderedFor = null;
  let fromViewClick = false;
  const lockFor = (side) => { lock = side; clearTimeout(lockTimer); lockTimer = setTimeout(() => { lock = null; }, 150); };

  const saveKey = keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { if (opts.onSave) opts.onSave(); return true; } }]);
  const view = new EditorView({
    parent: codeEl,
    state: EditorState.create({
      doc: String(opts.value || ""),
      extensions: [
        lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), history(), highlightSelectionMatches(),
        markdown(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), EditorView.lineWrapping, cmTheme,
        saveKey, keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
        cmPlaceholder(opts.placeholder || ""),
        ro.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            clearTimeout(renderTimer);
            renderTimer = setTimeout(renderView, 150);
            if (opts.onChange) opts.onChange(u.state.doc.toString());
          }
          if (u.selectionSet && !u.docChanged && !fromViewClick && u.transactions.some((t) => t.isUserEvent("select"))) highlightForCursor(true);
          else if (u.docChanged) highlightForCursor(false);
        }),
      ],
    }),
  });

  const docLines = () => view.state.doc.lines;
  const padTop = () => (view.documentPadding ? view.documentPadding.top : 0);
  function getAnchors() {
    if (anchors) return anchors;
    const base = viewEl.getBoundingClientRect().top - viewEl.scrollTop;
    const raw = [{ line: 0, top: 0 }];
    viewEl.querySelectorAll("[data-line]").forEach((el) => {
      if (!el.offsetParent && el.getClientRects().length === 0) return;
      raw.push({ line: Number(el.getAttribute("data-line")), top: el.getBoundingClientRect().top - base });
    });
    raw.push({ line: docLines(), top: Math.max(0, viewEl.scrollHeight - viewEl.clientHeight * 0.6) });
    anchors = normalizeAnchors(raw);
    return anchors;
  }
  function codeTopLine() {
    const st = view.scrollDOM.scrollTop - padTop();
    const blk = view.lineBlockAtHeight(Math.max(0, st));
    const ln = view.state.doc.lineAt(blk.from).number - 1;
    const frac = blk.height ? Math.min(1, Math.max(0, (st - blk.top) / blk.height)) : 0;
    return ln + frac;
  }
  function atBottom(el) { return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; }
  function syncViewFromCode() {
    if (root.getAttribute("data-tab") === "code" && getComputedStyle(viewEl).display === "none") return;
    lockFor("code");
    if (view.scrollDOM.scrollTop <= 1) { viewEl.scrollTop = 0; return; }
    viewEl.scrollTop = lineToOffset(getAnchors(), codeTopLine());
  }
  function syncCodeFromView() {
    lockFor("view");
    if (viewEl.scrollTop <= 1) { view.scrollDOM.scrollTop = 0; return; }
    const L = offsetToLine(getAnchors(), viewEl.scrollTop);
    const n = Math.min(docLines(), Math.max(1, Math.floor(L) + 1));
    const blk = view.lineBlockAt(view.state.doc.line(n).from);
    view.scrollDOM.scrollTop = blk.top + (L - Math.floor(L)) * blk.height + padTop();
  }
  view.scrollDOM.addEventListener("scroll", () => { if (lock !== "view") syncViewFromCode(); }, { passive: true });
  viewEl.addEventListener("scroll", () => { if (lock !== "code") syncCodeFromView(); }, { passive: true });
  viewEl.addEventListener("load", () => { anchors = null; }, true);
  const resizeObs = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { anchors = null; }) : null;
  if (resizeObs) resizeObs.observe(viewEl);

  // Bấm bên xem → con trỏ bên mã nhảy đúng dòng (theo tỉ lệ trong khối)
  viewEl.addEventListener("click", (e) => {
    if (e.target.closest("a,summary,input")) return;
    const el = e.target.closest("[data-line]");
    if (!el) return;
    const s = Number(el.getAttribute("data-line"));
    const en = Number(el.getAttribute("data-line-end") || s + 1);
    const r = el.getBoundingClientRect();
    goToLine(lineInBlock(s, en, e.clientY - r.top, r.height), "view");
    markActive(el);
  });

  function markActive(el) {
    viewEl.querySelectorAll(".hx-hl").forEach((x) => x.classList.remove("hx-hl"));
    if (el) el.classList.add("hx-hl");
  }
  /** Con trỏ bên mã đổi dòng → tô khối tương ứng bên xem (và cuộn tới nếu đang khuất). */
  function highlightForCursor(scroll) {
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    let best = null, bestStart = -1;
    viewEl.querySelectorAll("[data-line]").forEach((el) => {
      const s = Number(el.getAttribute("data-line")), en = Number(el.getAttribute("data-line-end") || s + 1);
      if (s <= line && line < en && s >= bestStart) { best = el; bestStart = s; }
    });
    markActive(best);
    if (scroll && best && getComputedStyle(viewEl).display !== "none") {
      const vr = viewEl.getBoundingClientRect(), br = best.getBoundingClientRect();
      if (br.top < vr.top || br.bottom > vr.bottom) { lockFor("code"); viewEl.scrollTop += br.top - vr.top - vr.height / 3; }
    }
  }

  function goToLine(n, from) {
    const line = view.state.doc.line(Math.min(docLines(), Math.max(1, n + 1)));
    if (from === "view") { lockFor("view"); fromViewClick = true; }
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }), userEvent: "select.pointer" });
    fromViewClick = false;
    if (root.getAttribute("data-tab") === "view" && window.matchMedia("(max-width:800px)").matches) return;
    view.focus();
  }

  async function renderView() {
    if (destroyed) return;
    const src = view.state.doc.toString();
    if (src === renderedFor) return;
    renderedFor = src;
    const keep = viewEl.scrollTop;
    viewEl.innerHTML = render(src) || '<p style="opacity:.55"><i>(trống)</i></p>';
    viewEl.scrollTop = keep;
    anchors = null;
    highlightForCursor(false);
    if (await renderMermaid(viewEl)) { anchors = null; }
    if (lock !== "view") syncViewFromCode();
  }
  renderView();

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(v) {
      const cur = view.state.doc.toString();
      if (cur === v) return;
      view.dispatch({ changes: { from: 0, to: cur.length, insert: String(v || "") } });
    },
    setReadOnly(b) { view.dispatch({ effects: ro.reconfigure([EditorState.readOnly.of(!!b), EditorView.editable.of(!b)]) }); },
    goToLine: (n) => goToLine(n, "api"),
    focus: () => view.focus(),
    refresh: () => { renderedFor = null; renderView(); },
    destroy() { destroyed = true; clearTimeout(renderTimer); clearTimeout(lockTimer); if (resizeObs) resizeObs.disconnect(); view.destroy(); host.innerHTML = ""; },
  };
}

window.PenaiEditor = { mount, render, renderMermaid };
