/**
 * Dashboard → 💬 Chat (làm lại 1.17.0): cột "cuộc trò chuyện" bên trái kiểu ChatGPT/Claude
 * (＋ Cuộc mới, tìm, nhóm theo ngày, đổi tên, xóa), khung chat giữa màn hình, ô nhập tự giãn,
 * cuộn mượt (chỉ bám đáy khi đang ở đáy, vẽ lại theo khung hình khi AI đang trả lời), dừng
 * trả lời, tự focus ô nhập. Trên điện thoại cột trái thành ngăn kéo (nút ☰ trong thanh chat).
 *
 * JavaScript thuần, ghép vào bên trong IIFE của ui.ts (dùng chung el, $, esc, api, page, toast,
 * state, md, splitBotText, splitUserText, fileChip, fileCard, fileIcon, fmtSize, IMG_RE, isMember).
 * Viết bằng String.raw: KHÔNG dùng dấu backtick và chuỗi "$" + "{" trong khối này.
 */
export const CHAT_UI = String.raw`
  // ===================== 💬 Chat =====================
  (function cxStyles() {
    var css = [
      ".cx{flex:1;min-height:0;display:flex;position:relative;border-top:1px solid var(--border)}",
      ".cx-side{width:268px;flex-shrink:0;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--border);min-height:0}",
      ".cx-side-top{padding:10px 10px 6px;display:flex;flex-direction:column;gap:8px}",
      ".cx-new{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 10px;border-radius:10px}",
      ".cx-search{width:100%;padding:7px 10px;font-size:.86rem}",
      ".cx-all{display:flex;align-items:center;gap:6px;margin:0;font-size:.74rem;opacity:.7;cursor:pointer}.cx-all input{width:auto;padding:0}",
      ".cx-list{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:2px 6px 12px}",
      ".cx-grp{font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;opacity:.5;padding:12px 8px 4px}",
      ".cx-item{display:flex;align-items:center;gap:4px;padding:8px 8px;border-radius:9px;cursor:pointer;font-size:.88rem;position:relative}",
      ".cx-item:hover{background:rgba(128,128,128,.12)}.cx-item.on{background:rgba(128,128,128,.2)}",
      ".cx-item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-item .a{font-size:.7rem;opacity:.55;white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis}",
      ".cx-item .mn{opacity:0;background:transparent;border:0;color:inherit;padding:2px 6px;font-size:1rem;line-height:1}",
      ".cx-item:hover .mn,.cx-item.on .mn{opacity:.7}",
      ".cx-pop{position:absolute;right:6px;top:100%;z-index:30;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px #0004;padding:4px;min-width:150px}",
      ".cx-pop div{padding:8px 10px;border-radius:7px;font-size:.86rem;cursor:pointer}.cx-pop div:hover{background:rgba(128,128,128,.14)}",
      ".cx-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;position:relative}",
      ".cx-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);min-height:48px}",
      ".cx-head .ttl{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-head select{max-width:240px;padding:5px 8px;font-size:.84rem}",
      ".cx-menu{display:none;background:transparent;border:1px solid var(--border);color:inherit;padding:5px 10px;font-size:1rem}",
      "#log.cx-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:16px max(16px,calc((100% - 820px) / 2)) 8px;display:flex;flex-direction:column;gap:12px}",
      ".cx-log .msg.user{max-width:min(620px,85%);border-radius:18px 18px 4px 18px}",
      ".cx-log .msg.bot{background:transparent;padding:2px;max-width:100%;align-self:stretch}",
      ".cx-log .msg.tool{max-width:100%;font-size:.72rem;padding:4px 10px;border-radius:8px}",
      ".cx-log .files{max-width:100%}",
      ".cx-typing::after{content:'';display:inline-block;width:1.4em;text-align:left;animation:cxDots 1.2s steps(4,end) infinite}",
      "@keyframes cxDots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}",
      ".cx-acts{display:flex;gap:4px;margin-top:4px;opacity:.55}.cx-acts button{background:transparent;border:0;color:inherit;padding:2px 6px;font-size:.78rem}",
      ".cx-acts button:hover{opacity:1;background:rgba(128,128,128,.14)}",
      ".cx-empty{margin:auto;text-align:center;opacity:.85;padding:20px}.cx-empty h3{font-size:1.35rem;margin:0 0 6px}.cx-empty .muted{max-width:420px;margin:0 auto}",
      ".cx-sugg{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px}",
      ".cx-sugg button{background:transparent;border:1px solid var(--border);color:inherit;font-weight:400;font-size:.84rem;border-radius:999px;padding:7px 12px}",
      ".cx-down{position:absolute;left:50%;transform:translateX(-50%);bottom:96px;z-index:5;width:36px;height:36px;border-radius:50%;padding:0;background:var(--card);color:inherit;border:1px solid var(--border);box-shadow:0 4px 14px #0003;font-size:1.05rem}",
      ".cx-down[hidden]{display:none}",
      ".cx-compose{padding:8px 12px 12px;padding-bottom:max(12px,env(safe-area-inset-bottom))}",
      ".cx-box{max-width:820px;margin:0 auto;border:1px solid var(--border);border-radius:18px;background:var(--card);padding:6px 6px 6px 8px;display:flex;align-items:flex-end;gap:6px;box-shadow:0 2px 12px #0000000f}",
      ".cx-box:focus-within{border-color:var(--accent2)}",
      ".cx-box textarea{flex:1;border:0;background:transparent;resize:none;outline:none;padding:8px 4px;max-height:200px;line-height:1.45;min-height:40px}",
      ".cx-box textarea:focus{outline:none}",
      ".cx-box .clip{background:transparent;border:0;color:inherit;font-size:1.15rem;padding:8px;opacity:.7}",
      ".cx-send{width:38px;height:38px;border-radius:50%;padding:0;font-size:1.05rem;flex-shrink:0;display:flex;align-items:center;justify-content:center}",
      ".cx-hint{max-width:820px;margin:4px auto 0;font-size:.7rem;opacity:.45;text-align:center}",
      ".cx-compose #pend{max-width:820px;margin:0 auto;padding:0 0 6px}",
      ".cx-back{display:none}",
      "@media (max-width:760px){",
      "  .cx{border-top:0}",
      "  .cx-side{position:absolute;z-index:20;top:0;bottom:0;left:0;width:84%;max-width:320px;transform:translateX(-105%);transition:transform .22s ease;box-shadow:0 0 40px #0005}",
      "  .cx.side-open .cx-side{transform:none}",
      "  .cx.side-open .cx-back{display:block;position:absolute;inset:0;z-index:15;background:#0006}",
      "  .cx-menu{display:inline-flex}",
      "  .cx-item .mn{opacity:.6}",
      "  .cx-head{padding:6px 8px;min-height:44px}.cx-head select{max-width:42vw}",
      "  #log.cx-log{padding:12px 10px 6px;gap:10px}",
      "  .cx-log .msg.user{max-width:88%}",
      "  .cx-compose{padding:6px 8px 8px;padding-bottom:max(8px,env(safe-area-inset-bottom))}",
      "  .cx-hint{display:none}",
      "  .cx-down{bottom:80px}",
      "}"
    ].join("\n");
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  })();

  // Màn hình cảm ứng: Enter xuống dòng, gửi bằng nút (như Messenger/Zalo). Máy tính: Enter gửi, Shift+Enter xuống dòng.
  function cxTouch() { try { return window.matchMedia("(pointer: coarse)").matches; } catch (e) { return false; } }
  // Ô nhập tự giãn theo nội dung (tối đa ~8 dòng)
  function cxGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; }
  // Focus không làm trang nhảy
  function cxFocus(inp) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }

  PAGES.chat = function () {
    var m = $("#main"); m.innerHTML = ""; m.className = "fill";
    if (!state.agents.length) {
      m.className = "";
      page("Chat", null);
      $("#main").appendChild(el("div", { "class": "card" }, isMember()
        ? "<b>Bạn chưa được gán trợ lý AI nào.</b> Hãy liên hệ quản trị viên để được cấp quyền chat."
        : "<b>Chưa có agent nào.</b> Tạo agent trong mục Agents trước."));
      return;
    }
    var C = { sessions: [], showAll: false, q: "", sessionId: null, agentKey: null, busy: false, ctrl: null };
    try { C.showAll = localStorage.getItem("penai_cx_all") === "1"; C.agentKey = localStorage.getItem("penai_cx_agent"); } catch (e) {}
    if (!state.agents.some(function (a) { return a.key === C.agentKey; })) C.agentKey = state.agents[0].key;

    var root = el("div", { "class": "cx" });
    root.innerHTML =
      '<aside class="cx-side"><div class="cx-side-top"><button class="cx-new" id="cxNew">＋ Cuộc trò chuyện mới</button>' +
      '<input class="cx-search" id="cxQ" placeholder="Tìm cuộc trò chuyện…" autocomplete="off">' +
      (isMember() ? "" : '<label class="cx-all"><input type="checkbox" id="cxAll"> Hiện cả phiên của người khác, kênh chat, quy trình</label>') +
      '</div><div class="cx-list" id="cxList"></div></aside><div class="cx-back" id="cxBack"></div>' +
      '<section class="cx-main"><div class="cx-head"><button class="cx-menu" id="cxMenu" title="Các cuộc trò chuyện" aria-label="Các cuộc trò chuyện">☰</button><div class="ttl" id="cxTitle">Cuộc trò chuyện mới</div><select id="cxAgent" title="Trợ lý"></select></div>' +
      '<div class="cx-log" id="log"></div><button class="cx-down" id="cxDown" hidden title="Xuống tin mới nhất">↓</button>' +
      '<div class="cx-compose"><div id="pend"></div><div class="cx-box"><button class="clip" type="button" id="cxClip" title="Đính kèm ảnh / file (hoặc dán, kéo thả)">📎</button>' +
      '<input type="file" id="cxFile" multiple style="display:none" accept="image/*,.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.md,.csv,.json,.zip">' +
      '<textarea id="msg" rows="1" placeholder="Nhắn cho trợ lý…" enterkeyhint="send"></textarea><button class="cx-send" id="cxSend" title="Gửi" aria-label="Gửi">➤</button></div>' +
      '<div class="cx-hint" id="cxHint"></div></div></section>';
    m.appendChild(root);
    var log = $("#log", root), inp = $("#msg", root), sendBtn = $("#cxSend", root), agentSel = $("#cxAgent", root), pend = $("#pend", root), down = $("#cxDown", root);
    $("#cxHint", root).textContent = cxTouch() ? "" : "Enter để gửi · Shift+Enter xuống dòng · dán hoặc kéo thả ảnh/file vào đây";
    state.agents.forEach(function (a) { agentSel.appendChild(el("option", { value: a.key }, esc(isMember() ? a.name : a.name + " · " + a.model))); });
    agentSel.value = C.agentKey;
    if (state.agents.length < 2) agentSel.style.display = "none";

    function agentById(id) { for (var i = 0; i < state.agents.length; i++) if (state.agents[i].id === id) return state.agents[i]; return null; }
    function myId() { return state.me && state.me.user ? state.me.user.id : null; }
    function setSide(open) { root.classList.toggle("side-open", !!open); }
    $("#cxMenu", root).onclick = function () { setSide(!root.classList.contains("side-open")); };
    $("#cxBack", root).onclick = function () { setSide(false); };

    // ----- cuộn: chỉ bám đáy khi người dùng đang ở đáy -----
    var stick = true, raf = 0;
    function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
    log.addEventListener("scroll", function () { stick = nearBottom(); down.hidden = stick; }, { passive: true });
    function toBottom(force) { if (force) stick = true; if (stick) { log.scrollTop = log.scrollHeight; down.hidden = true; } }
    down.onclick = function () { toBottom(true); };
    // Bàn phím ảo mở/đóng làm khung nhỏ lại → giữ tin cuối trong tầm mắt
    var onVv = function () { if (stick) log.scrollTop = log.scrollHeight; };
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onVv);
    var prevCleanup = state.pageCleanup;
    state.pageCleanup = function () { if (window.visualViewport) window.visualViewport.removeEventListener("resize", onVv); if (C.ctrl) try { C.ctrl.abort(); } catch (e) {} if (prevCleanup) prevCleanup(); };

    // ----- danh sách cuộc trò chuyện -----
    function dayGroup(d) {
      var t = new Date(d), now = new Date();
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      var x = t.getTime();
      if (x >= start) return "Hôm nay";
      if (x >= start - 86400000) return "Hôm qua";
      if (x >= start - 7 * 86400000) return "7 ngày qua";
      if (x >= start - 30 * 86400000) return "30 ngày qua";
      return "Cũ hơn";
    }
    function visibleSessions() {
      var me = myId(), q = C.q.toLowerCase();
      return C.sessions.filter(function (s) {
        if (!agentById(s.agentId)) return false;
        if (!isMember() && !C.showAll && s.ownerUserId !== me) return false;
        if (q && String(s.title || "").toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function renderList() {
      var box = $("#cxList", root); box.innerHTML = "";
      var list = visibleSessions(), last = "";
      if (!list.length) { box.appendChild(el("div", { "class": "muted", style: "padding:14px 8px;font-size:.82rem" }, C.q ? "Không tìm thấy." : "Chưa có cuộc trò chuyện nào.")); return; }
      list.slice(0, 300).forEach(function (s) {
        var g = dayGroup(s.updatedAt || s.createdAt);
        if (g !== last) { box.appendChild(el("div", { "class": "cx-grp" }, g)); last = g; }
        var a = agentById(s.agentId);
        var it = el("div", { "class": "cx-item" + (s.id === C.sessionId ? " on" : ""), title: s.title || "" });
        it.innerHTML = '<span class="t">' + esc(s.title || "Cuộc trò chuyện") + "</span>" + (state.agents.length > 1 ? '<span class="a">' + esc(a ? a.name : "") + "</span>" : "") + '<button class="mn" type="button" title="Đổi tên / xóa">⋯</button>';
        it.onclick = function () { openSession(s.id); };
        it.querySelector(".mn").onclick = function (e) { e.stopPropagation(); itemMenu(it, s); };
        box.appendChild(it);
      });
    }
    function itemMenu(it, s) {
      var old = document.querySelector(".cx-pop"); if (old) old.remove();
      var p = el("div", { "class": "cx-pop" });
      var r = el("div", null, "✏️ Đổi tên"), d = el("div", { style: "color:#ef4444" }, "🗑 Xóa");
      r.onclick = function (e) {
        e.stopPropagation(); p.remove();
        var v = prompt("Tên cuộc trò chuyện:", s.title || ""); if (!v || !v.trim()) return;
        api("/v1/sessions/" + s.id, { method: "PATCH", body: { title: v.trim() } }).then(function () { s.title = v.trim(); renderList(); if (s.id === C.sessionId) setTitle(s.title); }).catch(function (er) { toast(er.message, true); });
      };
      d.onclick = function (e) {
        e.stopPropagation(); p.remove();
        if (!confirm("Xóa cuộc trò chuyện \"" + (s.title || "") + "\"? Không khôi phục được.")) return;
        api("/v1/sessions/" + s.id, { method: "DELETE" }).then(function () {
          C.sessions = C.sessions.filter(function (x) { return x.id !== s.id; });
          if (s.id === C.sessionId) newChat(); else renderList();
        }).catch(function (er) { toast(er.message, true); });
      };
      p.appendChild(r); p.appendChild(d); it.appendChild(p);
      setTimeout(function () { document.addEventListener("click", function h() { p.remove(); document.removeEventListener("click", h); }); }, 0);
    }
    function loadList() {
      return api("/v1/sessions").then(function (j) { C.sessions = j.sessions || []; renderList(); }).catch(function () {});
    }
    $("#cxQ", root).oninput = function () { C.q = this.value.trim(); renderList(); };
    if ($("#cxAll", root)) { $("#cxAll", root).checked = C.showAll; $("#cxAll", root).onchange = function () { C.showAll = this.checked; try { localStorage.setItem("penai_cx_all", C.showAll ? "1" : "0"); } catch (e) {} renderList(); }; }

    function setTitle(t) { $("#cxTitle", root).textContent = t || "Cuộc trò chuyện mới"; }
    function setHash(id) { var h = "#/chat" + (id ? "/" + id : ""); if (location.hash !== h) history.replaceState(null, "", h); }

    function emptyState() {
      var a = null; for (var i = 0; i < state.agents.length; i++) if (state.agents[i].key === agentSel.value) a = state.agents[i];
      var box = el("div", { "class": "cx-empty" });
      box.innerHTML = "<h3>Bạn cần gì hôm nay?</h3><div class='muted'>" + esc(a ? "Đang trò chuyện với " + a.name + "." : "") + " Gửi câu hỏi, dán ảnh hoặc đính kèm file để trợ lý xử lý.</div>";
      var sg = el("div", { "class": "cx-sugg" });
      ["Tóm tắt giúp tôi tài liệu này", "Soạn tin nhắn trả lời khách", "Lập kế hoạch công việc tuần này"].forEach(function (t) {
        var b = el("button", { type: "button" }, esc(t)); b.onclick = function () { inp.value = t + ": "; cxGrow(inp); cxFocus(inp); }; sg.appendChild(b);
      });
      box.appendChild(sg); log.appendChild(box);
    }
    function newChat() {
      if (C.ctrl) try { C.ctrl.abort(); } catch (e) {}
      C.sessionId = null; state.sessionId = null; log.innerHTML = ""; setTitle(""); setHash(null);
      emptyState(); renderList(); setSide(false); cxFocus(inp);
    }
    $("#cxNew", root).onclick = newChat;
    agentSel.onchange = function () {
      C.agentKey = agentSel.value; try { localStorage.setItem("penai_cx_agent", C.agentKey); } catch (e) {}
      if (C.sessionId) { newChat(); toast("Cuộc trò chuyện mới với trợ lý vừa chọn"); }
      else { log.innerHTML = ""; emptyState(); cxFocus(inp); }
    };

    function openSession(id) {
      if (C.ctrl) try { C.ctrl.abort(); } catch (e) {}
      C.sessionId = id; state.sessionId = id; setHash(id); setSide(false);
      var s = C.sessions.filter(function (x) { return x.id === id; })[0];
      var a = s ? agentById(s.agentId) : null;
      if (a) { agentSel.value = a.key; C.agentKey = a.key; }
      setTitle(s ? s.title : ""); renderList();
      log.innerHTML = '<div class="muted" style="text-align:center;padding:20px">Đang tải…</div>';
      api("/v1/sessions/" + id + "/messages").then(function (j) {
        if (C.sessionId !== id) return;
        log.innerHTML = "";
        var frag = document.createDocumentFragment();
        (j.messages || []).forEach(function (msg) {
          var c = msg.content || {};
          if (msg.role === "user" && c.kind === "text") {
            var su = splitUserText(c.text);
            if (su.text || su.names.length) {
              var ud = mkMsg("user", su.text || "");
              if (su.names.length) { var ua = el("div", { "class": "atts" }); ua.innerHTML = su.names.map(function (n) { return fileChip(n, IMG_RE.test(n)); }).join(""); ud.appendChild(ua); }
              frag.appendChild(ud);
            }
          } else if (msg.role === "assistant" && c.text) {
            var sb = splitBotText(c.text);
            if (sb.files.length) { var fd = el("div", { "class": "files" }); fd.innerHTML = sb.files.map(fileCard).join(""); frag.appendChild(fd); }
            else if (sb.text) { var bd = mkMsg("bot", sb.text); addActs(bd, sb.text); frag.appendChild(bd); }
          }
        });
        log.appendChild(frag);
        if (!log.children.length) emptyState();
        toBottom(true);
        cxFocus(inp);
      }).catch(function (e) { log.innerHTML = '<div class="err" style="padding:16px">' + esc(e.message) + "</div>"; });
    }

    // ----- tin nhắn -----
    function mkMsg(kind, text) { var d = el("div", { "class": "msg " + kind }); if (kind === "bot") d.innerHTML = md(splitBotText(text).text); else d.textContent = text; return d; }
    function showMsg(kind, text) { var e = log.querySelector(".cx-empty"); if (e) e.remove(); var d = mkMsg(kind, text); log.appendChild(d); toBottom(kind === "user"); return d; }
    function addActs(d, text) {
      var a = el("div", { "class": "cx-acts" });
      var cp = el("button", { type: "button", title: "Sao chép" }, "⧉ Sao chép");
      cp.onclick = function () { copyText(text); toast("Đã sao chép"); };
      a.appendChild(cp); d.appendChild(a);
    }

    // ----- file đính kèm chờ gửi -----
    var pending = [];
    function addPending(file) {
      if (!file) return;
      if (pending.length >= 10) { toast("Tối đa 10 file mỗi tin", true); return; }
      if (file.size > 100 * 1024 * 1024) { toast(file.name + ": vượt 100MB", true); return; }
      if (pending.reduce(function (n, it) { return n + it.file.size; }, file.size) > 100 * 1024 * 1024) { toast("Tổng file mỗi tin vượt 100MB", true); return; }
      pending.push({ file: file, name: file.name || ("anh-" + Date.now() + ".png"), url: file.type.indexOf("image/") === 0 ? URL.createObjectURL(file) : null });
      renderPending();
    }
    function renderPending() {
      pend.innerHTML = "";
      pending.forEach(function (it, idx) {
        var c = el("span", { "class": "chip" });
        c.innerHTML = (it.url ? '<img src="' + it.url + '" alt="">' : fileIcon(it.name)) + ' <span class="nm">' + esc(it.name) + '</span> <span class="muted">' + fmtSize(it.file.size) + '</span> <span class="x" title="Bỏ">✕</span>';
        c.querySelector(".x").onclick = function () { pending.splice(idx, 1); renderPending(); };
        pend.appendChild(c);
      });
    }
    $("#cxClip", root).onclick = function () { $("#cxFile", root).click(); };
    $("#cxFile", root).onchange = function () { Array.prototype.forEach.call(this.files, addPending); this.value = ""; cxFocus(inp); };
    inp.addEventListener("paste", function (e) { var f = (e.clipboardData && e.clipboardData.files) || []; if (f.length) { e.preventDefault(); Array.prototype.forEach.call(f, addPending); } });
    var main = root.querySelector(".cx-main");
    main.addEventListener("dragover", function (e) { e.preventDefault(); main.style.outline = "2px dashed var(--accent2)"; });
    main.addEventListener("dragleave", function () { main.style.outline = ""; });
    main.addEventListener("drop", function (e) { e.preventDefault(); main.style.outline = ""; Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], addPending); });
    function readB64(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { var d = String(r.result); res(d.slice(d.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(file); }); }

    inp.addEventListener("input", function () { cxGrow(inp); });
    inp.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey || cxTouch()) return; // xuống dòng
      e.preventDefault(); doSend();
    });
    sendBtn.onclick = function () { if (C.busy) { if (C.ctrl) try { C.ctrl.abort(); } catch (e) {} return; } doSend(); };
    function setBusy(b) { C.busy = b; sendBtn.textContent = b ? "■" : "➤"; sendBtn.title = b ? "Dừng trả lời" : "Gửi"; }

    function ensureSession() {
      if (C.sessionId) return Promise.resolve(C.sessionId);
      return api("/v1/sessions", { method: "POST", body: { agentKey: agentSel.value } }).then(function (j) {
        C.sessionId = j.session.id; state.sessionId = C.sessionId; setHash(C.sessionId);
        C.sessions.unshift(j.session); renderList();
        return C.sessionId;
      });
    }

    function doSend() {
      if (C.busy) return;
      var text = inp.value.trim(); if (!text && !pending.length) return;
      var atts = pending.slice(); pending = []; renderPending();
      inp.value = ""; cxGrow(inp); cxFocus(inp);
      var ud = showMsg("user", text);
      if (atts.length) {
        var ua = el("div", { "class": "atts" });
        ua.innerHTML = atts.map(function (it) { return it.url ? '<img class="thumb" src="' + it.url + '" alt="">' : '<span class="chip">' + fileIcon(it.name) + ' <span class="nm">' + esc(it.name) + "</span></span>"; }).join("");
        ud.appendChild(ua);
      }
      toBottom(true);
      var bot = showMsg("bot", ""); bot.innerHTML = "<span class='cx-typing muted'>Đang trả lời</span>";
      var botText = "", botFiles = null, ctrl = new AbortController(), fullText = "";
      C.ctrl = ctrl; setBusy(true);
      // Vẽ lại câu trả lời theo khung hình (không vẽ lại mỗi mẩu chữ → không giật)
      function paint() { raf = 0; if (bot && botText) bot.innerHTML = md(splitBotText(botText).text); toBottom(false); }
      function schedule() { if (!raf) raf = requestAnimationFrame(paint); }
      function finish() {
        if (raf) { cancelAnimationFrame(raf); paint(); }
        if (bot && fullText.trim()) addActs(bot, splitBotText(fullText).text);
        C.ctrl = null; setBusy(false); loadList().then(function () { var s = C.sessions.filter(function (x) { return x.id === C.sessionId; })[0]; if (s) setTitle(s.title); });
      }
      ensureSession().then(function (sid) {
        return Promise.all(atts.map(function (it) { return readB64(it.file).then(function (b64) { return { name: it.name, contentB64: b64, mime: it.file.type || "" }; }); }))
          .then(function (files) { return fetch("/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, message: text, stream: true, files: files }), signal: ctrl.signal }); });
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { var j = {}; try { j = JSON.parse(t); } catch (e) {} throw new Error(j.error || ("HTTP " + res.status)); });
        var rd = res.body.getReader(), dec = new TextDecoder(), buf = "", NL = String.fromCharCode(10);
        function pump() {
          return rd.read().then(function (r) {
            if (r.done) { finish(); return; }
            buf += dec.decode(r.value, { stream: true }); var i;
            while ((i = buf.indexOf(NL)) >= 0) {
              var line = buf.slice(0, i); buf = buf.slice(i + 1);
              if (line.indexOf("data: ") !== 0) continue;
              var d = line.slice(6); if (d === "[DONE]") continue;
              var ev; try { ev = JSON.parse(d); } catch (e) { continue; }
              if (ev.type === "text_delta") { if (!bot) bot = showMsg("bot", ""); botText += ev.text; fullText += ev.text; schedule(); }
              else if (ev.type === "tool_call") {
                if (raf) { cancelAnimationFrame(raf); paint(); }
                if (bot && botText.trim()) { bot = null; botText = ""; }
                else if (bot) { bot.remove(); bot = null; }
                showMsg("tool", "🔧 " + (ev.name === "browser" && ev.args && ev.args.action === "click" && (ev.args.saveTo || ev.args.fileName) ? "browser — tải file " + (ev.args.fileName || ev.args.ref || "") : ev.name + "(" + JSON.stringify(ev.args).slice(0, 200) + ")"));
                bot = showMsg("bot", ""); bot.innerHTML = "<span class='cx-typing muted'>Đang làm</span>";
              }
              else if (ev.type === "tool_result") { /* kết quả tool không hiện (đỡ rối) — lỗi thì hiện */ if (ev.isError) showMsg("tool", "↳ ❌ " + String(ev.result).slice(0, 300)); }
              else if (ev.type === "saved") { if (ud && ev.files && ev.files.length) { var ua2 = ud.querySelector(".atts") || el("div", { "class": "atts" }); ua2.innerHTML = ev.files.map(function (f) { return fileChip(f.p, f.isImage); }).join(""); if (!ua2.parentNode) ud.appendChild(ua2); } }
              else if (ev.type === "file") { if (!botFiles) botFiles = el("div", { "class": "files" }); botFiles.innerHTML += fileCard(ev); if (!botFiles.parentNode) log.appendChild(botFiles); toBottom(false); }
              else if (ev.type === "done") {
                if (!botText) { var ft = splitBotText(ev.finalText || "").text; if (ft) { if (!bot) bot = showMsg("bot", ""); botText = ft; fullText = ft; } else if (bot) { bot.remove(); bot = null; } }
                if (botFiles) log.appendChild(botFiles);
              }
              else if (ev.type === "error") { if (!bot) bot = showMsg("bot", ""); botText = ""; bot.textContent = "❌ " + ev.message; }
            }
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        if (e && e.name === "AbortError") { if (bot && !botText) bot.innerHTML = "<span class='muted'>(đã dừng)</span>"; }
        else { if (!bot) bot = showMsg("bot", ""); botText = ""; bot.textContent = "❌ " + e.message; }
        finish();
      });
    }

    // ----- khởi động -----
    var want = decodeURIComponent((location.hash.split("?")[0].split("/")[2] || ""));
    loadList().then(function () {
      if (want && C.sessions.some(function (s) { return s.id === want; })) openSession(want);
      else if (!want && state.sessionId && C.sessions.some(function (s) { return s.id === state.sessionId; })) openSession(state.sessionId);
      else newChat();
    });
  };
`;
