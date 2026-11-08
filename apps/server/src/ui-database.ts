/**
 * Dashboard → 🗃️ Dữ liệu: CSDL riêng của workspace (bảng PostgreSQL thật dùng chung
 * với quy trình, agent, API, MCP). Xem/sửa dòng, tạo bảng (tay hoặc từ dữ liệu mẫu),
 * cấu trúc + "Dùng bởi", ô SQL, lịch sử thay đổi, bản chụp + khôi phục, CSV.
 *
 * JavaScript thuần, ghép vào bên trong IIFE của ui.ts (dùng chung el, $, esc, api,
 * page, card, table, toast, modal, fmtTime, state, wfDlg…).
 * Viết bằng String.raw: KHÔNG dùng dấu backtick và chuỗi "$" + "{" trong khối này.
 */
export const DATABASE_UI = String.raw`
  // ===================== 🗃️ Dữ liệu =====================
  (function dbStyles() {
    var css = [
      ".db-grid{display:grid;grid-template-columns:240px minmax(0,1fr);gap:14px;align-items:start}",
      "@media(max-width:900px){.db-grid{grid-template-columns:1fr}}",
      ".db-tlist a{display:flex;justify-content:space-between;gap:6px;padding:6px 9px;border-radius:8px;text-decoration:none;color:inherit;font-size:.86rem;cursor:pointer}",
      ".db-tlist a:hover{background:rgba(128,128,128,.12)}.db-tlist a.active{background:var(--accent);color:#fff}",
      ".db-tlist a .muted{font-size:.72rem;white-space:nowrap}.db-tlist a.active .muted{color:#fff;opacity:.85}",
      ".db-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}.db-tabs button{font-size:.82rem;padding:4px 10px}",
      ".db-tabs button.on{background:var(--accent);color:#fff;border-color:var(--accent)}",
      ".db-wrap{overflow:auto;max-height:62vh;border:1px solid var(--border);border-radius:8px}",
      ".db-wrap table{margin:0;font-size:.8rem}.db-wrap th{position:sticky;top:0;background:var(--card);z-index:1;cursor:pointer;white-space:nowrap}",
      ".db-wrap td{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:.76rem}",
      ".db-wrap td.ed:hover{outline:1px dashed var(--accent2);cursor:text}",
      ".db-wrap td input{width:100%;font-size:.78rem;padding:2px 4px}",
      ".db-null{opacity:.4;font-style:italic}",
      ".db-cols{display:grid;grid-template-columns:1.3fr 1fr auto auto auto 1fr auto;gap:4px 6px;align-items:center;font-size:.82rem}",
      ".db-cols .h{font-size:.7rem;opacity:.6;text-transform:uppercase}",
      ".db-sql{width:100%;font-family:ui-monospace,monospace;font-size:.82rem;min-height:120px}",
      ".db-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}",
      ".db-quota{height:6px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden;margin-top:4px}.db-quota div{height:100%;background:var(--accent)}"
    ].join("\n");
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  })();

  var DB_TYPES = [["text", "Chữ"], ["integer", "Số nguyên"], ["number", "Số thập phân"], ["money", "Tiền (số)"], ["date", "Ngày"], ["datetime", "Ngày giờ"], ["boolean", "Đúng/sai"], ["json", "JSON"]];
  function dbCanWrite() { return !!(state.me && (state.me.role === "ws_admin" || state.me.role === "operator")); }
  function dbMb(n) { return (Number(n || 0) / 1048576).toFixed(n > 10485760 ? 0 : 2) + " MB"; }
  function dbCell(v) {
    if (v === null || v === undefined) return "<span class='db-null'>null</span>";
    if (typeof v === "object") return esc(JSON.stringify(v));
    return esc(String(v));
  }
  function dbGrid(fields, rows, opts) {
    opts = opts || {};
    var wrap = el("div", { "class": "db-wrap" });
    var t = el("table"); var th = el("thead"); var tr = el("tr");
    if (opts.actions) tr.appendChild(el("th", null, ""));
    fields.forEach(function (f) {
      var h = el("th", null, esc(f) + (opts.order === f ? " ▲" : opts.order === "-" + f ? " ▼" : ""));
      if (opts.onSort) h.onclick = function () { opts.onSort(f); };
      tr.appendChild(h);
    });
    th.appendChild(tr); t.appendChild(th);
    var tb = el("tbody");
    if (!rows.length) { var e = el("tr"); e.appendChild(el("td", { colspan: fields.length + 1 }, "<span class='muted'>(không có dòng nào)</span>")); tb.appendChild(e); }
    rows.forEach(function (r) {
      var row = el("tr");
      if (opts.actions) { var a = el("td", { style: "white-space:nowrap" }); opts.actions(r, a); row.appendChild(a); }
      fields.forEach(function (f) {
        var td = el("td", null, dbCell(r[f]));
        td.title = r[f] === null || r[f] === undefined ? "" : (typeof r[f] === "object" ? JSON.stringify(r[f]) : String(r[f]));
        if (opts.onEdit && opts.editable && opts.editable(f)) { td.className = "ed"; td.ondblclick = function () { opts.onEdit(r, f, td); }; }
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t); return wrap;
  }

  // ---------- hộp thoại tạo bảng (dùng chung: trang Dữ liệu + bước db của quy trình) ----------
  // opts: { sample?: dữ liệu mẫu (mảng/object), onDone(name, columns) }
  function dbCreateTableDialog(opts) {
    opts = opts || {};
    var d = wfDlg(860, "<h3 style='margin:0 0 4px'>＋ Bảng mới</h3><div class='muted' style='margin-bottom:8px;font-size:.82rem'>Tên bảng/cột: chữ thường không dấu, số, dấu _ (vd <code>don_hang</code>, <code>tong_tien</code>). Không chọn cột khóa thì tự có cột <code>id</code> tự tăng. Mọi bảng tự có <code>tao_luc</code>, <code>sua_luc</code>.</div>" +
      "<div class='row' style='gap:8px'><input id='tn' placeholder='ten_bang' style='flex:1'><input id='tc' placeholder='Ghi chú (bảng này lưu gì) — giúp AI hiểu' style='flex:2'></div>" +
      "<div id='tcols' style='margin-top:10px'></div><button class='ghost sm' id='tadd' style='margin-top:6px'>＋ Thêm cột</button>" +
      "<label style='display:flex;gap:6px;align-items:center;margin-top:10px;opacity:1'><input type='checkbox' id='tts' checked> Tự thêm cột tao_luc / sua_luc (thời điểm tạo, sửa)</label>" +
      "<pre class='wf-pre' id='tsql' style='display:none'></pre><div id='terr'></div>" +
      "<div class='dialog-actions'><button class='ghost' id='tsq'>Xem SQL</button><span style='flex:1'></span><button class='ghost' id='tx'>Hủy</button><button id='tok'>Tạo bảng</button></div>");
    var cols = [];
    function paint() {
      var box = $("#tcols", d); box.innerHTML = "";
      var g = el("div", { "class": "db-cols" });
      ["Tên cột", "Kiểu", "🔑 Khóa", "Duy nhất", "Bắt buộc", "Mặc định", ""].forEach(function (h) { g.appendChild(el("div", { "class": "h" }, h)); });
      cols.forEach(function (c, i) {
        var n = el("input", { value: c.name || "", placeholder: "ten_cot" }); n.oninput = function () { c.name = n.value.trim(); };
        if (c.source && c.source !== c.name) n.title = "từ trường " + c.source;
        var t = el("select"); DB_TYPES.forEach(function (x) { var o = el("option", { value: x[0] }, esc(x[1])); if (x[0] === c.type) o.selected = true; t.appendChild(o); });
        t.onchange = function () { c.type = t.value; };
        var mk = function (key) { var b = el("input", { type: "checkbox" }); b.checked = !!c[key]; b.onchange = function () { c[key] = b.checked; }; return b; };
        var dv = el("select"); [["", "(không)"], ["now", "lúc tạo dòng"], ["today", "hôm nay"], ["0", "0"], ["false", "sai"], ["true", "đúng"], ["__custom", "giá trị khác…"]].forEach(function (x) { var o = el("option", { value: x[0] }, esc(x[1])); if (String(c["default"] == null ? "" : c["default"]) === x[0]) o.selected = true; dv.appendChild(o); });
        if (c["default"] != null && c["default"] !== "" && ["now", "today", "0", "false", "true"].indexOf(String(c["default"])) < 0) { var oc = el("option", { value: String(c["default"]) }, esc(String(c["default"]))); oc.selected = true; dv.insertBefore(oc, dv.lastChild); }
        dv.onchange = function () { if (dv.value === "__custom") { var v = prompt("Giá trị mặc định:", ""); if (v === null) { dv.value = ""; c["default"] = ""; return; } c["default"] = v; paint(); } else c["default"] = dv.value; };
        var x = el("button", { "class": "ghost sm" }, "✕"); x.onclick = function () { cols.splice(i, 1); paint(); };
        [n, t, mk("primaryKey"), mk("unique"), mk("notNull"), dv, x].forEach(function (z) { g.appendChild(z); });
      });
      box.appendChild(g);
    }
    function spec() {
      return { name: $("#tn", d).value.trim(), comment: $("#tc", d).value.trim() || undefined, timestamps: $("#tts", d).checked,
        columns: cols.filter(function (c) { return c.name; }).map(function (c) { var o = { name: c.name, type: c.type || "text" }; if (c.primaryKey) o.primaryKey = true; if (c.unique) o.unique = true; if (c.notNull) o.notNull = true; if (c["default"] !== undefined && c["default"] !== "") o["default"] = c["default"]; if (c.comment) o.comment = c.comment; return o; }) };
    }
    $("#tadd", d).onclick = function () { cols.push({ name: "", type: "text" }); paint(); };
    $("#tx", d).onclick = d.closeNow;
    $("#tsq", d).onclick = function () {
      var s = spec(); s.preview = true;
      api("/v1/db/tables", { method: "POST", body: s }).then(function (r) { var p = $("#tsql", d); p.style.display = ""; p.textContent = r.sql; $("#terr", d).innerHTML = ""; })
        .catch(function (e) { $("#terr", d).innerHTML = "<div class='err'>" + esc(e.message) + "</div>"; });
    };
    $("#tok", d).onclick = function () {
      var s = spec();
      $("#tok", d).disabled = true;
      api("/v1/db/tables", { method: "POST", body: s }).then(function () {
        d.closeNow(); toast("Đã tạo bảng " + s.name);
        if (opts.onDone) opts.onDone(s.name, cols.filter(function (c) { return c.name; }));
      }).catch(function (e) { $("#tok", d).disabled = false; $("#terr", d).innerHTML = "<div class='err'>" + esc(e.message) + "</div>"; });
    };
    if (opts.sample !== undefined) {
      api("/v1/db/suggest-columns", { method: "POST", body: { sample: opts.sample } }).then(function (r) {
        cols = r.columns || []; if (!cols.length) cols = [{ name: "", type: "text" }];
        if (opts.name) $("#tn", d).value = opts.name;
        paint();
      }).catch(function () { cols = [{ name: "", type: "text" }]; paint(); });
    } else { cols = [{ name: "ten", type: "text", notNull: true }]; paint(); }
    if (opts.name) $("#tn", d).value = opts.name;
    setTimeout(function () { $("#tn", d).focus(); }, 30);
  }

  // ---------- trang Dữ liệu ----------
  PAGES.database = function () {
    var m = page("🗃️ Dữ liệu", "CSDL riêng của workspace — bảng PostgreSQL thật dùng chung cho quy trình (bước Cơ sở dữ liệu), agent khi chat (tool db_query), API /v1/db và AI bên ngoài qua MCP.");
    var D = { schema: null, sel: decodeURIComponent((location.hash.split("?")[0].split("/")[2] || "")), tab: "data", offset: 0, order: "", q: "", col: "" };
    var canWrite = dbCanWrite();
    var grid = el("div", { "class": "db-grid" }); m.appendChild(grid);
    var left = el("div", { "class": "card" }); var right = el("div", { "class": "card", style: "min-width:0" });
    grid.appendChild(left); grid.appendChild(right);

    function load(keepSel) {
      return api("/v1/db/schema").then(function (j) {
        D.schema = j;
        if (!keepSel || !j.tables.some(function (t) { return t.name === D.sel; })) D.sel = D.sel && j.tables.some(function (t) { return t.name === D.sel; }) ? D.sel : (j.tables[0] ? j.tables[0].name : "");
        renderLeft(); renderRight();
      }).catch(function (e) { left.innerHTML = "<span class='err'>" + esc(e.message) + "</span>"; right.innerHTML = ""; });
    }
    function tbl() { return D.schema && D.schema.tables.filter(function (t) { return t.name === D.sel; })[0]; }
    function go(name) { D.sel = name; D.offset = 0; D.order = ""; D.q = ""; D.col = ""; history.replaceState(null, "", "#/database/" + encodeURIComponent(name)); renderLeft(); renderRight(); }

    function renderLeft() {
      var s = D.schema; left.innerHTML = "";
      left.appendChild(el("h3", null, "Bảng (" + s.tables.length + ")"));
      var pct = Math.min(100, Math.round(100 * s.sizeBytes / Math.max(1, s.quotaBytes)));
      left.appendChild(el("div", { "class": "muted", style: "font-size:.76rem" }, "Dung lượng " + dbMb(s.sizeBytes) + " / " + dbMb(s.quotaBytes)));
      var q = el("div", { "class": "db-quota" }, "<div style='width:" + pct + "%'></div>"); left.appendChild(q);
      if (canWrite) { var b = el("button", { style: "width:100%;margin:10px 0 6px" }, "＋ Bảng mới"); b.onclick = function () { dbCreateTableDialog({ onDone: function (n) { load().then(function () { go(n); }); } }); }; left.appendChild(b); }
      var list = el("div", { "class": "db-tlist", style: "margin-top:6px" });
      s.tables.forEach(function (t) {
        var a = el("a", { "class": t.name === D.sel ? "active" : "" }, "<span>" + (t.kind === "table" ? "▦ " : "👁 ") + esc(t.name) + "</span><span class='muted'>" + t.rowsEstimate + "</span>");
        a.title = t.comment || ""; a.onclick = function () { go(t.name); }; list.appendChild(a);
      });
      if (!s.tables.length) list.appendChild(el("div", { "class": "muted", style: "font-size:.82rem;line-height:1.6" }, "Chưa có bảng nào.<br>Tạo bằng nút trên, hoặc nhờ agent: <i>“tạo bảng lưu đơn hàng gồm mã đơn, khách, tổng tiền”</i>."));
      left.appendChild(list);
      var tools = el("div", { style: "margin-top:12px;display:flex;flex-direction:column;gap:4px" });
      [["sql", "⌨ Chạy SQL"], ["audit", "🕘 Lịch sử thay đổi"], ["snap", "💾 Sao lưu & khôi phục"]].forEach(function (x) {
        var a = el("a", { "class": "ghost", style: "cursor:pointer;font-size:.84rem" }, esc(x[1])); a.onclick = function () { D.tab = x[0]; renderRight(); }; tools.appendChild(a);
      });
      left.appendChild(tools);
    }

    function renderRight() {
      right.innerHTML = "";
      var t = tbl();
      var tabs = el("div", { "class": "db-tabs" });
      var TABS = t ? [["data", "Dữ liệu"], ["struct", "Cấu trúc"], ["sql", "SQL"], ["audit", "Lịch sử"], ["snap", "Sao lưu"]] : [["sql", "SQL"], ["audit", "Lịch sử"], ["snap", "Sao lưu"]];
      if (!t && (D.tab === "data" || D.tab === "struct")) D.tab = "sql";
      TABS.forEach(function (x) { var b = el("button", { "class": "ghost" + (D.tab === x[0] ? " on" : "") }, esc(x[1])); b.onclick = function () { D.tab = x[0]; renderRight(); }; tabs.appendChild(b); });
      if (t) right.appendChild(el("h3", { style: "margin:0 0 2px" }, "▦ " + esc(t.name) + (t.kind !== "table" ? " <span class='pill'>" + esc(t.kind) + "</span>" : "")));
      if (t && t.comment) right.appendChild(el("div", { "class": "muted", style: "font-size:.82rem;margin-bottom:6px" }, esc(t.comment)));
      right.appendChild(tabs);
      var body = el("div"); right.appendChild(body);
      if (D.tab === "data") renderData(body, t);
      else if (D.tab === "struct") renderStruct(body, t);
      else if (D.tab === "sql") renderSql(body);
      else if (D.tab === "audit") renderAudit(body);
      else renderSnap(body);
    }

    function keyOf(t, r) {
      if (t.primaryKey && t.primaryKey.length) { var k = {}; t.primaryKey.forEach(function (c) { k[c] = r[c]; }); return { key: k }; }
      if (r._ctid) return { ctid: r._ctid };
      return null;
    }
    function renderData(box, t) {
      var bar = el("div", { "class": "db-bar" });
      var colSel = el("select", { style: "max-width:160px" }); t.columns.forEach(function (c) { var o = el("option", { value: c.name }, esc(c.name)); if (c.name === D.col) o.selected = true; colSel.appendChild(o); });
      var qi = el("input", { placeholder: "lọc: chứa…", style: "width:160px" }); qi.value = D.q;
      var bf = el("button", { "class": "ghost sm" }, "Lọc"); bf.onclick = function () { D.q = qi.value; D.col = colSel.value; D.offset = 0; renderRight(); };
      qi.onkeydown = function (e) { if (e.key === "Enter") bf.onclick(); };
      [colSel, qi, bf].forEach(function (x) { bar.appendChild(x); });
      if (canWrite && t.kind === "table") { var ba = el("button", { "class": "sm" }, "＋ Thêm dòng"); ba.onclick = function () { rowDialog(t, null); }; bar.appendChild(ba); }
      var ex = el("a", { "class": "ghost sm", href: "/v1/db/tables/" + encodeURIComponent(t.name) + "/export.csv", style: "padding:4px 8px;border:1px solid var(--border);border-radius:8px;text-decoration:none;font-size:.82rem" }, "⬇ CSV"); bar.appendChild(ex);
      if (canWrite && t.kind === "table") { var bi = el("button", { "class": "ghost sm" }, "⬆ Nhập CSV"); bi.onclick = function () { importDialog(t); }; bar.appendChild(bi); }
      var info = el("span", { "class": "muted", style: "font-size:.78rem;margin-left:auto" }); bar.appendChild(info);
      box.appendChild(bar);
      var gbox = el("div"); box.appendChild(gbox);
      var pager = el("div", { "class": "db-bar", style: "margin-top:8px" }); box.appendChild(pager);
      var qs = "?limit=50&offset=" + D.offset + (D.order ? "&order=" + encodeURIComponent(D.order) : "") + (D.q ? "&q=" + encodeURIComponent(D.q) + "&col=" + encodeURIComponent(D.col || t.columns[0].name) : "");
      gbox.innerHTML = "<span class='muted'>Đang tải…</span>";
      api("/v1/db/tables/" + encodeURIComponent(t.name) + "/rows" + qs).then(function (j) {
        gbox.innerHTML = "";
        var fields = t.columns.map(function (c) { return c.name; });
        var hasKey = (t.primaryKey && t.primaryKey.length) || (j.rows[0] && j.rows[0]._ctid);
        info.textContent = j.total + " dòng" + (canWrite && hasKey ? " · bấm đúp vào ô để sửa" : "");
        gbox.appendChild(dbGrid(fields, j.rows, {
          order: D.order,
          onSort: function (f) { D.order = D.order === f ? "-" + f : f; renderRight(); },
          editable: function (f) { return canWrite && hasKey && t.kind === "table"; },
          onEdit: function (r, f, td) { editCell(t, r, f, td); },
          actions: canWrite && hasKey && t.kind === "table" ? function (r, a) {
            var e = el("button", { "class": "ghost sm", title: "Sửa dòng" }, "✏️"); e.onclick = function () { rowDialog(t, r); };
            var x = el("button", { "class": "ghost sm", title: "Xóa dòng" }, "🗑");
            x.onclick = function () { if (!confirm("Xóa dòng này?")) return; api("/v1/db/tables/" + encodeURIComponent(t.name) + "/rows", { method: "DELETE", body: keyOf(t, r) }).then(function () { toast("Đã xóa"); renderRight(); }).catch(function (er) { toast(er.message, 1); }); };
            a.appendChild(e); a.appendChild(x);
          } : null
        }));
        var from = j.total ? D.offset + 1 : 0, to = Math.min(D.offset + 50, j.total);
        pager.appendChild(el("span", { "class": "muted", style: "font-size:.8rem" }, from + "–" + to + " / " + j.total));
        var pv = el("button", { "class": "ghost sm" }, "‹ Trước"); pv.disabled = D.offset <= 0; pv.onclick = function () { D.offset = Math.max(0, D.offset - 50); renderRight(); };
        var nx = el("button", { "class": "ghost sm" }, "Sau ›"); nx.disabled = D.offset + 50 >= j.total; nx.onclick = function () { D.offset += 50; renderRight(); };
        pager.appendChild(pv); pager.appendChild(nx);
      }).catch(function (e) { gbox.innerHTML = "<span class='err'>" + esc(e.message) + "</span>"; });
    }
    function parseInputValue(c, raw) {
      if (raw === "") return null;
      if (/json/.test(c.type)) { try { return JSON.parse(raw); } catch (e) { return raw; } }
      return raw;
    }
    function editCell(t, r, f, td) {
      var c = t.columns.filter(function (x) { return x.name === f; })[0]; if (!c) return;
      var old = r[f];
      var inp = el("input"); inp.value = old === null || old === undefined ? "" : (typeof old === "object" ? JSON.stringify(old) : String(old));
      td.innerHTML = ""; td.appendChild(inp); inp.focus(); inp.select();
      var done = false;
      function save() {
        if (done) return; done = true;
        var v = parseInputValue(c, inp.value);
        if (String(v) === String(old)) { td.innerHTML = dbCell(old); return; }
        var body = keyOf(t, r); body.values = {}; body.values[f] = v;
        api("/v1/db/tables/" + encodeURIComponent(t.name) + "/rows", { method: "PATCH", body: body }).then(function (j) { r[f] = j.row ? j.row[f] : v; td.innerHTML = dbCell(r[f]); toast("Đã lưu"); })
          .catch(function (e) { td.innerHTML = dbCell(old); toast(e.message, 1); });
      }
      inp.onkeydown = function (e) { if (e.key === "Enter") save(); if (e.key === "Escape") { done = true; td.innerHTML = dbCell(old); } };
      inp.onblur = save;
    }
    function rowDialog(t, r) {
      var d = wfDlg(620, "<h3 style='margin:0 0 8px'>" + (r ? "✏️ Sửa dòng" : "＋ Thêm dòng") + " — " + esc(t.name) + "</h3><div id='rf'></div><div id='re'></div><div class='dialog-actions'><button class='ghost' id='rc'>Hủy</button><button id='rk'>Lưu</button></div>");
      var box = $("#rf", d);
      var inputs = {};
      t.columns.forEach(function (c) {
        var auto = !r && (c.identity || c["default"] !== null);
        box.appendChild(el("label", null, esc(c.name) + " <span class='muted' style='font-size:.72rem'>" + esc(c.type) + (c.primaryKey ? " · khóa" : "") + (c.notNull ? " · bắt buộc" : "") + (auto ? " · bỏ trống = tự điền" : "") + (c.comment ? " — " + esc(c.comment) : "") + "</span>"));
        var inp = /json/.test(c.type) ? el("textarea", { rows: 2, "class": "code", style: "width:100%" }) : el("input", { style: "width:100%" });
        if (r) inp.value = r[c.name] === null || r[c.name] === undefined ? "" : (typeof r[c.name] === "object" ? JSON.stringify(r[c.name]) : String(r[c.name]));
        if (/^(date|timestamp)/.test(c.type) && !r) inp.placeholder = /^date/.test(c.type) ? "2026-11-08" : "2026-11-08 14:30";
        box.appendChild(inp); inputs[c.name] = { c: c, inp: inp, orig: inp.value };
      });
      $("#rc", d).onclick = d.closeNow;
      $("#rk", d).onclick = function () {
        var values = {};
        Object.keys(inputs).forEach(function (k) {
          var x = inputs[k];
          if (r) { if (x.inp.value !== x.orig) values[k] = parseInputValue(x.c, x.inp.value); }
          else if (x.inp.value !== "") values[k] = parseInputValue(x.c, x.inp.value);
        });
        if (!Object.keys(values).length) { d.closeNow(); return; }
        var p = r ? api("/v1/db/tables/" + encodeURIComponent(t.name) + "/rows", { method: "PATCH", body: Object.assign(keyOf(t, r), { values: values }) })
          : api("/v1/db/tables/" + encodeURIComponent(t.name) + "/rows", { method: "POST", body: { values: values } });
        p.then(function () { d.closeNow(); toast("Đã lưu"); load(true); }).catch(function (e) { $("#re", d).innerHTML = "<div class='err'>" + esc(e.message) + "</div>"; });
      };
    }
    function importDialog(t) {
      var d = wfDlg(640, "<h3 style='margin:0 0 6px'>⬆ Nhập CSV vào " + esc(t.name) + "</h3><div class='muted' style='font-size:.82rem'>Dòng đầu là tên cột (trùng tên cột của bảng: " + esc(t.columns.map(function (c) { return c.name; }).join(", ")) + "). Ô trống = null. Lỗi một dòng thì không dòng nào được thêm.</div>" +
        "<input type='file' id='if' accept='.csv,text/csv' style='margin:10px 0'><label style='display:flex;gap:6px;align-items:center;opacity:1'><input type='checkbox' id='ir'> Xóa toàn bộ dữ liệu cũ trước khi nhập</label><div id='ie'></div>" +
        "<div class='dialog-actions'><button class='ghost' id='ic'>Hủy</button><button id='ik'>Nhập</button></div>");
      $("#ic", d).onclick = d.closeNow;
      $("#ik", d).onclick = function () {
        var f = $("#if", d).files[0]; if (!f) { $("#ie", d).innerHTML = "<div class='err'>Chọn file CSV</div>"; return; }
        var replace = $("#ir", d).checked;
        if (replace && !confirm("Xóa TOÀN BỘ dữ liệu hiện có của bảng " + t.name + " rồi nhập file này?")) return;
        var rd = new FileReader();
        rd.onload = function () {
          $("#ik", d).disabled = true;
          api("/v1/db/tables/" + encodeURIComponent(t.name) + "/import", { method: "POST", body: { csv: String(rd.result || ""), replace: replace, confirm: replace } })
            .then(function (r) { d.closeNow(); toast("Đã nhập " + r.inserted + " dòng"); load(true); })
            .catch(function (e) { $("#ik", d).disabled = false; $("#ie", d).innerHTML = "<div class='err'>" + esc(e.message) + "</div>"; });
        };
        rd.readAsText(f);
      };
    }

    function renderStruct(box, t) {
      var u = (D.schema.usage || {})[t.name] || [];
      var ub = el("div", { style: "margin-bottom:10px;font-size:.84rem" });
      ub.innerHTML = "<b>Dùng bởi:</b> " + (u.length ? u.map(function (x) { return "<a href='#/workflows/" + esc(x.workflowId) + "'>⚙️ " + esc(x.name) + "</a> <span class='muted'>(" + (x.writes ? "ghi" : "") + (x.writes && x.reads ? ", " : "") + (x.reads ? "đọc" : "") + ")</span>"; }).join(" · ") : "<span class='muted'>chưa quy trình nào (agent/API vẫn có thể dùng)</span>");
      box.appendChild(ub);
      if (canWrite && t.kind === "table") {
        var row = el("div", { "class": "db-bar" });
        var bc = el("button", { "class": "ghost sm" }, "📝 Sửa ghi chú bảng"); bc.onclick = function () { var v = prompt("Ghi chú cho bảng " + t.name + " (giúp AI hiểu bảng lưu gì):", t.comment || ""); if (v === null) return; api("/v1/db/tables/" + encodeURIComponent(t.name), { method: "PATCH", body: { comment: v } }).then(function () { load(true); }).catch(function (e) { toast(e.message, 1); }); };
        var bn = el("button", { "class": "ghost sm" }, "✎ Đổi tên bảng"); bn.onclick = function () { var v = prompt("Tên mới (chữ thường không dấu, số, _). Quy trình đang dùng tên cũ sẽ lỗi:", t.name); if (!v || v === t.name) return; api("/v1/db/tables/" + encodeURIComponent(t.name), { method: "PATCH", body: { name: v } }).then(function () { D.sel = v; load(true); }).catch(function (e) { toast(e.message, 1); }); };
        var bd = el("button", { "class": "ghost sm", style: "color:#ef4444" }, "🗑 Xóa bảng");
        bd.onclick = function () {
          var v = prompt("Xóa HẲN bảng " + t.name + " và toàn bộ dữ liệu (khôi phục được từ bản chụp gần nhất ở tab Sao lưu). Gõ tên bảng để xác nhận:", "");
          if (v !== t.name) { if (v !== null) toast("Tên không khớp — chưa xóa", 1); return; }
          api("/v1/db/tables/" + encodeURIComponent(t.name) + "?confirm=1", { method: "DELETE" }).then(function () { toast("Đã xóa bảng"); D.sel = ""; load(); }).catch(function (e) { toast(e.message, 1); });
        };
        [bc, bn, bd].forEach(function (x) { row.appendChild(x); });
        box.appendChild(row);
      }
      box.appendChild(table(["Cột", "Kiểu", "Thuộc tính", "Mặc định", "Ghi chú", ""], t.columns, function (c) {
        var tr = el("tr");
        tr.innerHTML = "<td><code>" + esc(c.name) + "</code></td><td style='font-size:.8rem'>" + esc(c.type) + "</td><td style='font-size:.76rem'>" + [c.primaryKey ? "🔑 khóa" : "", c.unique ? "duy nhất" : "", c.identity ? "tự tăng" : "", c.notNull && !c.primaryKey ? "bắt buộc" : ""].filter(Boolean).join(", ") + "</td><td class='muted' style='font-size:.74rem'>" + esc(c.identity ? "" : (c["default"] || "")) + "</td><td style='font-size:.8rem'>" + esc(c.comment || "") + "</td>";
        var td = el("td", { style: "white-space:nowrap" });
        if (canWrite && t.kind === "table") {
          var e = el("button", { "class": "ghost sm", title: "Ghi chú / đổi tên" }, "✎");
          e.onclick = function () {
            var nm = prompt("Tên cột (đổi tên thì quy trình đang dùng tên cũ sẽ lỗi):", c.name); if (nm === null) return;
            var cm = prompt("Ghi chú cột (giúp AI hiểu):", c.comment || ""); if (cm === null) return;
            api("/v1/db/tables/" + encodeURIComponent(t.name) + "/columns/" + encodeURIComponent(c.name), { method: "PATCH", body: { name: nm.trim(), comment: cm } }).then(function () { load(true); }).catch(function (er) { toast(er.message, 1); });
          };
          var x = el("button", { "class": "ghost sm", title: "Xóa cột" }, "🗑");
          x.onclick = function () { if (!confirm("Xóa cột " + c.name + " cùng toàn bộ dữ liệu của cột? (khôi phục được từ bản chụp)")) return; api("/v1/db/tables/" + encodeURIComponent(t.name) + "/columns/" + encodeURIComponent(c.name) + "?confirm=1", { method: "DELETE" }).then(function () { load(true); }).catch(function (er) { toast(er.message, 1); }); };
          td.appendChild(e); td.appendChild(x);
        }
        tr.appendChild(td); return tr;
      }));
      if (canWrite && t.kind === "table") {
        var add = el("div", { "class": "db-bar", style: "margin-top:10px" });
        var n = el("input", { placeholder: "ten_cot_moi", style: "width:160px" });
        var ty = el("select"); DB_TYPES.forEach(function (x) { ty.appendChild(el("option", { value: x[0] }, esc(x[1]))); });
        var cm = el("input", { placeholder: "ghi chú", style: "flex:1;min-width:120px" });
        var b = el("button", { "class": "sm" }, "＋ Thêm cột");
        b.onclick = function () { api("/v1/db/tables/" + encodeURIComponent(t.name) + "/columns", { method: "POST", body: { name: n.value.trim(), type: ty.value, comment: cm.value || undefined } }).then(function () { toast("Đã thêm cột"); load(true); }).catch(function (e) { toast(e.message, 1); }); };
        [n, ty, cm, b].forEach(function (x) { add.appendChild(x); });
        box.appendChild(add);
      }
      if (t.constraints.length || t.indexes.length) {
        box.appendChild(el("h4", { style: "margin:14px 0 4px;font-size:.85rem" }, "Ràng buộc & chỉ mục"));
        var pre = el("pre", { "class": "wf-pre" }); pre.textContent = t.constraints.map(function (k) { return k.name + ": " + k.definition; }).concat(t.indexes.map(function (i) { return i.definition; })).join("\n"); box.appendChild(pre);
      }
    }

    function renderSql(box) {
      var tables = D.schema ? D.schema.tables : [];
      box.appendChild(el("div", { "class": "muted", style: "font-size:.8rem;margin-bottom:6px" }, "SQL PostgreSQL trên CSDL của workspace" + (canWrite ? "" : " (tài khoản của bạn chỉ được đọc)") + ". Nhiều lệnh cách nhau bằng <code>;</code> chạy trong MỘT giao dịch. Bảng: " + (tables.length ? tables.map(function (t) { return "<code>" + esc(t.name) + "</code>"; }).join(" ") : "(chưa có)")));
      var ta = el("textarea", { "class": "db-sql", spellcheck: "false" }); ta.value = D.sqlText || (D.sel ? "SELECT * FROM " + D.sel + " LIMIT 20" : "SELECT 1");
      ta.oninput = function () { D.sqlText = ta.value; };
      box.appendChild(ta);
      var bar = el("div", { "class": "db-bar", style: "margin-top:6px" });
      var dry = el("label", { style: "display:flex;gap:5px;align-items:center;opacity:1;font-size:.82rem" }, "<input type='checkbox' id='qdry'> Chạy thử (hoàn tác, không lưu)");
      var go2 = el("button", null, "▶ Chạy (Ctrl+Enter)");
      bar.appendChild(go2); if (canWrite) bar.appendChild(dry);
      box.appendChild(bar);
      var out = el("div"); box.appendChild(out);
      function run(confirmed) {
        out.innerHTML = "<span class='muted'>Đang chạy…</span>";
        var body = { sql: ta.value, dryRun: canWrite ? $("#qdry", box).checked : false };
        if (confirmed) body.confirm = true;
        api("/v1/db/query", { method: "POST", body: body }).then(function (r) {
          out.innerHTML = "";
          out.appendChild(el("div", { "class": "muted", style: "font-size:.8rem;margin:6px 0" }, (r.dryRun ? "<span class='pill run'>chạy thử — đã hoàn tác</span> " : "") + r.statements.map(function (s) { return esc(s.command) + (s.rowCount != null ? " " + s.rowCount : ""); }).join(" · ") + (r.truncated ? " · <span class='err'>đã cắt bớt kết quả</span>" : "")));
          if (r.fields && r.fields.length) out.appendChild(dbGrid(r.fields, r.rows, {}));
          if (r.kind !== "read" && !r.dryRun) load(true);
        }).catch(function (e) {
          if (/confirm=true/.test(e.message) && canWrite && confirm(e.message.replace(/ — hỏi lại người dùng, rồi gọi lại với confirm=true\./, "") + "\n\nVẫn chạy?")) return run(true);
          out.innerHTML = "<div class='wf-issues' style='white-space:pre-wrap'>" + esc(e.message) + "</div>";
        });
      }
      go2.onclick = function () { run(false); };
      ta.onkeydown = function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(false); } };
    }

    function renderAudit(box) {
      box.innerHTML = "<span class='muted'>Đang tải…</span>";
      var VIA = { dashboard: "👤 Dashboard", api: "🔑 API", agent: "🤖 agent", mcp: "🔗 AI ngoài", workflow: "⚙️ quy trình" };
      api("/v1/db/audit?limit=200").then(function (j) {
        box.innerHTML = "";
        box.appendChild(el("div", { "class": "muted", style: "font-size:.8rem;margin-bottom:6px" }, "Mọi lệnh ghi dữ liệu / đổi cấu trúc (không ghi lệnh chỉ đọc)."));
        box.appendChild(table(["Lúc", "Bởi", "Loại", "Câu lệnh", "Dòng"], j.entries, function (a) {
          var tr = el("tr");
          tr.innerHTML = "<td style='font-size:.76rem;white-space:nowrap'>" + esc(fmtTime(a.createdAt)) + "</td><td style='font-size:.78rem'>" + esc(VIA[a.via] || a.via) + (a.workflowId ? " <a href='#/workflows/" + esc(a.workflowId) + "'>↗</a>" : "") + "</td><td style='font-size:.76rem'>" + esc(a.kind) + (a.destructive ? " <span class='pill bad'>xóa nhiều</span>" : "") + "</td><td><code style='font-size:.72rem;white-space:pre-wrap;word-break:break-all'>" + esc(String(a.statement).slice(0, 400)) + "</code>" + (a.error ? "<div class='err' style='font-size:.74rem'>✗ " + esc(a.error) + "</div>" : "") + "</td><td style='font-size:.78rem'>" + (a.rowCount == null ? "" : a.rowCount) + "</td>";
          return tr;
        }));
      }).catch(function (e) { box.innerHTML = "<span class='err'>" + esc(e.message) + "</span>"; });
    }

    function renderSnap(box) {
      box.innerHTML = "<span class='muted'>Đang tải…</span>";
      api("/v1/db/snapshots").then(function (j) {
        box.innerHTML = "";
        box.appendChild(el("div", { "class": "muted", style: "font-size:.8rem;margin-bottom:8px;line-height:1.6" }, "Mỗi ngày tự chụp toàn bộ bảng (giữ " + j.keep + " bản gần nhất; CSDL lớn hơn " + j.maxMb + " MB thì không chụp — dùng <code>sudo penai backup</code>). Khôi phục một bảng = thay toàn bộ dữ liệu hiện tại của bảng đó bằng dữ liệu trong bản chụp; bảng đã xóa thì tạo lại."));
        if (canWrite) { var b = el("button", { "class": "sm", style: "margin-bottom:8px" }, "💾 Chụp ngay"); b.onclick = function () { b.disabled = true; api("/v1/db/snapshots", { method: "POST" }).then(function (r) { toast(r.skipped ? r.skipped : "Đã chụp " + r.tables + " bảng"); renderSnap(box); }).catch(function (e) { b.disabled = false; toast(e.message, 1); }); }; box.appendChild(b); }
        box.appendChild(table(["Lúc chụp", "Loại", "Bảng (số dòng)", "Dung lượng", ""], j.snapshots, function (s) {
          var tr = el("tr");
          tr.innerHTML = "<td style='font-size:.8rem;white-space:nowrap'>" + esc(fmtTime(s.takenAt)) + "</td><td style='font-size:.78rem'>" + (s.manual ? "chụp tay" : "tự động") + "</td><td style='font-size:.78rem'>" + (s.tables || []).map(function (t) { return esc(t.name) + " (" + t.rows + ")"; }).join(", ") + "</td><td class='muted' style='font-size:.76rem'>" + dbMb(s.sizeBytes) + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          if (canWrite && (s.tables || []).length) {
            var sel = el("select", { style: "font-size:.78rem" }); (s.tables || []).forEach(function (t) { var o = el("option", { value: t.name }, esc(t.name)); if (t.name === D.sel) o.selected = true; sel.appendChild(o); });
            var rb = el("button", { "class": "ghost sm" }, "↩ Khôi phục");
            rb.onclick = function () {
              if (!confirm("Khôi phục bảng " + sel.value + " về lúc " + fmtTime(s.takenAt) + "? Dữ liệu hiện tại của bảng sẽ bị THAY HẾT.")) return;
              api("/v1/db/snapshots/" + s.id + "/restore", { method: "POST", body: { table: sel.value, confirm: true } }).then(function (r) { toast("Đã khôi phục " + r.rows + " dòng" + (r.recreated ? " (tạo lại bảng)" : "")); load(true); }).catch(function (e) { toast(e.message, 1); });
            };
            td.appendChild(sel); td.appendChild(document.createTextNode(" ")); td.appendChild(rb);
          }
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { box.innerHTML = "<span class='err'>" + esc(e.message) + "</span>"; });
    }

    left.innerHTML = "<span class='muted'>Đang tải…</span>";
    load();
  };
`;
