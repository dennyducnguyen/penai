/**
 * Dashboard → ⚙️ Quy trình: danh sách + trang dựng xếp dọc (kéo thả), form theo
 * loại bước (tự sinh ô nhập từ JSON Schema của tool/MCP), chạy thử, lịch sử chạy,
 * phiên bản + hoàn về, nhập/xuất JSON, mẫu có sẵn, khóa bí mật.
 *
 * JavaScript thuần, được ghép vào bên trong IIFE của ui.ts (dùng chung các hàm
 * el, $, esc, api, page, card, table, toast, modal, fmtTime, copyText, state).
 * Viết bằng String.raw: KHÔNG dùng dấu backtick và chuỗi "$" + "{" trong khối này.
 */
export const WORKFLOWS_UI = String.raw`
  // ===================== ⚙️ Quy trình =====================
  (function wfStyles() {
    var css = [
      ".wf-grid{display:grid;grid-template-columns:minmax(380px,1.1fr) minmax(340px,1fr);gap:14px;align-items:start}",
      "@media(max-width:1000px){.wf-grid{grid-template-columns:1fr}}",
      ".wf-col{min-width:0}",
      ".wf-right{position:sticky;top:0;max-height:calc(100vh - 150px);overflow:auto}",
      ".wf-step{border:1px solid var(--border);border-left:4px solid #64748b;border-radius:10px;padding:7px 10px;background:var(--card);cursor:pointer;position:relative}",
      ".wf-step:hover{border-color:var(--accent2)}",
      ".wf-step.sel{outline:2px solid var(--accent);outline-offset:1px}",
      ".wf-step.g-data{border-left-color:#14b8a6}.wf-step.g-control{border-left-color:#eab308}.wf-step.g-ai{border-left-color:#ec4899}.wf-step.g-output{border-left-color:#3b82f6}",
      ".wf-step.st-success{box-shadow:inset 0 0 0 1px #22c55e66}.wf-step.st-failed{box-shadow:inset 0 0 0 2px #ef4444;background:rgba(239,68,68,.06)}.wf-step.st-dry_run{box-shadow:inset 0 0 0 1px #a855f766}",
      ".wf-step.off{opacity:.5}",
      ".wf-step .hd{display:flex;align-items:center;gap:6px;font-size:.86rem}",
      ".wf-step .hd .ty{font-size:.7rem;padding:0 6px;border-radius:999px;border:1px solid var(--border);opacity:.8;white-space:nowrap}",
      ".wf-step .hd .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".wf-step .hd .id{font-family:ui-monospace,monospace;font-size:.72rem;opacity:.55}",
      ".wf-step .hd .sp{flex:1}",
      ".wf-step .hd button{padding:0 6px;font-size:.78rem;line-height:1.5}",
      ".wf-step .sm{font-size:.76rem;opacity:.7;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}",
      ".wf-step .out{font-size:.72rem;margin-top:3px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}",
      ".wf-kids{margin:6px 0 2px 14px;padding-left:10px;border-left:2px dashed var(--border)}",
      ".wf-kids .lbl{font-size:.72rem;font-weight:600;opacity:.65;margin:6px 0 2px}",
      ".wf-drop{height:8px;border-radius:6px;margin:1px 0;transition:height .1s}",
      ".wf-drop.over{height:26px;background:rgba(59,130,246,.18);outline:2px dashed var(--accent2)}",
      ".wf-add{font-size:.78rem;padding:2px 8px;margin:2px 0 4px}",
      ".wf-trig{border:1px solid var(--accent2);border-radius:10px;padding:10px;margin-bottom:10px}",
      ".wf-form label{margin-top:9px}",
      ".wf-form input[type=text],.wf-form input:not([type]),.wf-form input[type=number],.wf-form select,.wf-form textarea{width:100%}",
      ".wf-form textarea.code,.wf-json{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem;line-height:1.45;tab-size:2}",
      ".wf-kv{display:grid;grid-template-columns:1fr 1.6fr auto;gap:4px;margin-bottom:4px}",
      ".wf-inline{display:flex;gap:6px;align-items:center}.wf-inline>input,.wf-inline>select,.wf-inline>textarea{flex:1;min-width:0}",
      ".wf-var{position:relative}.wf-varbtn{padding:2px 7px;font-size:.74rem}",
      ".wf-varmenu{position:absolute;z-index:20;right:0;top:100%;background:var(--card);border:1px solid var(--border);border-radius:8px;max-height:280px;overflow:auto;min-width:280px;box-shadow:0 8px 24px #0004;padding:4px}",
      ".wf-varmenu div{padding:4px 8px;border-radius:6px;cursor:pointer;font-size:.8rem;font-family:ui-monospace,monospace}",
      ".wf-varmenu div:hover{background:rgba(128,128,128,.15)}.wf-varmenu .g{font-family:inherit;opacity:.55;font-size:.7rem;cursor:default;text-transform:uppercase}",
      ".wf-varmenu .g:hover{background:none}",
      ".wf-issues{border:1px solid #ef444466;background:rgba(239,68,68,.06);border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:.82rem}",
      ".wf-issues.warn{border-color:#eab30866;background:rgba(234,179,8,.07)}",
      ".wf-banner{border:1px solid #ec489966;background:rgba(236,72,153,.07);border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:.85rem;display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".wf-run-step{border-bottom:1px solid var(--border);padding:5px 2px;font-size:.82rem;cursor:pointer}",
      ".wf-run-step:hover{background:rgba(128,128,128,.08)}",
      ".wf-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:.76rem;background:rgba(128,128,128,.1);border-radius:8px;padding:8px;max-height:320px;overflow:auto;margin:4px 0}",
      ".wf-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}",
      ".wf-pick button{text-align:left;background:transparent;color:inherit;border:1px solid var(--border);font-weight:400;padding:9px 10px}",
      ".wf-pick button:hover{border-color:var(--accent2);background:rgba(128,128,128,.08)}",
      ".wf-pick b{display:block;font-size:.86rem}.wf-pick span{font-size:.75rem;opacity:.65}",
      ".pill.bad{color:#ef4444;border-color:#ef444466}.pill.run{color:#3b82f6;border-color:#3b82f666}.pill.warn{color:#ca8a04;border-color:#eab30866}"
    ].join("\n");
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  })();

  var WF_TYPES = {
    http: ["🌐", "Gọi API", "data"], code: ["🧮", "Chạy mã", "data"], "if": ["🔀", "Nếu … thì", "control"],
    "switch": ["🎚️", "Chọn theo giá trị", "control"], loop: ["🔁", "Lặp danh sách", "control"], "while": ["🔂", "Lặp khi còn đúng", "control"],
    parallel: ["⏸️", "Chạy song song", "control"], "break": ["⏏️", "Thoát vòng lặp", "control"], stop: ["⛔", "Dừng", "control"],
    wait: ["⏳", "Chờ", "control"], set: ["📌", "Đặt biến", "data"], send: ["✉️", "Gửi tin", "output"], tool: ["🛠️", "Gọi tool", "data"],
    mcp: ["🧩", "Gọi MCP", "data"], agent: ["🤖", "Nhờ agent", "ai"], respond: ["↩️", "Trả kết quả webhook", "output"],
    subworkflow: ["🔗", "Gọi quy trình khác", "control"], file: ["📁", "File", "data"], shell: ["💻", "Lệnh shell", "data"]
  };
  var WF_SUMMARY = {
    http: "Gọi một địa chỉ HTTP (GET/POST…), nhận JSON/text về.", code: "Mã JavaScript tính toán, biến đổi dữ liệu (có return).",
    "if": "Rẽ nhánh theo điều kiện: Đúng / Sai.", "switch": "So một giá trị với nhiều trường hợp.", loop: "Chạy các bước con cho từng phần tử của một mảng.",
    "while": "Lặp tới khi điều kiện sai (có trần số vòng).", parallel: "Chạy nhiều nhánh cùng lúc rồi gom kết quả.", "break": "Thoát vòng lặp gần nhất.",
    stop: "Dừng quy trình (không tính là lỗi).", wait: "Chờ một khoảng thời gian hoặc tới một thời điểm.", set: "Gán giá trị vào vars.* để dùng ở bước sau.",
    send: "Gửi tin nhắn/file tới một cuộc trò chuyện (Zalo, Telegram…).", tool: "Gọi tool có sẵn hoặc custom tool của PenAI, không qua AI.",
    mcp: "Gọi tool của MCP server đã gắn vào PenAI, không qua AI.", agent: "Giao việc cho một agent AI (đủ tool của nó); nhận câu trả lời, có thể gửi thẳng vào chat.",
    respond: "Trả status/body cho bên gọi webhook.", subworkflow: "Chạy một quy trình khác và nhận kết quả.", file: "Đọc/ghi/liệt kê file trong thư mục của quy trình.",
    shell: "Chạy lệnh trong sandbox (máy chủ phải bật workflows.allowShell)."
  };
  var WF_STATUS = { success: ["ok", "✓ xong"], failed: ["bad", "✗ lỗi"], stopped: ["warn", "■ dừng"], timeout: ["bad", "⌛ quá giờ"], cancelled: ["warn", "✕ hủy"], running: ["run", "… đang chạy"], dry_run: ["run", "◌ thử"], skipped: ["", "– bỏ qua"] };
  function wfPill(s) { var x = WF_STATUS[s] || ["", s || ""]; return '<span class="pill ' + x[0] + '">' + esc(x[1]) + "</span>"; }
  function wfCanEdit() { return !!(state.me && (state.me.role === "ws_admin" || state.me.role === "operator")); }
  function wfShort(v, n) { var s = typeof v === "string" ? v : JSON.stringify(v); if (s == null) return ""; n = n || 120; return s.length > n ? s.slice(0, n) + "…" : s; }
  function wfJson(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
  function wfClone(v) { return JSON.parse(JSON.stringify(v)); }
  function wfTrigText(t) {
    if (t.type === "schedule") return "⏰ " + (t.cron || t.schedule || "");
    if (t.type === "webhook") return "🔗 webhook" + (t.respond === "wait" ? " (chờ kết quả)" : "");
    if (t.type === "manual") return "▶ bấm tay";
    return t.type;
  }
  // Menu bật ra cạnh một nút: items = [[nhãn, hàm], …]
  function wfMenu(anchor, items) {
    var host = anchor.parentNode; host.style.position = "relative";
    var old = document.querySelector(".wf-popmenu"); if (old) old.remove();
    var mnu = el("div", { "class": "wf-varmenu wf-popmenu", style: "min-width:230px" });
    items.forEach(function (it) {
      var row = el("div", { style: "font-family:inherit" }, esc(it[0]));
      row.onclick = function (ev) { ev.stopPropagation(); mnu.remove(); it[1](); };
      mnu.appendChild(row);
    });
    host.appendChild(mnu);
    setTimeout(function () { document.addEventListener("click", function h() { mnu.remove(); document.removeEventListener("click", h); }); }, 0);
  }
  function wfDlg(width, html) {
    var d = modal("wf-dlg"); d.style.width = (width || 720) + "px"; d.style.maxWidth = "96vw"; d.style.padding = "18px";
    d.innerHTML = html; d.showModal(); return d;
  }

  // ---------- trang danh sách ----------
  PAGES.workflows = function () {
    var sub = (location.hash.split("?")[0].replace("#/workflows", "").replace(/^\//, ""));
    if (sub) return wfBuilder(decodeURIComponent(sub));
    var m = page("⚙️ Quy trình", "Tự động hóa không cần AI (hoặc AI chỉ là một bước): theo lịch, link webhook hoặc bấm tay → gọi API, chạy mã, rẽ nhánh, lặp, gửi tin, gọi tool/MCP, nhờ agent.");
    var info = card(m);
    info.innerHTML = '<div style="font-size:.85rem;line-height:1.55">💡 Tạo bằng tay ở đây, hoặc <b>nhờ agent khi chat</b> (vd <i>"mỗi sáng 8h gọi API đơn hàng, có đơn thì báo nhóm Zalo kinh doanh"</i> — agent dùng tool <code>workflow_create</code>), hoặc từ xa bằng <b>API</b> <code>/v1/workflows</code> (khóa API <code>psk_…</code>, hợp với Claude Code) và <b>MCP</b> (🔗 Kết nối AI bên ngoài → quyền <i>Quy trình</i>). Hướng dẫn đầy đủ: <code>docs/quy-trinh.md</code>.</div>';
    var bar = el("div", { "class": "row", style: "margin-bottom:12px" });
    if (wfCanEdit()) {
      var bNew = el("button", null, "＋ Tạo mới"); bNew.onclick = wfCreateBlank;
      var bTpl = el("button", { "class": "ghost" }, "📋 Từ mẫu"); bTpl.onclick = wfTemplates;
      var bImp = el("button", { "class": "ghost" }, "⬆ Nhập JSON"); bImp.onclick = wfImport;
      var bSec = el("button", { "class": "ghost" }, "🔑 Khóa bí mật"); bSec.onclick = wfSecrets;
      [bNew, bTpl, bImp, bSec].forEach(function (b) { bar.appendChild(b); });
    }
    m.appendChild(bar);
    var listC = card(m, "Danh sách");
    function load() {
      api("/v1/workflows").then(function (j) {
        listC.innerHTML = "<h3>Danh sách" + (j.running ? ' <span class="pill run">' + j.running + " đang chạy</span>" : "") + (j.enabled === false ? ' <span class="pill bad">tính năng đang tắt (workflows.enabled)</span>' : "") + "</h3>";
        listC.appendChild(table(["Tên", "Kích hoạt", "Trạng thái", "Lần chạy gần nhất", "Lần kế", "7 ngày", ""], j.workflows, function (w) {
          var tr = el("tr");
          var trig = (w.triggers || []).map(function (t) { return esc(t.indexOf("schedule") === 0 ? "⏰ " + t.slice(9) : t === "webhook" ? "🔗 webhook" : t === "manual" ? "▶ tay" : t); }).join("<br>");
          var st = w.stats || {};
          tr.innerHTML = '<td><a href="#/workflows/' + esc(w.id) + '"><b>' + esc(w.name) + "</b></a>" +
            (w.lastChangeVia === "agent" ? ' <span class="pill" title="Agent sửa gần nhất">🤖</span>' : w.lastChangeVia === "mcp" ? ' <span class="pill" title="Ứng dụng AI ngoài sửa gần nhất">🔗 AI</span>' : "") +
            '<div class="muted" style="font-size:.76rem">' + esc(w.description || "") + " · " + (w.stepCount || 0) + " bước · bản " + w.version + "</div></td>" +
            '<td style="font-size:.8rem">' + trig + "</td>" +
            "<td>" + (w.enabled ? '<span class="pill ok">bật</span>' : '<span class="pill">tắt</span>') + "</td>" +
            "<td>" + (w.lastRunStatus ? wfPill(w.lastRunStatus) + ' <span class="muted" style="font-size:.75rem">' + esc(fmtTime(w.lastRunAt)) + "</span>" : '<span class="muted">—</span>') + "</td>" +
            '<td class="muted" style="font-size:.78rem">' + (w.nextRunAt ? esc(fmtTime(w.nextRunAt)) : "—") + "</td>" +
            '<td style="font-size:.78rem">' + (st.total || 0) + " lần" + (st.failed ? ' · <span class="err">' + st.failed + " lỗi</span>" : "") + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          var bOpen = el("button", { "class": "ghost sm" }, "✏️ Mở"); bOpen.onclick = function () { location.hash = "#/workflows/" + w.id; };
          td.appendChild(bOpen);
          if (wfCanEdit()) {
            var bRun = el("button", { "class": "ghost sm" }, "▶ Chạy"); bRun.onclick = function () { wfRunDialog(w, false, null, function () { load(); }); };
            var bTog = el("button", { "class": "ghost sm" }, w.enabled ? "Tắt" : "Bật");
            bTog.onclick = function () { api("/v1/workflows/" + w.id, { method: "PATCH", body: { enabled: !w.enabled } }).then(load).catch(function (e) { toast(e.message, 1); }); };
            var bDup = el("button", { "class": "ghost sm" }, "⧉");
            bDup.title = "Nhân bản";
            bDup.onclick = function () {
              api("/v1/workflows/" + w.id).then(function (j2) {
                var d = wfClone(j2.workflow.definition); d.name = d.name + " (bản sao)";
                return api("/v1/workflows", { method: "POST", body: { definition: d, enabled: false } });
              }).then(function (r) { toast("Đã nhân bản (đang tắt)"); location.hash = "#/workflows/" + r.workflow.id; }).catch(function (e) { toast(e.message, 1); });
            };
            var bExp = el("a", { "class": "ghost sm", href: "/v1/workflows/" + w.id + "/export", style: "padding:4px 8px;border:1px solid var(--border);border-radius:8px;text-decoration:none;font-size:.82rem" }, "⬇");
            bExp.title = "Xuất JSON";
            var bDel = el("button", { "class": "ghost sm" }, "🗑");
            bDel.onclick = function () { if (confirm('Xóa quy trình "' + w.name + '" (kèm lịch sử chạy, phiên bản)?')) api("/v1/workflows/" + w.id, { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); }); };
            [bRun, bTog, bDup, bExp, bDel].forEach(function (b) { td.appendChild(document.createTextNode(" ")); td.appendChild(b); });
          }
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    load();
  };

  function wfCreateBlank() {
    var name = "Quy trình mới " + new Date().toLocaleString("vi-VN");
    api("/v1/workflows", { method: "POST", body: { definition: { name: name, triggers: [{ type: "manual" }], steps: [] }, enabled: false } })
      .then(function (r) { location.hash = "#/workflows/" + r.workflow.id; }).catch(function (e) { toast(e.message, 1); });
  }
  function wfTemplates() {
    api("/v1/workflows/templates").then(function (j) {
      var d = wfDlg(760, "<h3 style='margin:0 0 4px'>📋 Tạo từ mẫu</h3><div class='muted' style='margin-bottom:10px'>Mẫu tạo ra ở trạng thái <b>tắt</b> — sửa tên kênh, agent, MCP cho đúng rồi bật.</div><div class='wf-pick' id='tp'></div><div class='dialog-actions'><button class='ghost' id='tc'>Đóng</button></div>");
      $("#tc", d).onclick = d.closeNow;
      j.templates.forEach(function (t) {
        var b = el("button", null, "<b>" + esc(t.title) + "</b><span>" + esc(t.summary) + "</span>");
        b.onclick = function () {
          api("/v1/workflows", { method: "POST", body: { template: t.key } }).then(function (r) { d.closeNow(); toast("Đã tạo từ mẫu"); location.hash = "#/workflows/" + r.workflow.id; }).catch(function (e) { toast(e.message, 1); });
        };
        $("#tp", d).appendChild(b);
      });
    }).catch(function (e) { toast(e.message, 1); });
  }
  function wfImport() {
    var d = wfDlg(760, "<h3 style='margin:0 0 6px'>⬆ Nhập JSON</h3><div class='muted'>Dán định nghĩa quy trình (file <code>.workflow.json</code> xuất từ PenAI hoặc do AI viết), hoặc chọn file.</div>" +
      "<input type='file' id='if' accept='.json,application/json' style='margin:8px 0'><textarea id='it' class='wf-json' rows='16' style='width:100%'></textarea><div id='ie'></div>" +
      "<div class='dialog-actions'><button class='ghost' id='ic'>Hủy</button><button id='ik'>Nhập (đang tắt)</button></div>");
    $("#ic", d).onclick = d.closeNow;
    $("#if", d).onchange = function (e) { var f = e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { $("#it", d).value = String(r.result || ""); }; r.readAsText(f); };
    $("#ik", d).onclick = function () {
      var def; try { def = JSON.parse($("#it", d).value); } catch (e) { $("#ie", d).innerHTML = '<div class="err">JSON không hợp lệ: ' + esc(e.message) + "</div>"; return; }
      api("/v1/workflows", { method: "POST", body: { definition: def, enabled: false } }).then(function (r) { d.closeNow(); location.hash = "#/workflows/" + r.workflow.id; })
        .catch(function (e) { $("#ie", d).innerHTML = '<div class="wf-issues" style="white-space:pre-wrap">' + esc(e.message) + "</div>"; });
    };
  }
  function wfSecrets() {
    var d = wfDlg(680, "<h3 style='margin:0 0 4px'>🔑 Khóa bí mật</h3><div class='muted' style='margin-bottom:8px'>Dùng trong quy trình bằng <code>{{ secrets.TEN }}</code> — chỉ ở bước http (url/headers/query/body), mcp/tool args, shell env. Giá trị mã hóa, không bao giờ hiện lại, tự che *** trong nhật ký.</div>" +
      "<div id='sl'></div><h4 style='margin:14px 0 4px'>Thêm / đổi giá trị</h4><div class='row'><input id='sn' placeholder='TEN_KHOA (viết hoa)' style='flex:1'>" + pwField("sv") + "</div><input id='so' placeholder='Ghi chú (tùy chọn)' style='width:100%;margin-top:6px'>" +
      "<div class='dialog-actions'><span id='sm' class='muted' style='flex:1'></span><button class='ghost' id='sc'>Đóng</button><button id='ss'>Lưu</button></div>");
    bindPwToggles(d);
    $("#sc", d).onclick = d.closeNow;
    function load() {
      api("/v1/secrets").then(function (j) {
        var box = $("#sl", d); box.innerHTML = "";
        box.appendChild(table(["Tên", "Ghi chú", "Cập nhật", ""], j.secrets, function (s) {
          var tr = el("tr"); tr.innerHTML = "<td><code>" + esc(s.name) + "</code></td><td class='muted'>" + esc(s.note || "") + "</td><td class='muted' style='font-size:.76rem'>" + esc(fmtTime(s.updatedAt)) + "</td>";
          var td = el("td"); var b = el("button", { "class": "ghost sm" }, "Xóa");
          b.onclick = function () { if (confirm("Xóa khóa " + s.name + "? Quy trình đang dùng sẽ lỗi.")) api("/v1/secrets/" + encodeURIComponent(s.name), { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); }); };
          var e2 = el("button", { "class": "ghost sm" }, "Đổi"); e2.onclick = function () { $("#sn", d).value = s.name; $("#so", d).value = s.note || ""; $("#sv", d).focus(); };
          td.appendChild(e2); td.appendChild(document.createTextNode(" ")); td.appendChild(b); tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { $("#sl", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    $("#ss", d).onclick = function () {
      var body = { name: $("#sn", d).value.trim().toUpperCase(), note: $("#so", d).value };
      if ($("#sv", d).value) body.value = $("#sv", d).value;
      api("/v1/secrets", { method: "POST", body: body }).then(function () { $("#sv", d).value = ""; $("#sm", d).innerHTML = '<span class="ok">Đã lưu ' + esc(body.name) + "</span>"; load(); })
        .catch(function (e) { $("#sm", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
    load();
  }

  // ---------- chạy (bấm tay / chạy thử) ----------
  function wfInputsForm(def) {
    var ins = (def && def.inputs) || {};
    var keys = Object.keys(ins);
    if (!keys.length) return "<div class='muted'>Quy trình không khai báo tham số đầu vào.</div>";
    return keys.map(function (k) {
      var x = typeof ins[k] === "string" ? { type: ins[k] } : (ins[k] || {});
      var dv = x["default"] == null ? "" : (typeof x["default"] === "string" ? x["default"] : JSON.stringify(x["default"]));
      return "<label>" + esc(k) + " <span class='muted'>(" + esc(x.type || "string") + (x.required ? ", bắt buộc" : "") + ")</span>" + (x.note ? " — " + esc(x.note) : "") + "</label>" +
        (x.type === "boolean" ? "<select data-in='" + esc(k) + "'><option value=''>(mặc định)</option><option value='true'>true</option><option value='false'>false</option></select>"
          : "<input data-in='" + esc(k) + "' placeholder='" + esc(dv ? "mặc định: " + dv : "") + "' style='width:100%'>");
    }).join("");
  }
  function wfReadInputs(root) {
    var out = {};
    Array.prototype.forEach.call(root.querySelectorAll("[data-in]"), function (i) { if (i.value !== "") out[i.getAttribute("data-in")] = i.value; });
    return out;
  }
  // test=true → chạy thử (có thể bản nháp chưa lưu); onDone(run, steps)
  function wfRunDialog(w, test, draft, onDone) {
    var def = draft || w.definition;
    var go = function (d) {
      d.innerHTML = "<h3 style='margin:0 0 6px'>" + (test ? "🧪 Chạy thử" : "▶ Chạy") + ": " + esc(w.name) + "</h3>" + wfInputsForm(def) +
        (test ? "<label style='display:flex;gap:6px;align-items:center;margin-top:12px;opacity:1'><input type='checkbox' id='rd' checked> Không gửi thật (dry run): bước gửi tin / POST / MCP / tool / ghi file chỉ hiện sẽ làm gì</label>" : "<div class='muted' style='margin-top:10px'>Chạy THẬT — gửi tin, gọi API như bình thường.</div>") +
        (test && draft ? "<div class='muted' style='font-size:.78rem'>Chạy bản đang sửa trên màn hình (chưa cần lưu).</div>" : "") +
        "<div class='dialog-actions'><span id='rm' class='muted' style='flex:1'></span><button class='ghost' id='rc'>Hủy</button><button id='rg'>" + (test ? "Chạy thử" : "Chạy") + "</button></div>";
      $("#rc", d).onclick = d.closeNow;
      $("#rg", d).onclick = function () {
        var body = { inputs: wfReadInputs(d), wait: true };
        if (test) { body.dryRun = $("#rd", d).checked; if (draft) body.definition = draft; }
        $("#rg", d).disabled = true; $("#rm", d).textContent = "Đang chạy…";
        api("/v1/workflows/" + w.id + (test ? "/test" : "/run"), { method: "POST", body: body }).then(function (r) {
          d.closeNow();
          if (!r.finished) toast("Vẫn đang chạy ở nền — xem ở Lịch sử");
          else toast("Chạy xong: " + (r.run && r.run.status));
          if (onDone) onDone(r.run, r.steps || []);
        }).catch(function (e) { $("#rg", d).disabled = false; $("#rm", d).innerHTML = '<span class="err" style="white-space:pre-wrap">' + esc(e.message) + "</span>"; });
      };
    };
    var d = wfDlg(560, "<div class='muted'>Đang tải…</div>");
    if (def) go(d);
    else api("/v1/workflows/" + w.id).then(function (j) { def = j.workflow.definition; go(d); }).catch(function (e) { d.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
  }

  // ---------- trang dựng ----------
  function wfBuilder(id) {
    var m = page("⚙️ Quy trình", "");
    m.querySelector(".sub") && m.querySelector(".sub").remove();
    var S = { wf: null, draft: null, dirty: false, sel: null, cat: null, last: {}, runMarks: null, issues: [], warnings: [] };
    var editable = wfCanEdit();

    window.onbeforeunload = function () { return S.dirty ? "Có thay đổi chưa lưu" : undefined; };
    state.pageCleanup = function () { window.onbeforeunload = null; };

    var top = el("div", { "class": "row", style: "margin-bottom:10px" });
    m.appendChild(top);
    var bannerBox = el("div"); m.appendChild(bannerBox);
    var issuesBox = el("div"); m.appendChild(issuesBox);
    var grid = el("div", { "class": "wf-grid" }); m.appendChild(grid);
    var left = el("div", { "class": "wf-col" }); var right = el("div", { "class": "wf-col wf-right" });
    grid.appendChild(left); grid.appendChild(right);

    function setDirty(v) { S.dirty = v; var b = $("#wfSave"); if (b) b.textContent = v ? "💾 Lưu *" : "💾 Lưu"; }
    function changed() { setDirty(true); renderLeft(); }

    function load() {
      return Promise.all([
        api("/v1/workflows/" + encodeURIComponent(id)),
        editable ? api("/v1/workflows/catalog").catch(function () { return {}; }) : Promise.resolve({})
      ]).then(function (res) {
        S.wf = res[0].workflow; S.draft = wfClone(S.wf.definition); S.cat = res[1] || {};
        S.last = (res[0].lastRun && res[0].lastRun.steps) || {};
        if (id !== S.wf.id) { id = S.wf.id; history.replaceState(null, "", "#/workflows/" + id); }
        setDirty(false); renderTop(); renderBanner(); renderLeft(); renderRight();
      }).catch(function (e) { left.innerHTML = '<div class="card err">' + esc(e.message) + "</div>"; });
    }

    function renderTop() {
      top.innerHTML = "";
      var back = el("a", { href: "#/workflows", style: "text-decoration:none;font-size:.9rem" }, "← Danh sách"); top.appendChild(back);
      var nm = el("input", { value: S.draft.name || "", style: "flex:1;min-width:200px;font-weight:600;font-size:1.05rem" });
      nm.disabled = !editable;
      nm.oninput = function () { S.draft.name = nm.value; setDirty(true); };
      top.appendChild(nm);
      top.appendChild(el("span", null, (S.wf.enabled ? '<span class="pill ok">đang bật</span>' : '<span class="pill">đang tắt</span>') + ' <span class="muted" style="font-size:.78rem">bản ' + S.wf.version + "</span>"));
      function btn(txt, cls, fn, title) { var b = el("button", { "class": cls || "ghost sm" }, txt); if (title) b.title = title; b.onclick = fn; top.appendChild(b); return b; }
      if (editable) {
        var sb = btn("💾 Lưu", "sm", save); sb.id = "wfSave";
        btn(S.wf.enabled ? "Tắt" : "Bật", null, function () {
          if (S.dirty && !confirm("Có thay đổi chưa lưu — vẫn bật/tắt (thay đổi giữ trên màn hình)?")) return;
          api("/v1/workflows/" + id, { method: "PATCH", body: { enabled: !S.wf.enabled } }).then(function (r) { S.wf = r.workflow; renderTop(); toast(S.wf.enabled ? "Đã bật" : "Đã tắt"); }).catch(function (e) { toast(e.message, 1); });
        });
        btn("🧪 Chạy thử", null, function () { wfRunDialog(S.wf, true, S.draft, showRun); });
        btn("▶ Chạy thật", null, function () {
          if (S.dirty) { toast("Lưu trước khi chạy thật (hoặc dùng Chạy thử)", 1); return; }
          wfRunDialog(S.wf, false, null, showRun);
        });
      }
      btn("🕘 Lịch sử", null, openHistory);
      btn("🗂 Phiên bản", null, openVersions);
      btn("{ } JSON", null, openJson);
      var ex = el("a", { href: "/v1/workflows/" + id + "/export", "class": "ghost sm", style: "padding:4px 9px;border:1px solid var(--border);border-radius:8px;text-decoration:none;font-size:.82rem;color:inherit" }, "⬇ Xuất");
      top.appendChild(ex);
    }

    function renderBanner() {
      bannerBox.innerHTML = "";
      if (S.wf.lastChangeVia === "agent" || S.wf.lastChangeVia === "mcp") {
        var b = el("div", { "class": "wf-banner" }, (S.wf.lastChangeVia === "agent" ? "🤖 Agent" : "🔗 Ứng dụng AI bên ngoài") + " vừa sửa quy trình này (bản " + S.wf.version + "). ");
        var v = el("button", { "class": "ghost sm" }, "Xem phiên bản / hoàn về"); v.onclick = openVersions; b.appendChild(v);
        bannerBox.appendChild(b);
      }
    }

    function renderIssues() {
      issuesBox.innerHTML = "";
      if (S.issues.length) {
        issuesBox.appendChild(el("div", { "class": "wf-issues" }, "<b>Chưa lưu được — sửa các lỗi sau:</b><br>" + S.issues.map(function (i) { return "• " + esc(i.path ? i.path + ": " : "") + esc(i.message); }).join("<br>")));
      }
      if (S.warnings.length) {
        issuesBox.appendChild(el("div", { "class": "wf-issues warn" }, "<b>Lưu ý:</b><br>" + S.warnings.map(function (i) { return "• " + esc(i.path ? i.path + ": " : "") + esc(i.message); }).join("<br>")));
      }
    }

    function save() {
      var note = "";
      api("/v1/workflows/" + id, { method: "PUT", body: { definition: S.draft, note: note, expectVersion: S.wf.version } }).then(function (r) {
        S.wf = r.workflow; S.draft = wfClone(S.wf.definition); S.issues = []; S.warnings = r.warnings || [];
        setDirty(false); renderTop(); renderBanner(); renderIssues(); renderLeft(); renderRight();
        toast(r.diff && r.diff.length ? "Đã lưu bản " + S.wf.version : "Không có thay đổi");
      }).catch(function (e) {
        // lỗi validate trả issues có path
        api("/v1/workflows/validate", { method: "POST", body: { definition: S.draft } }).then(function (v) {
          S.issues = v.errors || []; S.warnings = v.warnings || [];
          if (!S.issues.length) S.issues = [{ path: "", message: e.message }];
          renderIssues(); renderLeft();
        }).catch(function () { S.issues = [{ path: "", message: e.message }]; renderIssues(); });
      });
    }

    // ----- cây bước -----
    function allSteps(list, out, parents) {
      out = out || []; parents = parents || [];
      (list || []).forEach(function (s) { out.push({ step: s, parents: parents }); kidsOf(s).forEach(function (k) { allSteps(k.list, out, parents.concat([s])); }); });
      return out;
    }
    function kidsOf(s) {
      var out = [];
      if (!s || typeof s !== "object") return out;
      if (s.type === "if") { s.then = s.then || []; s["else"] = s["else"] || []; out.push({ key: "then", label: "✔ Đúng thì", list: s.then }); out.push({ key: "else", label: "✘ Sai thì", list: s["else"] }); }
      else if (s.type === "loop") { s.body = s.body || []; out.push({ key: "body", label: "↻ Với từng " + (s.as || "item") + " trong " + wfShort(s.over || "", 40), list: s.body }); }
      else if (s.type === "while") { s.body = s.body || []; out.push({ key: "body", label: "↻ Lặp khi " + wfShort(s.cond || "", 40), list: s.body }); }
      else if (s.type === "parallel") { s.branches = s.branches || [[], []]; s.branches.forEach(function (b, i) { out.push({ key: "branches[" + i + "]", label: "⫴ Nhánh " + (i + 1), list: b }); }); }
      else if (s.type === "switch") {
        s.cases = s.cases || []; s["default"] = s["default"] || [];
        s.cases.forEach(function (c, i) { c.steps = c.steps || []; out.push({ key: "cases[" + i + "].steps", label: "● " + (c.when ? "Khi " + wfShort(c.when, 40) : "= " + wfShort(c.value, 40)), list: c.steps }); });
        out.push({ key: "default", label: "○ Trường hợp khác", list: s["default"] });
      }
      return out;
    }
    function uniqueId(base) {
      var ids = {}; allSteps(S.draft.steps).forEach(function (x) { ids[x.step.id] = 1; });
      base = (base || "buoc").replace(/[^a-z0-9_]/g, "_").slice(0, 34);
      var i = 1, v = base + "_" + i; while (ids[v]) { i++; v = base + "_" + i; }
      return v;
    }
    function newStep(type) {
      var s = { id: uniqueId(type), type: type };
      if (type === "http") { s.method = "GET"; s.url = "https://"; }
      if (type === "code") s.code = "// dữ liệu bước trước: steps.<id>.output\nreturn { ok: true };";
      if (type === "if") { s.cond = "true"; s.then = []; s["else"] = []; }
      if (type === "switch") { s.value = "inputs.loai"; s.cases = [{ value: "a", steps: [] }]; s["default"] = []; }
      if (type === "loop") { s.over = "[]"; s.as = "item"; s.max = 100; s.body = []; }
      if (type === "while") { s.cond = "index < 3"; s.max = 100; s.body = []; }
      if (type === "parallel") s.branches = [[], []];
      if (type === "wait") s.duration = "10s";
      if (type === "set") s.values = { ten_bien: "{{ 1 }}" };
      if (type === "stop") s.reason = "Dừng";
      if (type === "send") { var ch = (S.cat.channels || [])[0]; s.channel = ch ? ch.ref : ""; s.to = ""; s.text = ""; }
      if (type === "tool") { s.tool = ""; s.args = {}; }
      if (type === "mcp") { var ms = (S.cat.mcp || [])[0]; s.server = ms ? ms.serverName : ""; s.tool = ""; s.args = {}; }
      if (type === "agent") { var ag = (S.cat.agents || [])[0]; s.agent = ag ? ag.key : ""; s.message = ""; }
      if (type === "respond") { s.status = 200; s.body = { ok: true }; }
      if (type === "subworkflow") { s.workflow = ""; s.inputs = {}; }
      if (type === "file") { s.action = "write"; s.path = "ket-qua.txt"; s.content = ""; }
      if (type === "shell") { s.command = "echo xin chao"; }
      return s;
    }
    function pickType(cb) {
      var d = wfDlg(760, "<h3 style='margin:0 0 10px'>＋ Thêm bước</h3><div class='wf-pick' id='pk'></div><div class='dialog-actions'><button class='ghost' id='pc'>Hủy</button></div>");
      $("#pc", d).onclick = d.closeNow;
      Object.keys(WF_TYPES).forEach(function (t) {
        var b = el("button", null, "<b>" + WF_TYPES[t][0] + " " + esc(WF_TYPES[t][1]) + " <code style='font-size:.7rem'>" + t + "</code></b><span>" + esc(WF_SUMMARY[t]) + "</span>");
        b.onclick = function () { d.closeNow(); cb(newStep(t)); };
        $("#pk", d).appendChild(b);
      });
    }
    function stepSummary(s) {
      switch (s.type) {
        case "http": return (s.method || "GET") + " " + (s.url || "");
        case "code": return String(s.code || "").split("\n").filter(function (l) { return l.trim() && l.trim().indexOf("//") !== 0; })[0] || "";
        case "if": case "while": return s.cond || "";
        case "switch": return "theo " + (s.value || "");
        case "loop": return (s.as || "item") + " ∈ " + (s.over || "") + " (tối đa " + (s.max || 100) + ")";
        case "parallel": return (s.branches || []).length + " nhánh";
        case "wait": return s.duration || ("tới " + (s.until || ""));
        case "set": return Object.keys(s.values || {}).map(function (k) { return "vars." + k; }).join(", ");
        case "send": return (s.channel || "?") + " → " + (s.to || "?") + ": " + wfShort(s.text || "", 60);
        case "tool": return (s.tool || "?") + (s.agent ? " (agent " + s.agent + ")" : "") + (s.approved ? " ✔duyệt" : "");
        case "mcp": return (s.server || "?") + " › " + (s.tool || "?");
        case "agent": return (s.agent || "?") + ": " + wfShort(s.message || "", 60) + (s.deliver ? " → " + s.deliver.channel : "");
        case "respond": return "HTTP " + (s.status || 200);
        case "subworkflow": return s.workflow || "";
        case "file": return (s.action || "") + " " + (s.path || "");
        case "shell": return s.command || "";
        case "stop": return s.reason || "";
        default: return "";
      }
    }
    var drag = null; // { list, index }
    function contains(step, list) { return kidsOf(step).some(function (k) { return k.list === list || k.list.some(function (c) { return contains(c, list); }); }); }
    function dropZone(list, index) {
      var z = el("div", { "class": "wf-drop" });
      if (!editable) return z;
      z.ondragover = function (e) { if (!drag) return; if (drag.list[drag.index] && (contains(drag.list[drag.index], list))) return; e.preventDefault(); z.classList.add("over"); };
      z.ondragleave = function () { z.classList.remove("over"); };
      z.ondrop = function (e) {
        e.preventDefault(); z.classList.remove("over");
        if (!drag) return;
        var item = drag.list[drag.index]; if (!item) return;
        var at = index;
        if (drag.list === list && drag.index < index) at--;
        drag.list.splice(drag.index, 1); list.splice(at, 0, item); drag = null; changed();
      };
      return z;
    }
    function renderList(list, box, inLoop) {
      box.appendChild(dropZone(list, 0));
      list.forEach(function (s, i) {
        box.appendChild(renderStep(s, list, i, inLoop));
        box.appendChild(dropZone(list, i + 1));
      });
      if (editable) {
        var add = el("button", { "class": "ghost wf-add" }, "＋ Thêm bước");
        add.onclick = function (e) { e.stopPropagation(); pickType(function (ns) { list.push(ns); S.sel = ns.id; changed(); renderRight(); }); };
        box.appendChild(add);
      }
    }
    function renderStep(s, list, i, inLoop) {
      var info = WF_TYPES[s.type] || ["❔", s.type, "data"];
      var mark = S.runMarks ? S.runMarks[s.id] : null;
      var hasIssue = S.issues.some(function (x) { return x.path && x.path.indexOf("(" + s.id + ")") >= 0; });
      var c = el("div", { "class": "wf-step g-" + info[2] + (S.sel === s.id ? " sel" : "") + (s.disabled ? " off" : "") + (mark ? " st-" + mark.status : "") + (hasIssue ? " st-failed" : "") });
      if (editable) { c.draggable = true; c.ondragstart = function (e) { e.stopPropagation(); drag = { list: list, index: i }; try { e.dataTransfer.setData("text/plain", s.id); } catch (x) {} }; c.ondragend = function () { drag = null; }; }
      var hd = el("div", { "class": "hd" });
      hd.innerHTML = "<span>" + info[0] + "</span><span class='ty'>" + esc(info[1]) + "</span><span class='nm'>" + esc(s.name || "") + "</span><span class='id'>" + esc(s.id) + "</span><span class='sp'></span>" +
        (mark ? wfPill(mark.status) + (mark.durationMs ? " <span class='muted' style='font-size:.7rem'>" + mark.durationMs + "ms</span>" : "") : "");
      if (editable) {
        var up = el("button", { "class": "ghost", title: "Lên" }, "▲"); up.onclick = function (e) { e.stopPropagation(); if (i > 0) { list.splice(i - 1, 0, list.splice(i, 1)[0]); changed(); } };
        var dn = el("button", { "class": "ghost", title: "Xuống" }, "▼"); dn.onclick = function (e) { e.stopPropagation(); if (i < list.length - 1) { list.splice(i + 1, 0, list.splice(i, 1)[0]); changed(); } };
        var more = el("button", { "class": "ghost", title: "Thao tác" }, "⋯");
        more.onclick = function (e) {
          e.stopPropagation();
          wfMenu(more, [
            ["＋ Thêm bước sau bước này", function () { pickType(function (ns) { list.splice(i + 1, 0, ns); S.sel = ns.id; changed(); renderRight(); }); }],
            ["🔀 Bọc trong khối Nếu … thì", function () { var w = newStep("if"); w.then = [s]; list.splice(i, 1, w); S.sel = w.id; changed(); renderRight(); }],
            ["⧉ Nhân bản", function () { var cp = wfClone(s); var fix = function (x) { x.id = uniqueId(x.id.replace(/_\d+$/, "")); kidsOf(x).forEach(function (k) { k.list.forEach(fix); }); }; fix(cp); list.splice(i + 1, 0, cp); changed(); }],
            [s.disabled ? "▶ Bật lại bước" : "⏸ Tắt bước (bỏ qua khi chạy)", function () { if (s.disabled) delete s.disabled; else s.disabled = true; changed(); }],
            ["🗑 Xóa bước", function () { if (confirm("Xóa bước " + s.id + (kidsOf(s).length ? " (kèm các bước con)" : "") + "?")) { list.splice(i, 1); if (S.sel === s.id) S.sel = null; changed(); renderRight(); } }]
          ]);
        };
        hd.appendChild(up); hd.appendChild(dn); hd.appendChild(more);
      }
      c.appendChild(hd);
      var sm = stepSummary(s); if (sm) c.appendChild(el("div", { "class": "sm" }, esc(wfShort(sm, 140))));
      var last = mark || S.last[s.id];
      if (last && !kidsOf(s).length) c.appendChild(el("div", { "class": "out" }, last.error ? '<span class="err">✗ ' + esc(wfShort(last.error, 140)) + "</span>" : "→ steps." + esc(s.id) + ".output = " + esc(wfShort(last.output, 140))));
      c.onclick = function (e) { e.stopPropagation(); S.sel = s.id; renderLeft(); renderRight(); };
      var kids = kidsOf(s);
      if (kids.length) {
        var kb = el("div", { "class": "wf-kids" });
        kids.forEach(function (k) {
          kb.appendChild(el("div", { "class": "lbl" }, esc(k.label)));
          renderList(k.list, kb, inLoop || s.type === "loop" || s.type === "while");
        });
        if (editable && (s.type === "parallel" || s.type === "switch")) {
          var addBr = el("button", { "class": "ghost wf-add" }, s.type === "parallel" ? "＋ Thêm nhánh" : "＋ Thêm trường hợp");
          addBr.onclick = function (e) { e.stopPropagation(); if (s.type === "parallel") s.branches.push([]); else s.cases.push({ value: "", steps: [] }); changed(); };
          kb.appendChild(addBr);
        }
        kb.onclick = function (e) { e.stopPropagation(); };
        c.appendChild(kb);
      }
      return c;
    }

    function renderLeft() {
      left.innerHTML = "";
      // triggers
      var tc = el("div", { "class": "wf-trig" });
      var trigs = S.draft.triggers = S.draft.triggers || [];
      tc.innerHTML = "<div style='display:flex;align-items:center;gap:6px'><b>⚡ Kích hoạt</b><span class='sp' style='flex:1'></span></div>";
      if (editable) {
        var at = el("select", { "class": "sm" }, "<option value=''>＋ Thêm cách kích hoạt…</option><option value='schedule'>⏰ Theo lịch</option><option value='webhook'>🔗 Link webhook</option><option value='manual'>▶ Bấm tay</option>");
        at.style.cssText = "font-size:.8rem;padding:3px 6px";
        at.onchange = function () {
          var v = at.value; if (!v) return;
          if (v === "webhook" && trigs.some(function (t) { return t.type === "webhook"; })) { toast("Đã có webhook", 1); at.value = ""; return; }
          var t = { type: v }; if (v === "schedule") t.cron = "0 8 * * *"; if (v === "webhook") { t.methods = ["POST", "GET"]; t.respond = "async"; }
          trigs.push(t); S.sel = "__trig" + (trigs.length - 1); changed(); renderRight();
        };
        tc.firstChild.appendChild(at);
      }
      trigs.forEach(function (t, i) {
        var row = el("div", { "class": "wf-step g-output" + (S.sel === "__trig" + i ? " sel" : ""), style: "margin-top:6px" });
        row.innerHTML = "<div class='hd'><span class='nm'>" + esc(wfTrigText(t)) + "</span><span class='sp'></span></div>";
        row.onclick = function () { S.sel = "__trig" + i; renderLeft(); renderRight(); };
        if (editable) { var x = el("button", { "class": "ghost" }, "✕"); x.onclick = function (e) { e.stopPropagation(); trigs.splice(i, 1); S.sel = null; changed(); renderRight(); }; row.firstChild.appendChild(x); }
        tc.appendChild(row);
      });
      if (!trigs.length) tc.appendChild(el("div", { "class": "muted", style: "margin-top:4px" }, "Chưa có — chỉ chạy được khi gọi từ quy trình khác hoặc API."));
      var meta = el("div", { "class": "row", style: "margin-top:8px;gap:6px" });
      var bIn = el("button", { "class": "ghost sm" }, "🧾 Tham số đầu vào (" + Object.keys(S.draft.inputs || {}).length + ")"); bIn.onclick = function () { S.sel = "__inputs"; renderLeft(); renderRight(); };
      var bSet = el("button", { "class": "ghost sm" }, "⚙ Cài đặt"); bSet.onclick = function () { S.sel = "__settings"; renderLeft(); renderRight(); };
      meta.appendChild(bIn); meta.appendChild(bSet); tc.appendChild(meta);
      left.appendChild(tc);
      var box = el("div"); renderList(S.draft.steps = S.draft.steps || [], box, false); left.appendChild(box);
      if (!S.draft.steps.length) left.appendChild(el("div", { "class": "muted", style: "margin:6px 2px" }, "Chưa có bước nào — bấm ＋ Thêm bước."));
    }

    // ----- form bên phải -----
    function findStepCtx(stepId) {
      var flat = allSteps(S.draft.steps);
      for (var i = 0; i < flat.length; i++) if (flat[i].step.id === stepId) return { step: flat[i].step, parents: flat[i].parents, before: flat.slice(0, i).map(function (x) { return x.step; }) };
      return null;
    }
    function varMenu(target, mode, ctxInfo) {
      // mode "tpl" → chèn {{ x }}, "expr" → chèn x
      var wrap = el("span", { "class": "wf-var" });
      var b = el("button", { "class": "ghost wf-varbtn", type: "button", title: "Chèn biến" }, "{ }");
      wrap.appendChild(b);
      b.onclick = function (e) {
        e.stopPropagation();
        var old = wrap.querySelector(".wf-varmenu"); if (old) { old.remove(); return; }
        var mnu = el("div", { "class": "wf-varmenu" });
        var groups = [];
        var ins = Object.keys(S.draft.inputs || {}); if (ins.length) groups.push(["Tham số", ins.map(function (k) { return "inputs." + k; })]);
        groups.push(["Kích hoạt", ["trigger.body", "trigger.query", "trigger.type", "workflow.runId"]]);
        if (ctxInfo) {
          var loopVars = [];
          ctxInfo.parents.forEach(function (p) { if (p.type === "loop") loopVars.push(p.as || "item"); if (p.type === "loop" || p.type === "while") loopVars.push("index", "loop.first", "loop.last"); });
          if (loopVars.length) groups.push(["Vòng lặp", loopVars]);
          var prev = ctxInfo.before.filter(function (s) { return s.id; });
          if (prev.length) groups.push(["Bước phía trên", prev.map(function (s) {
            var lr = S.last[s.id]; return { v: "steps." + s.id + ".output", hint: lr && lr.output != null ? wfShort(lr.output, 50) : (WF_TYPES[s.type] || [""])[1] };
          })]);
        }
        var setv = []; allSteps(S.draft.steps).forEach(function (x) { if (x.step.type === "set") Object.keys(x.step.values || {}).forEach(function (k) { setv.push("vars." + k); }); });
        if (setv.length) groups.push(["Biến", setv]);
        if (mode === "secret" && S.cat.secrets && S.cat.secrets.length) groups.push(["Khóa bí mật", S.cat.secrets.map(function (s) { return "secrets." + s.name; })]);
        groups.push(["Hàm", ["today()", "now()", "formatDate(now(), 'DD/MM/YYYY HH:mm')", "json(x)", "sum(arr, 'key')", "groupBy(arr, 'key')", "formatVND(n)", "len(x)", "get(obj, 'a.b')"]]);
        groups.forEach(function (g) {
          mnu.appendChild(el("div", { "class": "g" }, esc(g[0])));
          g[1].forEach(function (it) {
            var v = typeof it === "string" ? it : it.v;
            var row = el("div", null, esc(v) + (it.hint ? " <span class='muted' style='font-size:.68rem'>" + esc(it.hint) + "</span>" : ""));
            row.onclick = function (ev) {
              ev.stopPropagation();
              var text = mode === "expr" ? v : "{{ " + v + " }}";
              var st = target.selectionStart != null ? target.selectionStart : target.value.length, en = target.selectionEnd != null ? target.selectionEnd : st;
              target.value = target.value.slice(0, st) + text + target.value.slice(en);
              target.dispatchEvent(new Event("input")); target.focus(); mnu.remove();
            };
            mnu.appendChild(row);
          });
        });
        wrap.appendChild(mnu);
        setTimeout(function () { document.addEventListener("click", function h() { mnu.remove(); document.removeEventListener("click", h); }); }, 0);
      };
      return wrap;
    }
    // Ô nhập gắn vào obj[key]
    function field(box, label, obj, key, opts) {
      opts = opts || {};
      var lb = el("label", null, esc(label) + (opts.hint ? " <span class='muted' style='font-size:.72rem'>— " + esc(opts.hint) + "</span>" : ""));
      box.appendChild(lb);
      var inp;
      var cur = obj[key];
      if (opts.kind === "select") {
        inp = el("select");
        (opts.options || []).forEach(function (o) { var v = typeof o === "string" ? o : o[0], t = typeof o === "string" ? o : o[1]; var op = el("option", { value: v }, esc(t)); if (String(cur == null ? "" : cur) === v) op.selected = true; inp.appendChild(op); });
      } else if (opts.kind === "check") {
        inp = el("input", { type: "checkbox" }); inp.checked = !!cur; lb.style.display = "flex"; lb.style.gap = "6px"; lb.style.alignItems = "center"; lb.insertBefore(inp, lb.firstChild); lb.style.opacity = 1;
      } else if (opts.kind === "area" || opts.kind === "code" || opts.kind === "json") {
        inp = el("textarea", { rows: opts.rows || 3, "class": opts.kind === "area" ? "" : "code" });
        inp.value = opts.kind === "json" ? (cur === undefined ? "" : (typeof cur === "string" ? cur : wfJson(cur))) : (cur == null ? "" : String(cur));
        inp.spellcheck = false;
      } else {
        inp = el("input", { type: opts.kind === "number" ? "number" : "text" }); inp.value = cur == null ? "" : (typeof cur === "object" ? JSON.stringify(cur) : String(cur));
        if (opts.list) { var dlId = "dl" + Math.random().toString(36).slice(2); var dl = el("datalist", { id: dlId }); opts.list.forEach(function (o) { var op = el("option", { value: o[0] }); op.textContent = o[1] || o[0]; dl.appendChild(op); }); box.appendChild(dl); inp.setAttribute("list", dlId); }
      }
      if (opts.placeholder) inp.placeholder = opts.placeholder;
      inp.disabled = !editable || opts.readonly;
      var apply = function () {
        var v;
        if (opts.kind === "check") v = inp.checked;
        else if (opts.kind === "number") v = inp.value === "" ? undefined : Number(inp.value);
        else if (opts.kind === "json") {
          var raw = inp.value.trim();
          if (!raw) v = undefined;
          else { try { v = JSON.parse(raw); inp.style.outline = ""; } catch (e) { if (opts.jsonOrText) v = raw; else { inp.style.outline = "2px solid #ef4444"; return; } } }
        } else v = inp.value;
        if (v === undefined || v === "" && opts.dropEmpty) delete obj[key]; else obj[key] = v;
        if (opts.onChange) opts.onChange(v);
        setDirty(true);
        clearTimeout(S.rt); S.rt = setTimeout(renderLeft, 250);
      };
      inp.addEventListener(opts.kind === "check" || opts.kind === "select" ? "change" : "input", apply);
      if (opts.vars && editable && opts.kind !== "check" && opts.kind !== "select") {
        var row = el("div", { "class": "wf-inline" }); row.appendChild(inp); row.appendChild(varMenu(inp, opts.vars, opts.ctx)); box.appendChild(row);
      } else box.appendChild(inp);
      return inp;
    }
    function kvEditor(box, label, obj, key, opts) {
      opts = opts || {};
      box.appendChild(el("label", null, esc(label)));
      var wrap = el("div"); box.appendChild(wrap);
      var data = obj[key] && typeof obj[key] === "object" ? obj[key] : {};
      function paint() {
        wrap.innerHTML = "";
        Object.keys(data).forEach(function (k) {
          var r = el("div", { "class": "wf-kv" });
          var ki = el("input", { value: k, placeholder: "tên" }); var vi = el("input", { placeholder: "giá trị" }); vi.value = typeof data[k] === "string" ? data[k] : JSON.stringify(data[k]);
          var x = el("button", { "class": "ghost sm", type: "button" }, "✕");
          ki.disabled = vi.disabled = x.disabled = !editable;
          ki.onchange = function () { var nk = ki.value.trim(); if (!nk || nk === k) return; data[nk] = data[k]; delete data[k]; obj[key] = data; setDirty(true); paint(); };
          vi.oninput = function () { data[k] = vi.value; obj[key] = data; setDirty(true); clearTimeout(S.rt); S.rt = setTimeout(renderLeft, 300); };
          x.onclick = function () { delete data[k]; if (!Object.keys(data).length) delete obj[key]; else obj[key] = data; setDirty(true); paint(); renderLeft(); };
          r.appendChild(ki);
          if (opts.vars && editable) { var cell = el("div", { "class": "wf-inline" }); cell.appendChild(vi); cell.appendChild(varMenu(vi, opts.vars, opts.ctx)); r.appendChild(cell); } else r.appendChild(vi);
          r.appendChild(x); wrap.appendChild(r);
        });
        if (editable) { var add = el("button", { "class": "ghost sm", type: "button" }, "＋ Thêm"); add.onclick = function () { var n = "ten" + (Object.keys(data).length + 1); data[n] = ""; obj[key] = data; setDirty(true); paint(); }; wrap.appendChild(add); }
      }
      paint();
    }
    // Ô nhập tự sinh từ JSON Schema (tool / MCP)
    function schemaForm(box, schema, args, ctxInfo) {
      var props = (schema && schema.properties) || {};
      var req = (schema && schema.required) || [];
      var keys = Object.keys(props);
      if (!keys.length) { box.appendChild(el("div", { "class": "muted", style: "margin-top:6px" }, "Tool không có tham số.")); return; }
      keys.forEach(function (k) {
        var p = props[k] || {};
        var t = Array.isArray(p.type) ? p.type[0] : p.type;
        var hint = (p.description || "") + (req.indexOf(k) >= 0 ? " (bắt buộc)" : "");
        if (p["enum"]) field(box, k, args, k, { kind: "select", options: [["", "(trống)"]].concat(p["enum"].map(function (v) { return [String(v), String(v)]; })), hint: hint, dropEmpty: true });
        else if (t === "boolean") field(box, k, args, k, { kind: "check", hint: hint });
        else if (t === "object" || t === "array") field(box, k + " (JSON)", args, k, { kind: "json", rows: 3, hint: hint, vars: "secret", ctx: ctxInfo, jsonOrText: true });
        else field(box, k, args, k, { hint: hint, vars: "secret", ctx: ctxInfo, kind: t === "integer" || t === "number" ? "text" : "text", dropEmpty: true, placeholder: p["default"] != null ? "mặc định: " + p["default"] : "" });
      });
    }
    function channelOptions() { return [["", "(chọn kênh)"]].concat((S.cat.channels || []).map(function (c) { return [c.ref, c.ref + (c.running ? "" : " — chưa kết nối")]; })); }
    function chatList(ref) {
      var c = (S.cat.channels || []).filter(function (x) { return x.ref === ref || x.id === ref; })[0];
      return c ? (c.chats || []).map(function (x) { return [x.to, x.title]; }) : [];
    }
    function toHint(ref) { var c = (S.cat.channels || []).filter(function (x) { return x.ref === ref || x.id === ref; })[0]; return c ? c.toHint : "chọn kênh trước"; }

    function renderRight() {
      right.innerHTML = "";
      if (S.runView) { renderRunView(); return; }
      var cardEl = el("div", { "class": "card wf-form" }); right.appendChild(cardEl);
      if (!S.sel) {
        cardEl.innerHTML = "<h3>Chọn một bước để sửa</h3><div class='muted' style='font-size:.85rem;line-height:1.6'>• Kéo thả thẻ để đổi thứ tự hoặc thả vào khối Đúng/Sai/Lặp.<br>• Ô văn bản dùng <code>{{ biểu thức JS }}</code>, nút <b>{ }</b> chèn biến (kết quả bước phía trên, tham số, vòng lặp…).<br>• <b>Chạy thử</b> chạy bản đang sửa (không cần lưu), mặc định không gửi tin thật.<br>• Lỗi khi lưu tô đỏ thẻ bước có vấn đề.</div>";
        return;
      }
      if (S.sel === "__inputs") return renderInputs(cardEl);
      if (S.sel === "__settings") return renderSettings(cardEl);
      if (S.sel.indexOf("__trig") === 0) return renderTrigger(cardEl, Number(S.sel.slice(6)));
      var info = findStepCtx(S.sel);
      if (!info) { cardEl.innerHTML = "<span class='muted'>Bước không còn.</span>"; return; }
      var s = info.step, ty = WF_TYPES[s.type] || ["", s.type];
      cardEl.appendChild(el("h3", null, ty[0] + " " + esc(ty[1]) + " <span class='muted' style='font-size:.75rem'>" + esc(WF_SUMMARY[s.type] || "") + "</span>"));
      var b = cardEl;
      var idInp = field(b, "id (dùng để tham chiếu steps.<id>)", s, "id", { hint: "a-z, 0-9, _" });
      idInp.onchange = function () { S.sel = s.id; renderLeft(); };
      field(b, "Tên hiển thị", s, "name", { dropEmpty: true, placeholder: "(tùy chọn)" });
      var V = { vars: "tpl", ctx: info };
      var E = { vars: "expr", ctx: info };
      switch (s.type) {
        case "http":
          field(b, "Phương thức", s, "method", { kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] });
          field(b, "URL", s, "url", { vars: "secret", ctx: info, placeholder: "https://api.example.com/..." });
          kvEditor(b, "Headers", s, "headers", { vars: "secret", ctx: info });
          kvEditor(b, "Query (?a=b)", s, "query", { vars: "secret", ctx: info });
          field(b, "Kiểu body", s, "bodyType", { kind: "select", options: [["", "tự động (JSON)"], ["json", "JSON"], ["form", "form"], ["text", "text"]], dropEmpty: true });
          field(b, "Body", s, "body", { kind: "json", rows: 5, jsonOrText: true, vars: "secret", ctx: info, hint: "JSON hoặc text; dùng {{ }}" });
          field(b, "Không báo lỗi khi HTTP ≥ 400 (tự kiểm status ở bước sau)", { v: s.failOnStatus === false }, "v", { kind: "check", onChange: function (v) { if (v) s.failOnStatus = false; else delete s.failOnStatus; } });
          b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem;margin-top:4px" }, "Kết quả: <code>steps." + esc(s.id) + ".output.status</code>, <code>.headers</code>, <code>.body</code> (tự đọc JSON)."));
          break;
        case "code":
          field(b, "Mã JavaScript (có return)", s, "code", { kind: "code", rows: 14, hint: "không có fetch/require; dùng steps, inputs, vars, hàm sum/groupBy…" });
          break;
        case "if": field(b, "Điều kiện (JS)", s, "cond", E); break;
        case "while": field(b, "Lặp khi (JS)", s, "cond", E); field(b, "Số vòng tối đa", s, "max", { kind: "number" }); break;
        case "loop":
          field(b, "Lặp qua (biểu thức trả về mảng)", s, "over", E);
          field(b, "Tên biến phần tử", s, "as", { placeholder: "item" });
          field(b, "Số vòng tối đa (≤ 1000)", s, "max", { kind: "number" });
          b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem;margin-top:4px" }, "Trong vòng lặp dùng biến <code>" + esc(s.as || "item") + "</code>, <code>index</code>, <code>loop.first</code>, <code>loop.last</code>; bước <code>break</code> để thoát."));
          break;
        case "switch":
          field(b, "Giá trị để so (JS)", s, "value", E);
          (s.cases || []).forEach(function (c, i) {
            var row = el("div", { "class": "wf-inline", style: "margin-top:6px" });
            var inp = el("input", { placeholder: "giá trị (hoặc để trống và nhập điều kiện JS bên phải)" }); inp.value = c.value == null ? "" : (typeof c.value === "string" ? c.value : JSON.stringify(c.value));
            var w = el("input", { placeholder: "khi (JS, dùng biến value)" }); w.value = c.when || "";
            var x = el("button", { "class": "ghost sm" }, "✕");
            inp.disabled = w.disabled = x.disabled = !editable;
            inp.oninput = function () { c.value = inp.value; setDirty(true); clearTimeout(S.rt); S.rt = setTimeout(renderLeft, 300); };
            w.oninput = function () { if (w.value) c.when = w.value; else delete c.when; setDirty(true); clearTimeout(S.rt); S.rt = setTimeout(renderLeft, 300); };
            x.onclick = function () { s.cases.splice(i, 1); changed(); renderRight(); };
            row.appendChild(el("span", { "class": "muted" }, "#" + (i + 1))); row.appendChild(inp); row.appendChild(w); row.appendChild(x); b.appendChild(row);
          });
          break;
        case "parallel": b.appendChild(el("div", { "class": "muted" }, (s.branches || []).length + " nhánh — thêm/bớt nhánh trên cây bên trái. Kết quả: mảng kết quả bước cuối mỗi nhánh.")); break;
        case "wait": field(b, "Chờ trong", s, "duration", { placeholder: "30s, 5m", dropEmpty: true }); field(b, "Hoặc chờ tới (ISO / biểu thức)", s, "until", { vars: "tpl", ctx: info, dropEmpty: true }); break;
        case "set": kvEditor(b, "Biến (vars.*)", s, "values", V); break;
        case "stop": field(b, "Lý do", s, "reason", V); break;
        case "break": b.appendChild(el("div", { "class": "muted" }, "Thoát vòng lặp gần nhất.")); break;
        case "send":
          field(b, "Kênh", s, "channel", { kind: "select", options: channelOptions(), onChange: function () { renderRight(); } });
          field(b, "Gửi tới (cuộc trò chuyện)", s, "to", { list: chatList(s.channel), hint: toHint(s.channel), vars: "tpl", ctx: info });
          field(b, "Nội dung", s, "text", { kind: "area", rows: 5, vars: "tpl", ctx: info });
          field(b, "File đính kèm (JSON mảng đường dẫn)", s, "files", { kind: "json", rows: 2, jsonOrText: true, dropEmpty: true, hint: "đường dẫn trong thư mục quy trình, vd [\"bao-cao.xlsx\"]" });
          break;
        case "tool": {
          var tools = S.cat.tools || [];
          field(b, "Tool", s, "tool", { kind: "select", options: [["", "(chọn tool)"]].concat(tools.map(function (t) { return [t.name, t.name + (t.custom ? " (custom)" : "")]; })), onChange: function () { s.args = {}; renderRight(); } });
          var tdef = tools.filter(function (t) { return t.name === s.tool; })[0];
          if (tdef) b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem" }, esc(wfShort(tdef.description, 300))));
          field(b, "Chạy bằng agent (thư mục + quyền của agent đó, tùy chọn)", s, "agent", { kind: "select", options: [["", "(không — quyền người sở hữu quy trình)"]].concat((S.cat.agents || []).map(function (a) { return [a.key, a.name + " (" + a.key + ")"]; })), dropEmpty: true });
          s.args = s.args && typeof s.args === "object" ? s.args : {};
          if (tdef) { b.appendChild(el("h4", { style: "margin:12px 0 0" }, "Tham số")); schemaForm(b, tdef.parameters, s.args, info); }
          if (tdef && tdef.requiresApproval) field(b, "✔ Cho phép chạy không cần duyệt (tool này bình thường cần duyệt)", s, "approved", { kind: "check" });
          field(b, "Chạy cả khi chạy thử (tool chỉ đọc, không có tác dụng phụ)", s, "readOnly", { kind: "check" });
          break;
        }
        case "mcp": {
          var srvs = S.cat.mcp || [];
          field(b, "MCP server", s, "server", { kind: "select", options: [["", "(chọn server)"]].concat(srvs.map(function (x) { return [x.serverName, x.serverName]; })), onChange: function () { s.tool = ""; s.args = {}; renderRight(); } });
          var srv = srvs.filter(function (x) { return x.serverName === s.server || x.serverId === s.server; })[0];
          if (!srvs.length) b.appendChild(el("div", { "class": "muted" }, "Chưa có MCP server nào đang kết nối (Dashboard → MCP)."));
          if (srv) {
            field(b, "Tool", s, "tool", { kind: "select", options: [["", "(chọn tool)"]].concat(srv.tools.map(function (t) { return [t.name, t.name]; })), onChange: function () { s.args = {}; renderRight(); } });
            var mt = srv.tools.filter(function (t) { return t.name === s.tool; })[0];
            s.args = s.args && typeof s.args === "object" ? s.args : {};
            if (mt) { b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem" }, esc(wfShort(mt.description, 300)))); b.appendChild(el("h4", { style: "margin:12px 0 0" }, "Tham số")); schemaForm(b, mt.parameters, s.args, info); }
          }
          field(b, "Chạy cả khi chạy thử (tool chỉ đọc)", s, "readOnly", { kind: "check" });
          break;
        }
        case "agent":
          field(b, "Agent", s, "agent", { kind: "select", options: [["", "(chọn agent)"]].concat((S.cat.agents || []).map(function (a) { return [a.key, a.name + " (" + a.key + ")"]; })) });
          field(b, "Tin nhắn / việc giao", s, "message", { kind: "area", rows: 6, vars: "tpl", ctx: info, hint: "agent làm việc với đủ tool của nó" });
          field(b, "Bắt trả lời JSON (dùng steps." + s.id + ".output.json ở bước sau)", s, "json", { kind: "check" });
          b.appendChild(el("h4", { style: "margin:12px 0 0" }, "Gửi câu trả lời thẳng vào chat (tùy chọn)"));
          var dv = s.deliver || {};
          field(b, "Kênh", dv, "channel", { kind: "select", options: channelOptions(), onChange: function () { if (dv.channel) s.deliver = dv; else delete s.deliver; renderRight(); } });
          if (dv.channel) field(b, "Gửi tới", dv, "to", { list: chatList(dv.channel), hint: toHint(dv.channel), vars: "tpl", ctx: info });
          b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem;margin-top:4px" }, "Kết quả: <code>steps." + esc(s.id) + ".output.text</code>. Bước này tốn lượt AI — đặt timeout dài (vd 5m) nếu việc nặng."));
          break;
        case "respond":
          field(b, "Mã HTTP", s, "status", { kind: "number" });
          kvEditor(b, "Headers", s, "headers", V);
          field(b, "Body (JSON hoặc text)", s, "body", { kind: "json", rows: 6, jsonOrText: true, vars: "tpl", ctx: info });
          break;
        case "subworkflow":
          field(b, "Quy trình", s, "workflow", { kind: "select", options: [["", "(chọn)"]].concat((S.cat.workflows || []).filter(function (w) { return w.id !== S.wf.id; }).map(function (w) { return [w.slug, w.name]; })) });
          field(b, "Tham số (JSON)", s, "inputs", { kind: "json", rows: 4, vars: "tpl", ctx: info });
          field(b, "Chờ quy trình con chạy xong", { v: s.wait !== false }, "v", { kind: "check", onChange: function (v) { if (v) delete s.wait; else s.wait = false; } });
          break;
        case "file":
          field(b, "Thao tác", s, "action", { kind: "select", options: [["read", "Đọc"], ["write", "Ghi đè"], ["append", "Ghi thêm"], ["list", "Liệt kê"], ["delete", "Xóa"]], onChange: function () { renderRight(); } });
          field(b, "Đường dẫn (trong thư mục của quy trình)", s, "path", { vars: "tpl", ctx: info, dropEmpty: true });
          if (s.action === "write" || s.action === "append") field(b, "Nội dung", s, "content", { kind: "area", rows: 6, vars: "tpl", ctx: info });
          break;
        case "shell":
          field(b, "Lệnh", s, "command", { kind: "code", rows: 5, vars: "tpl", ctx: info });
          kvEditor(b, "Biến môi trường", s, "env", { vars: "secret", ctx: info });
          field(b, "✔ Cho phép chạy (quản trị viên duyệt lệnh này)", s, "approved", { kind: "check" });
          b.appendChild(el("div", { "class": "muted", style: "font-size:.76rem" }, "Cần máy chủ bật <code>workflows.allowShell: true</code>. Lệnh chạy trong sandbox, thư mục làm việc là thư mục của quy trình."));
          break;
      }
      // chung
      b.appendChild(el("h4", { style: "margin:14px 0 0;font-size:.85rem" }, "Khi lỗi"));
      field(b, "Lỗi thì", s, "onError", { kind: "select", options: [["", "Dừng quy trình"], ["continue", "Bỏ qua, chạy tiếp (steps." + s.id + ".error có lỗi)"]], dropEmpty: true });
      var ry = s.retry || {};
      var syncRetry = function () { if (ry.times) s.retry = ry; else delete s.retry; };
      var rr = el("div", { "class": "row" }); b.appendChild(rr);
      var rb = el("div", { style: "flex:1" }); var rd = el("div", { style: "flex:1" }); var rt = el("div", { style: "flex:1" });
      rr.appendChild(rb); rr.appendChild(rd); rr.appendChild(rt);
      field(rb, "Thử lại (lần)", ry, "times", { kind: "number", onChange: syncRetry });
      field(rd, "Cách nhau", ry, "delay", { placeholder: "10s", dropEmpty: true, onChange: syncRetry });
      field(rt, "Timeout", s, "timeout", { placeholder: "30s", dropEmpty: true });
      field(b, "Ghi chú", s, "note", { kind: "area", rows: 2, dropEmpty: true });
      var lr = S.runMarks && S.runMarks[s.id] || S.last[s.id];
      if (lr) {
        b.appendChild(el("h4", { style: "margin:14px 0 0;font-size:.85rem" }, "Lần chạy gần nhất " + wfPill(lr.status)));
        if (lr.input !== undefined) { b.appendChild(el("div", { "class": "muted", style: "font-size:.74rem" }, "Đầu vào")); b.appendChild(el("pre", { "class": "wf-pre" }, esc(wfJson(lr.input)))); }
        b.appendChild(el("div", { "class": "muted", style: "font-size:.74rem" }, lr.error ? "Lỗi" : "Kết quả (steps." + esc(s.id) + ".output)"));
        b.appendChild(el("pre", { "class": "wf-pre" }, esc(lr.error || wfJson(lr.output))));
      }
    }

    function renderInputs(b) {
      b.innerHTML = "<h3>🧾 Tham số đầu vào (inputs)</h3><div class='muted' style='font-size:.8rem'>Webhook (query + body) và nút Chạy điền vào đây. Dùng <code>{{ inputs.ten }}</code>.</div>";
      var ins = S.draft.inputs = S.draft.inputs || {};
      Object.keys(ins).forEach(function (k) {
        var x = typeof ins[k] === "string" ? (ins[k] = { type: ins[k] }) : ins[k];
        var box = el("div", { style: "border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-top:8px" });
        var hd = el("div", { "class": "wf-inline" }, "<b><code>" + esc(k) + "</code></b>");
        if (editable) { var del = el("button", { "class": "ghost sm" }, "✕"); del.onclick = function () { delete ins[k]; changed(); renderRight(); }; hd.appendChild(del); }
        box.appendChild(hd);
        field(box, "Kiểu", x, "type", { kind: "select", options: ["string", "number", "boolean", "json"] });
        field(box, "Mặc định", x, "default", { kind: "json", rows: 1, jsonOrText: true, dropEmpty: true, hint: "có thể dùng {{ today() }}" });
        field(box, "Bắt buộc", x, "required", { kind: "check" });
        field(box, "Ghi chú", x, "note", { dropEmpty: true });
        b.appendChild(box);
      });
      if (editable) {
        var add = el("button", { "class": "ghost sm", style: "margin-top:10px" }, "＋ Thêm tham số");
        add.onclick = function () { var n = prompt("Tên tham số (chữ không dấu, số, _):", "ngay"); if (!n) return; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { toast("Tên không hợp lệ", 1); return; } ins[n] = { type: "string" }; changed(); renderRight(); };
        b.appendChild(add);
      }
    }
    function renderSettings(b) {
      b.innerHTML = "<h3>⚙ Cài đặt</h3>";
      var st = S.draft.settings = S.draft.settings || {};
      field(b, "Mô tả", S.draft, "description", { kind: "area", rows: 2, dropEmpty: true });
      field(b, "Khi lần chạy trước chưa xong", st, "concurrency", { kind: "select", options: [["", "Mặc định: lịch bỏ lượt trùng, webhook/tay chạy song song"], ["skip", "Luôn bỏ qua lượt mới"], ["queue", "Xếp hàng chạy sau"], ["parallel", "Luôn chạy song song"]], dropEmpty: true });
      field(b, "Trần thời gian một lần chạy (giây)", st, "timeoutSec", { kind: "number" });
      field(b, "Cho agent chạy quy trình này khi người dùng nhờ qua kênh chat (Zalo, Telegram…)", st, "allowFromChat", { kind: "check" });
      b.appendChild(el("h4", { style: "margin:12px 0 0;font-size:.85rem" }, "Báo khi chạy lỗi"));
      var ne = st.notifyOnError || {};
      field(b, "Kênh", ne, "channel", { kind: "select", options: channelOptions(), onChange: function () { if (ne.channel) st.notifyOnError = ne; else delete st.notifyOnError; renderRight(); } });
      if (ne.channel) field(b, "Gửi tới", ne, "to", { list: chatList(ne.channel), hint: toHint(ne.channel) });
      if (state.me && state.me.role === "ws_admin") {
        var ob = el("button", { "class": "ghost sm", style: "margin-top:12px" }, "👤 Đổi người sở hữu (lần chạy mang quyền người này)");
        ob.onclick = function () {
          api("/v1/workflows-owners").then(function (j) {
            var d = wfDlg(460, "<h3 style='margin:0 0 8px'>Người sở hữu</h3><select id='os' style='width:100%'>" + j.users.map(function (u) { return "<option value='" + esc(u.id) + "'" + (u.id === S.wf.ownerUserId ? " selected" : "") + ">" + esc((u.name ? u.name + " — " : "") + u.email) + "</option>"; }).join("") + "</select><div class='dialog-actions'><button class='ghost' id='oc'>Hủy</button><button id='ok'>Lưu</button></div>");
            $("#oc", d).onclick = d.closeNow;
            $("#ok", d).onclick = function () { api("/v1/workflows/" + id, { method: "PATCH", body: { ownerUserId: $("#os", d).value } }).then(function (r) { S.wf = r.workflow; d.closeNow(); toast("Đã đổi người sở hữu"); }).catch(function (e) { toast(e.message, 1); }); };
          }).catch(function (e) { toast(e.message, 1); });
        };
        b.appendChild(ob);
      }
    }
    function renderTrigger(b, i) {
      var t = S.draft.triggers[i]; if (!t) { b.innerHTML = ""; return; }
      b.innerHTML = "<h3>" + esc(wfTrigText(t)) + "</h3>";
      if (t.type === "schedule") {
        if (t.schedule && !t.cron) { t.cron = t.schedule; delete t.schedule; }
        field(b, "Lịch (cron 5 trường hoặc every 2h)", t, "cron", { hint: "phút giờ ngày tháng thứ" });
        b.appendChild(el("div", { "class": "muted", style: "font-size:.78rem;line-height:1.6" }, "<code>0 8 * * *</code> 8:00 hằng ngày · <code>30 17 * * 1-5</code> 17:30 thứ Hai–Sáu · <code>0 9 1 * *</code> 9:00 ngày 1 hằng tháng · <code>*/15 * * * *</code> mỗi 15 phút · <code>every 2h</code> mỗi 2 giờ"));
        field(b, "Múi giờ", t, "timezone", { placeholder: "mặc định của hệ thống (Asia/Ho_Chi_Minh)", dropEmpty: true });
        if (S.wf.nextRunAt) b.appendChild(el("div", { "class": "muted", style: "margin-top:8px" }, "Lần chạy kế (bản đã lưu): " + esc(fmtTime(S.wf.nextRunAt))));
      } else if (t.type === "webhook") {
        var wh = S.wf.webhook;
        if (wh) {
          var u = el("div", { style: "margin-top:4px" });
          u.innerHTML = "<label>Link webhook</label><div class='wf-inline'><input readonly value='" + esc(wh.url) + "'><button class='ghost sm' id='cpu'>Copy</button></div>";
          b.appendChild(u);
          $("#cpu", u).onclick = function () { copyText(wh.url); toast("Đã copy"); };
          var curl = "curl -X POST '" + wh.url + "' -H 'content-type: application/json' -d '{\"ten\":\"An\"}'";
          b.appendChild(el("label", null, "Lệnh thử")); var pre = el("pre", { "class": "wf-pre" }); pre.textContent = curl; b.appendChild(pre);
          if (editable) {
            var rot = el("button", { "class": "ghost sm" }, "🔄 Đổi link (link cũ hết hiệu lực)");
            rot.onclick = function () { if (confirm("Đổi link webhook? Hệ thống đang gọi link cũ sẽ bị từ chối.")) api("/v1/workflows/" + id + "/webhook/rotate", { method: "POST" }).then(function (r) { S.wf = r.workflow; renderRight(); toast("Đã đổi link"); }).catch(function (e) { toast(e.message, 1); }); };
            b.appendChild(rot);
          }
        } else b.appendChild(el("div", { "class": "muted" }, "Lưu quy trình để có link webhook."));
        var mt0 = { v: (t.methods && t.methods.length === 1) ? t.methods[0] : "POST,GET" };
        field(b, "Phương thức nhận", mt0, "v", { kind: "select", options: [["POST,GET", "POST và GET"], ["POST", "Chỉ POST"], ["GET", "Chỉ GET"]], onChange: function (v) { t.methods = String(v).split(","); } });
        field(b, "Trả về cho bên gọi", t, "respond", { kind: "select", options: [["async", "Ngay lập tức: 202 + runId (tra kết quả sau)"], ["wait", "Chờ kết quả (bước respond hoặc kết quả bước cuối)"]] });
        field(b, "Chờ tối đa (giây, ≤ 120)", t, "timeoutSec", { kind: "number" });
        field(b, "Xác thực", t, "auth", { kind: "select", options: [["token", "Token trong link (mặc định)"], ["hmac", "Thêm chữ ký HMAC (x-penai-signature)"]], onChange: function () { renderRight(); } });
        if (t.auth === "hmac" && wh) {
          var hs = el("div", { "class": "muted", style: "font-size:.78rem;line-height:1.6;margin-top:6px" });
          hs.innerHTML = "Ký: <code>x-penai-timestamp</code> = mili giây hiện tại, <code>x-penai-nonce</code> = chuỗi ngẫu nhiên mỗi lần, <code>x-penai-signature</code> = hex HMAC-SHA256(khóa, timestamp + \".\" + body thô). Khóa: <input readonly type='password' value='" + esc(wh.hmacSecret) + "' style='width:100%;margin-top:4px' id='hsk'> <button class='ghost sm' id='hsv'>Hiện</button>";
          b.appendChild(hs); $("#hsv", hs).onclick = function () { var k = $("#hsk", hs); k.type = k.type === "password" ? "text" : "password"; };
        }
        field(b, "Giới hạn gọi mỗi phút", t, "rateLimit", { kind: "number" });
      } else if (t.type === "manual") {
        b.appendChild(el("div", { "class": "muted" }, "Chạy bằng nút ▶ Chạy trên Dashboard, tool workflow_run của agent, API POST /v1/workflows/" + esc(id) + "/run, hoặc MCP."));
      }
    }

    // ----- kết quả chạy -----
    function showRun(run, steps) {
      if (!run) return;
      var marks = {};
      (steps || []).forEach(function (s) { marks[s.stepId] = { status: s.status, output: s.output, error: s.error, input: s.input, durationMs: s.durationMs }; });
      S.runMarks = marks; S.runView = { run: run, steps: steps || [] };
      renderLeft(); renderRight();
    }
    function renderRunView() {
      var rv = S.runView, run = rv.run;
      var c = el("div", { "class": "card" }); right.appendChild(c);
      var hd = el("div", { "class": "wf-inline" }, "<h3 style='margin:0;flex:1'>Lần chạy " + wfPill(run.status) + (run.dryRun ? " <span class='pill run'>dry run</span>" : "") + (run.isTest ? " <span class='pill'>thử</span>" : "") + "</h3>");
      var x = el("button", { "class": "ghost sm" }, "✕ Đóng"); x.onclick = function () { S.runView = null; S.runMarks = null; renderLeft(); renderRight(); }; hd.appendChild(x);
      c.appendChild(hd);
      c.appendChild(el("div", { "class": "muted", style: "font-size:.78rem;margin:4px 0 8px" }, esc(fmtTime(run.startedAt)) + " · " + esc(run.triggerType) + (run.durationMs != null ? " · " + run.durationMs + "ms" : "") + " · " + (run.stepCount || 0) + " bước · runId <code>" + esc(run.id) + "</code>"));
      if (run.status === "running") {
        var rf = el("button", { "class": "ghost sm" }, "↻ Tải lại"); rf.onclick = function () { api("/v1/workflows/" + id + "/runs/" + run.id).then(function (j) { showRun(j.run, j.steps); }); };
        var cc = el("button", { "class": "ghost sm" }, "■ Hủy"); cc.onclick = function () { api("/v1/workflows/" + id + "/runs/" + run.id + "/cancel", { method: "POST" }).then(function () { toast("Đã gửi lệnh hủy"); }); };
        c.appendChild(rf); c.appendChild(cc);
      }
      if (run.error) c.appendChild(el("div", { "class": "wf-issues" }, esc(run.error)));
      if (run.response) { c.appendChild(el("div", { "class": "muted", style: "font-size:.74rem" }, "Trả về webhook")); c.appendChild(el("pre", { "class": "wf-pre" }, esc(wfJson(run.response)))); }
      if (run.output != null && !run.response) { c.appendChild(el("div", { "class": "muted", style: "font-size:.74rem" }, "Kết quả")); c.appendChild(el("pre", { "class": "wf-pre" }, esc(wfJson(run.output)))); }
      var list = el("div", { style: "margin-top:8px" }); c.appendChild(list);
      var detail = el("div"); c.appendChild(detail);
      rv.steps.forEach(function (s) {
        var r = el("div", { "class": "wf-run-step" }, wfPill(s.status) + " <code>" + esc(s.stepId) + "</code>" + (s.iteration != null ? " <span class='muted'>#" + s.iteration + "</span>" : "") + " <span class='muted'>" + esc((WF_TYPES[s.type] || ["", s.type])[1]) + (s.durationMs ? " · " + s.durationMs + "ms" : "") + (s.attempts > 1 ? " · " + s.attempts + " lần" : "") + "</span>" +
          (s.error ? "<div class='err' style='font-size:.76rem'>" + esc(wfShort(s.error, 200)) + "</div>" : ""));
        r.onclick = function () {
          detail.innerHTML = "<h4 style='margin:10px 0 4px'>" + esc(s.path) + "</h4><div class='muted' style='font-size:.74rem'>Đầu vào</div><pre class='wf-pre'>" + esc(wfJson(s.input)) + "</pre><div class='muted' style='font-size:.74rem'>" + (s.error ? "Lỗi" : "Kết quả") + "</div><pre class='wf-pre'>" + esc(s.error || wfJson(s.output)) + "</pre>";
          S.sel = s.stepId; renderLeft();
        };
        list.appendChild(r);
      });
      if (!rv.steps.length) list.appendChild(el("div", { "class": "muted" }, "Không có bước nào chạy."));
    }

    function openHistory() {
      var d = wfDlg(820, "<h3 style='margin:0 0 6px'>🕘 Lịch sử chạy</h3><div class='row' style='margin-bottom:8px'><select id='hf'><option value=''>Mọi trạng thái</option><option value='failed'>Lỗi</option><option value='success'>Xong</option><option value='timeout'>Quá giờ</option><option value='stopped'>Dừng</option><option value='running'>Đang chạy</option></select></div><div id='hl' style='max-height:62vh;overflow:auto'></div><div class='dialog-actions'><button class='ghost' id='hc'>Đóng</button></div>");
      $("#hc", d).onclick = d.closeNow;
      function load() {
        var f = $("#hf", d).value;
        api("/v1/workflows/" + id + "/runs?limit=100" + (f ? "&status=" + f : "")).then(function (j) {
          var box = $("#hl", d); box.innerHTML = "";
          box.appendChild(table(["Bắt đầu", "Kích hoạt", "Trạng thái", "Thời gian", "Lỗi", ""], j.runs, function (r) {
            var tr = el("tr");
            tr.innerHTML = "<td style='font-size:.8rem'>" + esc(fmtTime(r.startedAt)) + "</td><td style='font-size:.8rem'>" + esc(r.triggerType) + (r.isTest ? " (thử)" : "") + (r.dryRun ? " dry" : "") + "</td><td>" + wfPill(r.status) + "</td><td class='muted' style='font-size:.78rem'>" + (r.durationMs != null ? r.durationMs + "ms" : "") + "</td><td class='err' style='font-size:.76rem'>" + esc(wfShort(r.error || "", 100)) + "</td>";
            var td = el("td"); var b = el("button", { "class": "ghost sm" }, "Xem");
            b.onclick = function () { api("/v1/workflows/" + id + "/runs/" + r.id).then(function (x) { d.closeNow(); showRun(x.run, x.steps); }).catch(function (e) { toast(e.message, 1); }); };
            td.appendChild(b); tr.appendChild(td); return tr;
          }));
        }).catch(function (e) { $("#hl", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      }
      $("#hf", d).onchange = load; load();
    }
    function openVersions() {
      var d = wfDlg(820, "<h3 style='margin:0 0 6px'>🗂 Phiên bản</h3><div class='muted' style='margin-bottom:8px'>Mỗi lần lưu (người, agent, API, MCP) là một bản; giữ 50 bản gần nhất.</div><div id='vl' style='max-height:40vh;overflow:auto'></div><div id='vd'></div><div class='dialog-actions'><button class='ghost' id='vc'>Đóng</button></div>");
      $("#vc", d).onclick = d.closeNow;
      var VIA = { agent: "🤖 agent", mcp: "🔗 AI ngoài (MCP)", api: "🔑 API", dashboard: "👤 Dashboard", restore: "↩ hoàn về", template: "📋 mẫu", "import": "⬆ nhập" };
      api("/v1/workflows/" + id + "/versions").then(function (j) {
        $("#vl", d).appendChild(table(["Bản", "Thời điểm", "Bởi", "Ghi chú", ""], j.versions, function (v) {
          var tr = el("tr");
          tr.innerHTML = "<td><b>" + v.version + "</b>" + (v.version === S.wf.version ? " <span class='pill ok'>hiện tại</span>" : "") + "</td><td style='font-size:.8rem'>" + esc(fmtTime(v.createdAt)) + "</td><td style='font-size:.8rem'>" + esc(VIA[v.changeVia] || v.changeVia) + "</td><td style='font-size:.8rem'>" + esc(v.changeNote || "") + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          var see = el("button", { "class": "ghost sm" }, "Xem");
          see.onclick = function () {
            api("/v1/workflows/" + id + "/versions/" + v.version).then(function (x) {
              var a = {}, bb = {};
              allSteps(x.version.definition.steps || []).forEach(function (q) { a[q.step.id] = JSON.stringify(q.step); });
              allSteps(S.wf.definition.steps || []).forEach(function (q) { bb[q.step.id] = JSON.stringify(q.step); });
              var diff = [];
              Object.keys(bb).forEach(function (k) { if (!(k in a)) diff.push("<span class='ok'>+ " + esc(k) + "</span> (bản hiện tại có, bản " + v.version + " không)"); else if (a[k] !== bb[k]) diff.push("~ " + esc(k) + " khác"); });
              Object.keys(a).forEach(function (k) { if (!(k in bb)) diff.push("<span class='err'>− " + esc(k) + "</span> (chỉ có ở bản " + v.version + ")"); });
              $("#vd", d).innerHTML = "<h4 style='margin:10px 0 4px'>Bản " + v.version + " so với bản hiện tại</h4><div style='font-size:.82rem'>" + (diff.length ? diff.join("<br>") : "Các bước giống nhau") + "</div><pre class='wf-pre' style='max-height:240px'>" + esc(wfJson(x.version.definition)) + "</pre>";
            }).catch(function (e) { toast(e.message, 1); });
          };
          td.appendChild(see);
          if (editable && v.version !== S.wf.version) {
            var rs = el("button", { "class": "ghost sm" }, "↩ Hoàn về");
            rs.onclick = function () {
              if (!confirm("Hoàn về bản " + v.version + "? (tạo bản mới, không mất lịch sử)")) return;
              api("/v1/workflows/" + id + "/versions/" + v.version + "/restore", { method: "POST" }).then(function () { d.closeNow(); toast("Đã hoàn về bản " + v.version); load(); }).catch(function (e) { toast(e.message, 1); });
            };
            td.appendChild(document.createTextNode(" ")); td.appendChild(rs);
          }
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { $("#vl", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    function openJson() {
      var d = wfDlg(860, "<h3 style='margin:0 0 6px'>{ } JSON của quy trình</h3><div class='muted' style='margin-bottom:6px'>Sửa trực tiếp (cho người kỹ thuật). Áp dụng → thay bản đang sửa trên màn hình, rồi bấm Lưu.</div><textarea id='jt' class='wf-json' rows='24' style='width:100%'></textarea><div id='je'></div><div class='dialog-actions'><button class='ghost' id='jcp'>Copy</button><button class='ghost' id='jc'>Đóng</button>" + (editable ? "<button id='ja'>Áp dụng</button>" : "") + "</div>");
      $("#jt", d).value = wfJson(S.draft);
      $("#jc", d).onclick = d.closeNow;
      $("#jcp", d).onclick = function () { copyText($("#jt", d).value); toast("Đã copy"); };
      if (editable) $("#ja", d).onclick = function () {
        var v; try { v = JSON.parse($("#jt", d).value); } catch (e) { $("#je", d).innerHTML = '<div class="err">JSON không hợp lệ: ' + esc(e.message) + "</div>"; return; }
        api("/v1/workflows/validate", { method: "POST", body: { definition: v } }).then(function (r) {
          S.draft = v; S.issues = r.errors || []; S.warnings = r.warnings || []; setDirty(true); renderTop(); renderIssues(); renderLeft(); renderRight(); d.closeNow();
          if (S.issues.length) toast("Đã áp dụng — còn lỗi cần sửa trước khi lưu", 1);
        }).catch(function (e) { $("#je", d).innerHTML = '<div class="err">' + esc(e.message) + "</div>"; });
      };
    }
    load();
  }
`;
