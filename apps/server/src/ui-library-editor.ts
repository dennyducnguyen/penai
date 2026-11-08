/**
 * Thư viện file — trình soạn Markdown tách đôi (xem + sửa), lịch sử sửa, xem trước
 * PDF/Word/Excel, tải lên cả thư mục. Lấy từ bản Helix (28/10/2026), viết lại cho
 * thư viện theo từng agent của PenAI.
 *
 * JavaScript thuần ghép vào IIFE của ui.ts (dùng el, $, esc, api, toast, fmtSize).
 * Viết bằng String.raw: KHÔNG dùng dấu backtick và chuỗi "$" + "{" trong khối này.
 */
export const LIBRARY_EDITOR_UI = String.raw`
  // ===================== Thư viện: trình soạn + lịch sử + xem trước =====================
  (function libEdStyles() {
    var css = [
      "dialog.lib-ed{width:min(1500px,97vw);height:92vh;max-height:92vh;padding:0;display:flex;flex-direction:column;overflow:hidden}",
      "dialog.lib-ed[open]{display:flex}",
      ".lib-ed .hd{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}",
      ".lib-ed .hd h3{margin:0;font-size:.98rem;flex:1;min-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".lib-ed .st{font-size:.78rem;opacity:.7}",
      ".lib-ed .bd{flex:1;min-height:0;position:relative}",
      ".lib-ed .ft{font-size:.74rem;opacity:.6;padding:6px 14px;border-top:1px solid var(--border)}",
      ".lib-ed textarea.fallback{width:100%;height:100%;border:0;border-radius:0;font-family:ui-monospace,monospace;font-size:.84rem;resize:none}",
      ".lib-cmp{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:55vh}",
      ".lib-cmp pre{white-space:pre-wrap;word-break:break-word;font-size:.76rem;background:rgba(128,128,128,.1);border-radius:8px;padding:8px;overflow:auto;max-height:55vh;margin:0}",
      ".lib-pv{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:rgba(128,128,128,.08);border-radius:8px;padding:10px;max-height:70vh;overflow:auto;margin:0}"
    ].join("\n");
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  })();

  var LIB_EDITABLE = ["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "log", "xml", "html", "htm", "css", "js", "ts", "py", "sql", "sh", "ini", "toml"];
  var LIB_DOC_PREVIEW = ["docx", "xlsx", "xls", "pptx"];
  function libExt(name) { var i = String(name).lastIndexOf("."); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ""; }
  function libIsEditable(name) { return LIB_EDITABLE.indexOf(libExt(name)) >= 0; }
  function libQ(p) { return encodeURIComponent(p); }

  var penaiEditorP = null;
  function loadPenaiEditor() {
    if (window.PenaiEditor) return Promise.resolve(window.PenaiEditor);
    if (!penaiEditorP) penaiEditorP = new Promise(function (ok, fail) {
      var sc = document.createElement("script"); sc.src = "/static/vendor/penai-editor.js";
      sc.onload = function () { window.PenaiEditor ? ok(window.PenaiEditor) : fail(new Error("Trình soạn không nạp được")); };
      sc.onerror = function () { penaiEditorP = null; fail(new Error("Không tải được trình soạn")); };
      document.head.appendChild(sc);
    });
    return penaiEditorP;
  }

  /**
   * Hộp soạn gần toàn màn hình. o: { title, value, readOnly, isMarkdown, note, onSave(value, ctx) → Promise }.
   * Markdown dùng trình soạn tách đôi (trái mã, phải bản xem, cuộn song song); file khác dùng ô chữ thường.
   */
  function libEditorDialog(o) {
    var d = el("dialog", { "class": "lib-ed" });
    d.innerHTML = '<div class="hd"><h3></h3><span class="st"></span><span class="btns" style="display:flex;gap:6px"></span><button class="ghost sm" data-x>✕ Đóng</button></div>' +
      '<div class="bd"><div class="muted" style="padding:20px">Đang nạp…</div></div>' +
      '<div class="ft"></div>';
    d.querySelector("h3").textContent = o.title;
    d.querySelector(".ft").innerHTML = o.note || "";
    document.body.appendChild(d); d.showModal();
    var ctx = { dlg: d, value: o.value, dirty: false, ed: null };
    ctx.status = function (h) { d.querySelector(".st").innerHTML = h || ""; };
    ctx.get = function () { return ctx.ed ? ctx.ed.getValue() : (ctx.ta ? ctx.ta.value : ctx.value); };
    ctx.set = function (v) { if (ctx.ed) ctx.ed.setValue(v); else if (ctx.ta) ctx.ta.value = v; ctx.value = v; ctx.dirty = false; ctx.status(""); };
    function close() {
      if (ctx.dirty && !confirm("Có thay đổi chưa lưu — đóng và bỏ thay đổi?")) return;
      if (ctx.ed) { try { ctx.ed.destroy(); } catch (e) {} }
      d.close(); d.remove();
    }
    ctx.close = close;
    d.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    d.querySelector("[data-x]").onclick = close;
    var save = null;
    if (!o.readOnly && o.onSave) {
      save = el("button", { "class": "sm", title: "Ctrl+S" }, "💾 Lưu");
      save.onclick = function () { doSave(); };
      d.querySelector(".btns").appendChild(save);
    }
    function doSave() {
      if (!save || save.disabled) return;
      save.disabled = true; ctx.status("Đang lưu…");
      Promise.resolve(o.onSave(ctx.get(), ctx)).then(function (r) {
        if (r !== false) { ctx.dirty = false; ctx.status('<span class="ok">Đã lưu</span>'); }
      }).catch(function (e) { ctx.status('<span class="err">' + esc(e.message) + "</span>"); }).then(function () { save.disabled = false; });
    }
    var body = d.querySelector(".bd");
    function onChange() { if (!ctx.dirty) { ctx.dirty = true; ctx.status("● chưa lưu"); } }
    function fallback() {
      body.innerHTML = "";
      var ta = el("textarea", { "class": "fallback", spellcheck: "false" }); ta.value = o.value; ta.readOnly = !!o.readOnly;
      ta.addEventListener("input", onChange);
      ta.addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); doSave(); } });
      body.appendChild(ta); ctx.ta = ta; if (!o.readOnly) ta.focus();
    }
    if (o.isMarkdown) {
      loadPenaiEditor().then(function (P) {
        body.innerHTML = "";
        ctx.ed = P.mount(body, { value: o.value, readOnly: !!o.readOnly, onChange: onChange, onSave: doSave });
        if (!o.readOnly && ctx.ed.focus) ctx.ed.focus();
      }).catch(function (e) { toast(e.message + " — dùng ô sửa thường", 1); fallback(); });
    } else fallback();
    return ctx;
  }

  /** Mở file văn bản trong thư viện để xem/sửa. readonly: thư mục do hệ thống quản lý. */
  function libOpenText(scopeId, rel, name, readonly, onSaved) {
    api("/v1/library/" + encodeURIComponent(scopeId) + "/text?path=" + libQ(rel)).then(function (j) {
      var base = j.sha256;
      var ro = readonly || j.readonly;
      var ctx = libEditorDialog({
        title: (ro ? "👁 " : "✏️ ") + rel,
        value: j.content,
        readOnly: ro,
        isMarkdown: /^(md|markdown)$/.test(libExt(name)),
        note: ro ? "Chỉ xem." : "Lưu: Ctrl+S hoặc nút 💾. Bản trước khi sửa vào thùng rác (🕘 Lịch sử của file) — khôi phục được trong 30 ngày. Agent đọc ngay bản mới.",
        onSave: function (value, c) { return put(value, base, c); }
      });
      function put(value, sha, c) {
        return fetch("/v1/library/" + encodeURIComponent(scopeId) + "/text", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: rel, content: value, baseSha256: sha }) })
          .then(function (r) { return r.json().then(function (x) { return { r: r, x: x }; }); })
          .then(function (res) {
            if (res.r.status === 409 && res.x.conflict) return conflict(value, res.x, c);
            if (!res.r.ok) throw new Error(res.x.error || ("HTTP " + res.r.status));
            base = res.x.sha256;
            if (onSaved) onSaved(res.x);
            return true;
          });
      }
      function conflict(mine, srv, c) {
        var d = el("dialog", { style: "width:min(1100px,95vw);padding:16px" });
        d.innerHTML = "<h3 style='margin:0 0 6px'>⚠️ File vừa được sửa ở nơi khác</h3><div class='muted' style='font-size:.82rem;margin-bottom:8px'>Agent hoặc người khác đã lưu bản mới trong lúc bạn sửa. Chọn giữ bản nào (bản bị thay vẫn vào thùng rác, khôi phục được).</div>" +
          "<div class='lib-cmp'><div><b style='font-size:.82rem'>Bản trên máy chủ (mới hơn)</b><pre class='a'></pre></div><div><b style='font-size:.82rem'>Bản của bạn</b><pre class='b'></pre></div></div>" +
          "<div class='dialog-actions'><button class='ghost' data-k='srv'>Dùng bản trên máy chủ</button><button data-k='mine'>Ghi bản của tôi lên</button></div>";
        d.querySelector(".a").textContent = srv.content == null ? "(quá lớn để hiện)" : srv.content;
        d.querySelector(".b").textContent = mine;
        document.body.appendChild(d); d.showModal();
        return new Promise(function (ok) {
          d.querySelector("[data-k=srv]").onclick = function () { d.close(); d.remove(); base = srv.sha256; if (srv.content != null) c.set(srv.content); c.status("Đã nạp bản trên máy chủ"); ok(false); };
          d.querySelector("[data-k=mine]").onclick = function () { d.close(); d.remove(); ok(put(mine, srv.sha256, c)); };
          d.addEventListener("cancel", function (e) { e.preventDefault(); d.close(); d.remove(); ok(false); });
        });
      }
      return ctx;
    }).catch(function (e) { toast(e.message, 1); });
  }

  /** Tạo file Markdown mới trong thư mục đang mở. */
  function libNewMarkdown(scopeId, dirRel, onDone) {
    var n = prompt("Tên file Markdown mới (tự chuyển thành không dấu, đuôi .md):", "ghi-chu.md");
    if (!n || !n.trim()) return;
    n = n.trim(); if (!/\.(md|markdown)$/i.test(n)) n += ".md";
    var path = (dirRel ? dirRel + "/" : "") + n;
    api("/v1/library/" + encodeURIComponent(scopeId) + "/text", { method: "PUT", body: { path: path, content: "# " + n.replace(/\.(md|markdown)$/i, "") + "\n\n", create: true } })
      .then(function (r) { if (onDone) onDone(); libOpenText(scopeId, r.path, r.path.split("/").pop(), false, onDone); })
      .catch(function (e) { toast(e.message, 1); });
  }

  /** Lịch sử một file: các bản cũ (bị sửa / ghi đè / xóa) trong thùng rác. */
  function libHistory(scopeId, rel, name, readonly, onRestored) {
    api("/v1/library/" + encodeURIComponent(scopeId) + "/history?path=" + libQ(rel)).then(function (j) {
      var d = el("dialog", { style: "width:min(760px,95vw);padding:16px" });
      d.innerHTML = "<h3 style='margin:0 0 4px'>🕘 Lịch sử: " + esc(rel) + "</h3><div class='muted' style='font-size:.8rem;margin-bottom:8px'>Bản cũ giữ " + j.keepDays + " ngày trong thùng rác rồi tự xóa.</div><div class='lst'></div><div class='dialog-actions'><button class='ghost' data-x>Đóng</button></div>";
      document.body.appendChild(d); d.showModal();
      d.querySelector("[data-x]").onclick = function () { d.close(); d.remove(); };
      var box = d.querySelector(".lst");
      if (!j.items.length) { box.innerHTML = "<div class='muted' style='padding:14px'>Chưa có bản cũ nào (file chưa từng bị sửa trên web, ghi đè hay xóa trong 30 ngày qua).</div>"; return; }
      j.items.slice().reverse().forEach(function (it) {
        var row = el("div", { "class": "row", style: "border-bottom:1px solid var(--border);padding:6px 0;justify-content:space-between" });
        row.innerHTML = "<span style='font-size:.84rem'>" + esc(String(it.deletedAt).slice(0, 16).replace("T", " ")) + " · " + esc(it.reason || "") + " · " + fmtSize(it.size) + "</span>";
        var acts = el("span", { style: "display:flex;gap:6px" });
        if (libIsEditable(name)) {
          var v = el("button", { "class": "ghost sm" }, "👁 Xem");
          v.onclick = function () {
            api("/v1/library/" + encodeURIComponent(scopeId) + "/trash/" + it.id + "/text").then(function (x) {
              libEditorDialog({ title: "🕘 " + rel + " — bản lúc " + String(it.deletedAt).slice(0, 16).replace("T", " "), value: x.content, readOnly: true, isMarkdown: /^(md|markdown)$/.test(libExt(name)), note: "Bản cũ — chỉ xem." });
            }).catch(function (e) { toast(e.message, 1); });
          };
          acts.appendChild(v);
          if (!readonly) {
            var rs = el("button", { "class": "ghost sm" }, "↩ Dùng lại bản này");
            rs.onclick = function () {
              if (!confirm("Thay nội dung hiện tại bằng bản này? (bản hiện tại vào thùng rác, khôi phục được)")) return;
              Promise.all([
                api("/v1/library/" + encodeURIComponent(scopeId) + "/trash/" + it.id + "/text"),
                api("/v1/library/" + encodeURIComponent(scopeId) + "/text?path=" + libQ(rel)).catch(function () { return null; })
              ]).then(function (r) {
                return api("/v1/library/" + encodeURIComponent(scopeId) + "/text", { method: "PUT", body: { path: rel, content: r[0].content, baseSha256: r[1] ? r[1].sha256 : null, create: !r[1] } });
              }).then(function () { toast("Đã dùng lại bản cũ"); d.close(); d.remove(); if (onRestored) onRestored(); }).catch(function (e) { toast(e.message, 1); });
            };
            acts.appendChild(rs);
          }
        }
        row.appendChild(acts); box.appendChild(row);
      });
    }).catch(function (e) { toast(e.message, 1); });
  }

  /** Xem trước Word / Excel / PowerPoint: trích chữ (không cần tải về). */
  function libDocPreview(scopeId, rel, downloadUrl) {
    var d = el("dialog", { style: "width:min(980px,95vw);padding:16px" });
    d.innerHTML = "<div class='row' style='justify-content:space-between;margin-bottom:8px'><b>" + esc(rel) + "</b><span style='display:flex;gap:6px'><a class='ghost sm' style='padding:4px 9px;border:1px solid var(--border);border-radius:8px;text-decoration:none;color:inherit;font-size:.82rem' href='" + downloadUrl + "'>⬇ Tải về</a><button class='ghost sm' data-x>Đóng</button></span></div>" +
      "<div class='muted' style='font-size:.78rem;margin-bottom:6px'>Nội dung chữ trích từ file (định dạng, hình ảnh không hiện) — đúng phần agent đọc được bằng read_document.</div><pre class='lib-pv'>Đang đọc…</pre>";
    document.body.appendChild(d); d.showModal();
    d.querySelector("[data-x]").onclick = function () { d.close(); d.remove(); };
    api("/v1/library/" + encodeURIComponent(scopeId) + "/preview?path=" + libQ(rel)).then(function (r) {
      d.querySelector(".lib-pv").textContent = (r.text || "(không có chữ)") + (r.truncated ? "\n\n… (đã cắt, tổng " + r.totalChars + " ký tự)" : "");
    }).catch(function (e) { d.querySelector(".lib-pv").textContent = "❌ " + e.message; });
  }

  /** Kéo-thả: lấy cả file trong thư mục con (giữ đường dẫn tương đối). */
  function libCollectDrop(dt) {
    var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (!entries.length) return Promise.resolve(Array.prototype.map.call((dt && dt.files) || [], function (f) { return { file: f, rel: f.name }; }));
    var out = [];
    function walk(entry, prefix) {
      return new Promise(function (ok) {
        if (entry.isFile) { entry.file(function (f) { out.push({ file: f, rel: prefix + f.name }); ok(); }, function () { ok(); }); return; }
        if (!entry.isDirectory) { ok(); return; }
        var reader = entry.createReader(), all = [];
        (function readMore() {
          reader.readEntries(function (batch) {
            if (!batch.length) { Promise.all(all.map(function (c) { return walk(c, prefix + entry.name + "/"); })).then(function () { ok(); }); }
            else { all = all.concat(Array.prototype.slice.call(batch)); readMore(); }
          }, function () { ok(); });
        })();
      });
    }
    return Promise.all(entries.map(function (e) { return walk(e, ""); })).then(function () { return out; });
  }
`;
