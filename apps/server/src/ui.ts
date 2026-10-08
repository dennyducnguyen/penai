/**
 * Web UI PenAI — Dashboard SPA (vanilla, inline, không cần build step).
 * Sidebar nhiều mục bao phủ mọi subsystem. Hash router (#/section).
 */
export const INDEX_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%BRAND_NAME%%</title>
<link rel="icon" href="%%BRAND_LOGO%%">
<style>
  /* Nền/chữ trung tính. Màu thương hiệu (--accent, --accent2, --star, nền trang đăng nhập)
     do máy chủ chèn theo khối branding trong file cấu hình (apps/server/src/branding.ts). */
  :root { color-scheme: light dark; --border:#8883; --bg:#fff; --fg:#0f172a; --side:#f3f6fb; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --fg:#e5ecf6; --side:#0f172a; --card:#111a2e; --border:#ffffff22; } }
  %%BRAND_CSS%%
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); }
  a { color: var(--accent2); }
  input, textarea, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: rgba(128,128,128,.08); color: inherit; }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); }
  button { cursor: pointer; border: 0; background: var(--accent); color: #fff; font-weight: 500; }
  button.ghost { background: transparent; border: 1px solid var(--border); color: inherit; font-weight: 400; }
  button.sm { padding: 4px 9px; font-size: .82rem; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 1.05rem; margin: 0; display: flex; align-items: center; gap: 8px; }
  header h1 .brand-logo { width: 26px; height: 26px; border-radius: 6px; }
  header .grow { flex: 1; }
  .layout { flex: 1; display: flex; min-height: 0; }
  nav.side { width: 210px; background: var(--side); border-right: 1px solid var(--border); overflow-y: auto; padding: 8px; flex-shrink: 0; }
  nav.side a { display: flex; align-items: center; gap: 9px; padding: 8px 11px; border-radius: 8px; text-decoration: none; color: inherit; font-size: .9rem; margin-bottom: 1px; }
  nav.side a:hover { background: rgba(128,128,128,.12); }
  nav.side a.active { background: var(--accent); color: #fff; }
  nav.side .grp { font-size: .68rem; text-transform: uppercase; opacity: .5; padding: 12px 11px 4px; letter-spacing: .04em; }
  main { flex: 1; overflow-y: auto; padding: 20px 24px; }
  h2.page { margin: 0 0 4px; font-size: 1.3rem; }
  .sub { opacity: .6; font-size: .88rem; margin-bottom: 16px; }
  .card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; background: var(--card); }
  .card h3 { margin: 0 0 10px; font-size: .98rem; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row > input, .row > select, .row > textarea { flex: 1; min-width: 130px; }
  .memory-textarea { display: block; width: 100%; min-height: 180px; resize: vertical; line-height: 1.5; }
  .memory-meta { display: grid; grid-template-columns: minmax(160px,.8fr) minmax(120px,.5fr) minmax(220px,1fr) auto; gap: 10px; align-items: end; margin-top: 10px; }
  .memory-meta label { margin-top: 0; }
  .memory-meta input, .memory-meta select { width: 100%; }
  .memory-edit-dialog { width: 780px; max-width: 94vw; padding: 20px; }
  .memory-edit-dialog .memory-textarea { min-height: 260px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  @media (max-width: 760px) { .memory-meta { grid-template-columns: 1fr; } .memory-meta button { width: 100%; } }
  label { font-size: .8rem; opacity: .75; display: block; margin: 8px 0 3px; }
  .muted { opacity: .6; font-size: .85rem; }
  .err { color: #ef4444; } .ok { color: #22c55e; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 9px; border-bottom: 1px solid var(--border); font-size: .88rem; vertical-align: top; }
  th { font-weight: 600; opacity: .7; font-size: .78rem; text-transform: uppercase; }
  code { background: rgba(128,128,128,.15); padding: 1px 5px; border-radius: 5px; font-size: .84em; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .72rem; border: 1px solid var(--border); }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .stat { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--card); }
  .stat .n { font-size: 1.8rem; font-weight: 700; }
  .stat .l { opacity: .6; font-size: .82rem; }
  /* chat */
  #chatWrap { display: flex; flex-direction: column; height: calc(100vh - 130px); }
  #log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px; }
  .msg { padding: 9px 13px; border-radius: 12px; max-width: 80%; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg.bot { align-self: flex-start; background: rgba(128,128,128,.16); white-space: normal; line-height: 1.5; }
  .msg.bot > :first-child { margin-top: 0; } .msg.bot > :last-child { margin-bottom: 0; }
  .msg.bot p { margin: 0 0 .6em; }
  .msg.bot h1, .msg.bot h2, .msg.bot h3, .msg.bot h4 { margin: .7em 0 .35em; line-height: 1.3; }
  .msg.bot h1 { font-size: 1.2rem; } .msg.bot h2 { font-size: 1.1rem; } .msg.bot h3 { font-size: 1rem; } .msg.bot h4 { font-size: .95rem; }
  .msg.bot ul, .msg.bot ol { margin: .3em 0 .6em; padding-left: 1.5em; }
  .msg.bot li { margin: .15em 0; }
  .msg.bot li > ul, .msg.bot li > ol { margin: .15em 0; }
  .msg.bot pre { background: rgba(0,0,0,.28); color: #e5ecf6; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem; line-height: 1.45; margin: .5em 0; white-space: pre; }
  .msg.bot pre code { background: transparent; padding: 0; font-size: inherit; }
  .msg.bot code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .msg.bot blockquote { margin: .5em 0; padding: 4px 12px; border-left: 3px solid var(--accent2); opacity: .85; }
  .msg.bot table { width: auto; margin: .5em 0; border: 1px solid var(--border); font-size: .85rem; }
  .msg.bot th, .msg.bot td { padding: 5px 9px; border: 1px solid var(--border); text-transform: none; opacity: 1; font-size: .85rem; }
  .msg.bot th { background: rgba(128,128,128,.12); font-weight: 600; }
  .msg.bot hr { border: 0; border-top: 1px solid var(--border); margin: .8em 0; }
  .msg.bot a { word-break: break-all; }
  .msg.bot img { max-width: 100%; border-radius: 8px; }
  .msg.tool { align-self: flex-start; font-family: ui-monospace, monospace; font-size: .76rem; opacity: .7; background: rgba(128,128,128,.1); }
  .chatbar { display: flex; gap: 8px; padding-top: 10px; align-items: center; }
  .chatbar input[type=text] { flex: 1; }
  .chatbar .clip { background: transparent; border: 1px solid var(--border); color: inherit; font-size: 1.05rem; padding: 7px 10px; }
  .chatbar .clip:hover { background: rgba(128,128,128,.12); }
  #pend { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 8px; }
  #pend:empty { display: none; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: .8rem; background: rgba(128,128,128,.1); max-width: 260px; }
  .chip img { width: 26px; height: 26px; object-fit: cover; border-radius: 6px; }
  .chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .x { cursor: pointer; opacity: .6; padding: 0 2px; } .chip .x:hover { opacity: 1; }
  .chip a { color: inherit; text-decoration: none; }
  .msg .atts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .msg.user .chip { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.35); color: #fff; }
  .msg.user .atts img.thumb { max-width: 220px; max-height: 180px; border-radius: 10px; display: block; }
  .files { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 8px; max-width: 80%; }
  .fcard { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); text-decoration: none; color: inherit; font-size: .85rem; }
  .fcard:hover { border-color: var(--accent2); }
  .fcard .ic { font-size: 1.3rem; } .fcard .meta { opacity: .6; font-size: .74rem; }
  .fimg { display: block; } .fimg img { max-width: min(420px, 100%); max-height: 360px; border-radius: 10px; border: 1px solid var(--border); display: block; }
  #chatWrap.drop { outline: 2px dashed var(--accent2); outline-offset: -4px; }
  dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: inherit; max-width: 90vw; }
  dialog::backdrop { background: #0008; }
  /* ===== Thư viện file (26/09/2026) ===== */
  .lib-grid { display: grid; grid-template-columns: 270px 1fr; gap: 12px; align-items: start; }
  @media (max-width: 860px) { .lib-grid { grid-template-columns: 1fr; } }
  .lib-side { max-height: calc(100vh - 170px); overflow: auto; }
  .lib-scope { display: flex; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 8px; cursor: pointer; font-size: .86rem; }
  .lib-scope:hover { background: rgba(128,128,128,.12); }
  .lib-scope.active { background: var(--accent); color: #fff; }
  .lib-scope.active .muted { color: #fff; opacity: .85; }
  .lib-scope .muted { font-size: .74rem; white-space: nowrap; }
  .lib-bc { font-size: .88rem; margin-top: 10px; }
  .lib-bc a { cursor: pointer; text-decoration: none; }
  .lib-zone { border-radius: 10px; min-height: 90px; }
  .lib-zone.drop { outline: 2px dashed var(--accent2); outline-offset: 2px; }
  .lib-name { cursor: pointer; }
  .lib-name:hover { color: var(--accent2); }
  .lib-path { font-size: .72rem; opacity: .55; font-family: ui-monospace, monospace; }
  .lib-acts { white-space: nowrap; }
  .lib-acts button { margin: 1px 2px; }
  .fwrap { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  /* ===== Contacts: hồ sơ, nhãn, chỉ dẫn cho AI (0029) ===== */
  .ct-dialog { width: 940px; max-width: 96vw; padding: 18px 20px; }
  .ct-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .ct-tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--border); margin: 12px 0 14px; }
  .ct-tabs button { background: transparent; color: inherit; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 12px; font-weight: 500; opacity: .7; }
  .ct-tabs button.on { border-bottom-color: var(--accent); opacity: 1; }
  .ct-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  @media (max-width: 760px) { .ct-grid { grid-template-columns: 1fr; } }
  .ct-row { cursor: pointer; }
  .ct-row:hover td { background: rgba(128,128,128,.07); }
  .tagpill { display: inline-flex; align-items: center; gap: 5px; margin: 1px 0; }
  .tagpill i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .ct-check { display: flex; align-items: center; gap: 7px; opacity: 1; font-size: .86rem; margin: 10px 0 4px; }
  .tagchk { display: inline-flex; align-items: center; gap: 5px; margin: 0 14px 6px 0; opacity: 1; font-size: .86rem; }
  .cf-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .cf-row input { flex: 1; min-width: 0; }
  .ct-count { font-size: .74rem; opacity: .6; text-align: right; margin-top: 2px; }
  .ct-help { font-size: .8rem; opacity: .7; margin: 2px 0 6px; line-height: 1.45; }
  .ct-pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .78rem; line-height: 1.45; max-height: 460px; overflow: auto; background: rgba(128,128,128,.08); padding: 10px 12px; border-radius: 8px; margin: 8px 0 0; }
  .ct-msgs { max-height: 360px; overflow: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .ct-msgs div { padding: 6px 10px; border-radius: 8px; font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
  .ct-msgs .u { background: rgba(128,128,128,.14); }
  .ct-msgs .b { border: 1px solid var(--border); }
  .ct-sec { margin: 18px 0 6px; font-size: .92rem; }
  /* ===== Đăng nhập (0024) ===== */
  body:not(.authed) header, body:not(.authed) .layout { display: none; }
  #loginView { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px;
    background: radial-gradient(1200px 600px at 10% -10%, var(--login-glow) 0%, transparent 60%),
                radial-gradient(900px 500px at 110% 110%, var(--login-glow2) 0%, transparent 60%),
                linear-gradient(160deg, var(--login-bg1) 0%, var(--login-bg2) 45%, var(--login-bg3) 100%); }
  #loginView[hidden] { display: none; }
  .login-card { width: 100%; max-width: 400px; background: rgba(255,255,255,.96); color: #0f172a; border-radius: 18px; padding: 34px 32px 26px;
    box-shadow: 0 30px 80px -20px #000a, 0 0 0 1px #ffffff22; backdrop-filter: blur(10px); animation: loginIn .35s ease-out; }
  @media (prefers-color-scheme: dark) { .login-card { background: rgba(15,23,42,.94); color: #e5ecf6; } }
  @keyframes loginIn { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  .login-logo { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: .01em; color: var(--accent2); font-size: 1.3rem; }
  .login-logo img { width: 36px; height: 36px; border-radius: 9px; }
  .login-card h1 { font-size: 1.5rem; margin: 18px 0 4px; }
  .login-sub { opacity: .6; font-size: .88rem; margin: 0 0 22px; }
  .login-card label { margin: 12px 0 5px; font-size: .8rem; letter-spacing: .02em; }
  .login-card input { width: 100%; padding: 12px 13px; font-size: .95rem; border-radius: 10px; background: rgba(128,128,128,.09); }
  .pw-wrap { position: relative; }
  .pw-wrap input { padding-right: 44px; }
  .pw-toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: inherit; opacity: .55; padding: 6px 8px; font-size: .95rem; }
  .pw-toggle:hover { opacity: 1; }
  .login-err { margin-top: 12px; padding: 9px 12px; border-radius: 9px; background: #ef444418; color: #dc2626; font-size: .85rem; border: 1px solid #ef444433; }
  .login-err[hidden] { display: none; }
  #loginBtn { width: 100%; margin-top: 18px; padding: 12px; font-size: .98rem; border-radius: 10px; font-weight: 600; letter-spacing: .01em; box-shadow: 0 8px 20px -8px var(--accent); }
  .login-foot { margin-top: 18px; text-align: center; opacity: .5; font-size: .76rem; }
  .user-badge { display: inline-flex; align-items: center; gap: 8px; font-size: .84rem; }
  .user-badge .avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: .8rem; }
  .user-badge .nm { font-weight: 600; }
  .role-pill { font-size: .68rem; padding: 1px 7px; border-radius: 999px; background: rgba(128,128,128,.15); }
  .member-hint { opacity: .65; font-size: .85rem; margin-bottom: 10px; }
  .agent-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; margin-top: 6px; max-height: 220px; overflow: auto; padding: 8px; border: 1px solid var(--border); border-radius: 8px; }
  .agent-checks label { display: flex; align-items: center; gap: 6px; margin: 0; font-size: .85rem; opacity: 1; cursor: pointer; }
  .agent-checks input { width: auto; padding: 0; }
  /* Inbox Zalo */
  .ibx { display: flex; height: calc(100vh - 190px); min-height: 420px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--card); }
  .ibx-list { width: 330px; border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .ibx-threads { flex: 1; overflow-y: auto; }
  .ibx-item { display: flex; gap: 10px; padding: 9px 10px; cursor: pointer; border-bottom: 1px solid var(--border); }
  .ibx-item:hover { background: rgba(128,128,128,.08); }
  .ibx-item.active { background: rgba(128,128,128,.16); }
  .ibx-av { width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; overflow: hidden; }
  .ibx-av.grp { border-radius: 10px; }
  .ibx-av img { width: 100%; height: 100%; object-fit: cover; }
  .ibx-mid { flex: 1; min-width: 0; }
  .ibx-nm { font-weight: 600; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ibx-last { font-size: .8rem; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ibx-meta { font-size: .72rem; opacity: .8; text-align: right; flex-shrink: 0; }
  .ibx-badge { display: inline-block; background: #ef4444; color: #fff; border-radius: 999px; padding: 0 7px; font-size: .72rem; margin-top: 3px; }
  .ibx-chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .ibx-head { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ibx-msgs { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .ibx-msg { max-width: 72%; display: flex; flex-direction: column; }
  .ibx-msg.in { align-self: flex-start; }
  .ibx-msg.out { align-self: flex-end; align-items: flex-end; }
  .ibx-bubble { padding: 7px 11px; border-radius: 12px; background: rgba(128,128,128,.14); font-size: .9rem; line-height: 1.4; word-wrap: break-word; overflow-wrap: anywhere; }
  .ibx-msg.out .ibx-bubble { background: var(--accent); color: #fff; }
  .ibx-msg.out .ibx-bubble a { color: #fff; }
  .ibx-who { font-size: .7rem; opacity: .7; margin: 0 4px 1px; }
  .ibx-time { font-size: .66rem; opacity: .5; margin: 1px 4px 0; }
  .ibx-quote { font-size: .78rem; opacity: .75; border-left: 3px solid rgba(128,128,128,.5); padding-left: 6px; margin-bottom: 4px; }
  .ibx-photo { max-width: 260px; max-height: 260px; border-radius: 8px; display: block; }
  .ibx-sticker { width: 90px; height: 90px; object-fit: contain; }
  .ibx-compose { border-top: 1px solid var(--border); padding: 8px 10px; }
  .ibx-msg { position: relative; }
  .ibx-react { display: none; position: absolute; top: -14px; right: -6px; background: var(--card); border: 1px solid var(--border); border-radius: 999px; padding: 1px 4px; box-shadow: 0 2px 8px rgba(0,0,0,.12); z-index: 2; white-space: nowrap; }
  .ibx-msg.in .ibx-react { right: auto; left: 30px; }
  .ibx-msg:hover .ibx-react { display: block; }
  .ibx-react button { background: transparent; border: 0; padding: 2px 3px; font-size: 1rem; line-height: 1; color: inherit; border-radius: 6px; }
  .ibx-react button:hover { background: rgba(128,128,128,.18); }
  .ibx-react button.mine { background: rgba(37,99,235,.18); }
  .ibx-rx { display: flex; gap: 3px; flex-wrap: wrap; margin: 2px 4px 0; }
  .ibx-rx span { font-size: .78rem; background: rgba(128,128,128,.14); border-radius: 999px; padding: 0 6px; cursor: default; }
  .ibx-compose textarea { flex: 1; resize: vertical; min-height: 42px; }
  @media (max-width: 860px) { .ibx { flex-direction: column; height: auto; } .ibx-list { width: 100%; max-height: 300px; border-right: 0; border-bottom: 1px solid var(--border); } .ibx-msgs { min-height: 360px; } .ibx-msg { max-width: 90%; } }
</style>
</head>
<body>
<div id="loginView" hidden>
  <div class="login-card">
    <div class="login-logo"><img src="%%BRAND_LOGO%%" alt=""><span>%%BRAND_NAME%%</span></div>
    <h1>Đăng nhập</h1>
    <p class="login-sub">%%BRAND_TAGLINE%%</p>
    <form id="loginForm" autocomplete="on">
      <label for="loginEmail">Email</label>
      <input id="loginEmail" type="email" autocomplete="username" placeholder="ban@congty.vn" required>
      <label for="loginPass">Mật khẩu</label>
      <div class="pw-wrap">
        <input id="loginPass" type="password" autocomplete="current-password" placeholder="••••••••" required>
        <button type="button" class="pw-toggle" id="loginEye" title="Hiện/ẩn mật khẩu">👁</button>
      </div>
      <div id="loginErr" class="login-err" hidden></div>
      <button type="submit" id="loginBtn">Đăng nhập</button>
    </form>
    <div class="login-foot">Chưa có tài khoản? Liên hệ quản trị viên workspace.</div>
  </div>
</div>
<header>
  <h1><img class="brand-logo" src="%%BRAND_LOGO%%" alt=""><span style="color:var(--accent2)">%%BRAND_NAME%%</span></h1>
  <span id="wsinfo" class="muted"></span>
  <span class="grow"></span>
  <span id="who" class="muted"></span>
  <span id="userBadge" class="user-badge"></span>
  <button id="btnPass" class="ghost sm" title="Đổi mật khẩu">Đổi mật khẩu</button>
  <button id="btnLogout" class="ghost sm">Đăng xuất</button>
</header>
<div class="layout">
  <nav class="side" id="nav"></nav>
  <main id="main"><div class="muted">Đang tải…</div></main>
</div>

<script>
(function () {
  "use strict";
  // Tên/khẩu hiệu thương hiệu do máy chủ chèn từ config (branding).
  var BRAND = %%BRAND_JSON%%;
  var $ = function (s, r) { return (r||document).querySelector(s); };
  var el = function (tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; };
  var esc = function (s) { return String(s==null?"":s).replace(/[&<>"]/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); };
  // Ô nhập mật khẩu che ký tự + nút 👁 hiện/ẩn (style như trang đăng nhập). autocomplete="new-password"
  // để trình duyệt không tự điền mật khẩu của chính người đang đăng nhập vào ô của người khác.
  function pwField(id) {
    return '<div class="pw-wrap"><input id="' + id + '" type="password" style="width:100%" autocomplete="new-password" placeholder="••••••••">' +
      '<button type="button" class="pw-toggle" data-for="' + id + '" title="Hiện/ẩn mật khẩu">👁</button></div>';
  }
  function bindPwToggles(root) {
    Array.prototype.forEach.call(root.querySelectorAll(".pw-toggle[data-for]"), function (b) {
      b.onclick = function () {
        var input = root.querySelector("#" + b.getAttribute("data-for"));
        if (input) input.type = input.type === "password" ? "text" : "password";
      };
    });
  }
  // Đăng nhập bằng cookie httpOnly (phiên web) — không còn giữ token trong localStorage.
  var state = { me: null, agents: [], sessionId: null };
  try { localStorage.removeItem("penai_key"); } catch (e) {}

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        if (t) {
          try { j = JSON.parse(t); }
          catch (e) {
            if (r.status === 413) throw new Error("File tải lên quá lớn so với giới hạn máy chủ (HTTP 413).");
            throw new Error("Máy chủ trả về nội dung không hợp lệ (HTTP " + r.status + ").");
          }
        }
        if (r.status === 401 && state.me && path.indexOf("/auth/") !== 0) { showLogin("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại."); }
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  window.__api = api;
  function isMember() { return !!(state.me && state.me.role === "member"); }
  function isAdmin() { return !!(state.me && state.me.role === "ws_admin"); }

  // ===== Sidebar =====
  var NAV = [
    { grp: "Tổng quan" },
    { id: "overview", icon: "📊", label: "Tổng quan" },
    { id: "chat", icon: "💬", label: "Chat" },
    { id: "inbox", icon: "📥", label: "Inbox" },
    { grp: "Cấu hình" },
    { id: "agents", icon: "🤖", label: "Agents" },
    { id: "providers", icon: "🔌", label: "Providers" },
    { id: "channels", icon: "📡", label: "Channels" },
    { id: "cron", icon: "⏰", label: "Cron & lịch hẹn" },
    { id: "users", icon: "👤", label: "Người dùng", admin: true },
    { id: "apikeys", icon: "🔑", label: "Khóa API (tích hợp)", admin: true },
    { grp: "Năng lực" },
    { id: "memory", icon: "🧠", label: "Memory" },
    { id: "skills", icon: "📚", label: "Skills" },
    { id: "tools", icon: "🛠️", label: "Custom Tools" },
    { id: "mcp", icon: "🧩", label: "MCP" },
    { id: "mcpserver", icon: "🔗", label: "Kết nối AI bên ngoài" },
    { id: "browser", icon: "🌐", label: "Trình duyệt", admin: true },
    { id: "vault", icon: "🗄️", label: "Kho tri thức (Vault)" },
    { id: "library", icon: "📁", label: "Thư viện file" },
    { id: "kg", icon: "🕸️", label: "Knowledge Graph" },
    { grp: "Vận hành" },
    { id: "sessions", icon: "🗂️", label: "Sessions" },
    { id: "hooks", icon: "🪝", label: "Hooks" },
    { id: "webhooks", icon: "🔗", label: "Webhooks" },
    { id: "contacts", icon: "📇", label: "Contacts" },
    { id: "traces", icon: "📈", label: "Traces" },
    { id: "audit", icon: "📋", label: "Audit log" },
    { id: "usage", icon: "💳", label: "Usage" },
  ];
  function renderNav() {
    var nav = $("#nav"); nav.innerHTML = "";
    var cur = (location.hash.replace("#/", "") || (isMember() ? "chat" : "overview")).split("?")[0];
    if (isMember()) {
      // Thành viên: chỉ có trang Chat
      nav.appendChild(el("div", { "class": "grp" }, "Trợ lý AI"));
      nav.appendChild(el("a", { href: "#/chat", "class": cur === "inbox" ? "" : "active" }, "💬 <span>Chat</span>"));
      if ((state.inboxChannels || []).length) nav.appendChild(el("a", { href: "#/inbox", "class": cur === "inbox" ? "active" : "" }, "📥 <span>Inbox Zalo</span>"));
      return;
    }
    var pendingGrp = null;
    NAV.forEach(function (n) {
      if (n.grp) { pendingGrp = n.grp; return; }
      if (n.admin && !isAdmin()) return;
      if (n.id === "inbox" && !(state.inboxChannels || []).length) return;
      if (pendingGrp) { nav.appendChild(el("div", { "class": "grp" }, pendingGrp)); pendingGrp = null; }
      var a = el("a", { href: "#/" + n.id, "class": cur === n.id ? "active" : "" }, n.icon + " <span>" + n.label + "</span>");
      nav.appendChild(a);
    });
  }

  // ===== helpers =====
  function page(title, sub) {
    var m = $("#main"); m.innerHTML = "";
    m.appendChild(el("h2", { "class": "page" }, esc(title)));
    if (sub) m.appendChild(el("div", { "class": "sub" }, esc(sub)));
    return m;
  }
  function card(parent, title) {
    var c = el("div", { "class": "card" });
    if (title) c.appendChild(el("h3", null, esc(title)));
    parent.appendChild(c); return c;
  }
  function table(cols, rows, rowFn) {
    var t = el("table"), thead = el("thead"), tr = el("tr");
    cols.forEach(function (c) { tr.appendChild(el("th", null, esc(c))); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    if (!rows.length) { var e = el("tr"); e.appendChild(el("td", { colspan: cols.length }, '<span class="muted">(trống)</span>')); tb.appendChild(e); }
    rows.forEach(function (r) { tb.appendChild(rowFn(r)); });
    t.appendChild(tb); return t;
  }
  function toast(msg, isErr) {
    var w = $("#who"); w.innerHTML = '<span class="' + (isErr ? "err" : "ok") + '">' + esc(msg) + "</span>";
    setTimeout(function () { w.innerHTML = ""; }, 3000);
  }

  // ===== Markdown tối giản cho bong bóng chat =====
  // Escape HTML TRƯỚC rồi mới dựng thẻ → nội dung LLM không chèn được HTML/script.
  function mdInline(t) {
    t = t.replace(/\`([^\`\\n]+)\`/g, function (_, c) { return "<code>" + c + "</code>"; });
    t = t.replace(/!\\[([^\\]]*)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<img alt="$1" src="$2">');
    t = t.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/(^|[^*])\\*\\*([^*\\n]+?)\\*\\*/g, "$1<strong>$2</strong>");
    t = t.replace(/(^|[^_\\w])__([^_\\n]+?)__/g, "$1<strong>$2</strong>");
    t = t.replace(/(^|[^*\\w])\\*([^*\\n]+?)\\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^_\\w])_([^_\\n]+?)_(?!\\w)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~\\n]+?)~~/g, "<del>$1</del>");
    return t;
  }
  function md(src) {
    var lines = esc(String(src == null ? "" : src)).replace(/\\r\\n?/g, "\\n").split("\\n");
    var out = [], i = 0, para = [];
    function flushPara() { if (para.length) { out.push("<p>" + mdInline(para.join("<br>")) + "</p>"); para = []; } }
    function isTableSep(l) { return /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$/.test(l); }
    function splitRow(l) { l = l.trim(); if (l.charAt(0) === "|") l = l.slice(1); if (l.charAt(l.length - 1) === "|") l = l.slice(0, -1); return l.split("|").map(function (c) { return c.trim(); }); }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^\\s*\`\`\`\\s*([\\w+-]*)\\s*$/);
      if (fence) {
        flushPara(); var buf = []; i++;
        while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; out.push("<pre><code" + (fence[1] ? ' class="lang-' + fence[1] + '"' : "") + ">" + buf.join("\\n") + "</code></pre>"); continue;
      }
      if (/^\\s*$/.test(line)) { flushPara(); i++; continue; }
      var h = line.match(/^\\s*(#{1,4})\\s+(.+?)\\s*#*\\s*$/);
      if (h) { flushPara(); out.push("<h" + h[1].length + ">" + mdInline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\\s*([-*_])(\\s*\\1){2,}\\s*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }
      if (/^\\s*&gt;\\s?/.test(line)) {
        flushPara(); var q = [];
        while (i < lines.length && /^\\s*&gt;\\s?/.test(lines[i])) { q.push(lines[i].replace(/^\\s*&gt;\\s?/, "")); i++; }
        out.push("<blockquote>" + md(q.map(function (x) { return x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"); }).join("\\n")) + "</blockquote>"); continue;
      }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); var head = splitRow(line); i += 2; var rows = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && !/^\\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        var t = "<table><thead><tr>" + head.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
        rows.forEach(function (r) { t += "<tr>" + head.map(function (_, k) { return "<td>" + mdInline(r[k] || "") + "</td>"; }).join("") + "</tr>"; });
        out.push(t + "</tbody></table>"); continue;
      }
      var li = line.match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
      if (li) {
        flushPara();
        var items = [], baseIndent = li[1].length, ordered = /\\d/.test(li[2]);
        while (i < lines.length) {
          var m = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
          if (m && m[1].length <= baseIndent) { if (/\d/.test(m[2]) !== ordered) break; items.push({ text: m[3], sub: [] }); i++; continue; }
          if (m && m[1].length > baseIndent && items.length) { items[items.length - 1].sub.push(lines[i].slice(baseIndent + 2)); i++; continue; }
          if (/^\\s{2,}\\S/.test(lines[i]) && !m && items.length) { items[items.length - 1].text += "<br>" + lines[i].trim(); i++; continue; }
          break;
        }
        out.push("<" + (ordered ? "ol" : "ul") + ">" + items.map(function (it) {
          var sub = it.sub.length ? md(it.sub.map(function (x) { return x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"); }).join("\\n")) : "";
          return "<li>" + mdInline(it.text) + sub + "</li>";
        }).join("") + "</" + (ordered ? "ol" : "ul") + ">");
        continue;
      }
      para.push(line); i++;
    }
    flushPara();
    return out.join("");
  }
  window.__md = md;
  function fileUrl(pp, dl) { return "/v1/chat/files?p=" + encodeURIComponent(pp) + (dl ? "&dl=1" : ""); }
  function fmtSize(n) { n = Number(n) || 0; return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function fileIcon(name) { var e = (name.split(".").pop() || "").toLowerCase(); return { xlsx: "📊", xls: "📊", csv: "📊", docx: "📝", doc: "📝", pptx: "📽️", ppt: "📽️", pdf: "📕", zip: "🗜️", txt: "📄", md: "📄", json: "🧾", mp4: "🎬", mp3: "🎵" }[e] || "📎"; }
  /** Thẻ file agent gửi (ảnh hiện inline, file khác là thẻ tải). */
  function fileCard(f) {
    var inner = fileCardInner(f);
    if (!state.me || isMember()) return inner;
    return '<span class="fwrap">' + inner + '<button type="button" class="ghost sm lib-save" data-p="' + esc(f.p) + '" data-name="' + esc(f.name) + '" title="Lưu file này vào Thư viện file của agent (vd làm file mẫu)">📁 Lưu vào thư viện</button></span>';
  }
  function fileCardInner(f) {
    if (f.isImage) { return '<a class="fimg" href="' + fileUrl(f.p) + '" target="_blank" rel="noopener"><img src="' + fileUrl(f.p) + '" alt="' + esc(f.name) + '" loading="lazy"></a>'; }
    return '<a class="fcard" href="' + fileUrl(f.p, 1) + '" download="' + esc(f.name) + '"><span class="ic">' + fileIcon(f.name) + '</span><span><div>' + esc(f.name) + '</div><div class="meta">' + fmtSize(f.size) + ' · tải xuống</div></span></a>';
  }
  /** Chip file người dùng đã gửi (đã lưu trong thư mục chat của họ). */
  function fileChip(name, isImage) {
    if (isImage) return '<a href="' + fileUrl(name) + '" target="_blank" rel="noopener"><img class="thumb" src="' + fileUrl(name) + '" alt="' + esc(name) + '" loading="lazy"></a>';
    return '<span class="chip"><a href="' + fileUrl(name, 1) + '" download>' + fileIcon(name) + ' <span class="nm">' + esc(name) + '</span></a></span>';
  }
  var IMG_RE = /\\.(png|jpe?g|webp|gif)$/i;
  /** Tách marker [[files:…]] / [[media:…]] khỏi text bot → {text, files[]} */
  function splitBotText(t) {
    var files = [];
    t = String(t == null ? "" : t).replace(/\\[\\[files:(\\[[\\s\\S]*?\\])\\]\\]/g, function (_, j) { try { files = files.concat(JSON.parse(j)); } catch (e) {} return ""; });
    t = t.replace(/\\[\\[media:[^\\]]+\\]\\]/g, "");
    return { text: t.trim(), files: files };
  }
  /** Text người dùng trong lịch sử: rút ghi chú file "[… đã lưu tại: X]" thành chip. */
  function splitUserText(t) {
    var names = [];
    t = String(t == null ? "" : t);
    t = t.replace(/\\[Nội dung file "[^"]*" — đã lưu tại: ([^\\]\\n]+?)\\]:\\n[\\s\\S]*?(?=\\n\\[|$)/g, function (_, n) { names.push(n.trim()); return ""; });
    t = t.replace(/\\[Người dùng gửi (?:kèm ảnh|file), đã lưu tại: ([^\\]\\n—]+?)(?: —[^\\]]*)?\\]/g, function (_, n) { names.push(n.trim()); return ""; });
    t = t.replace(/\\[Đã gửi \\d+ file: ([^\\]]+)\\]/g, function (_, list) { list.split(",").forEach(function (n) { n = n.trim(); if (n) names.push(n); }); return ""; });
    return { text: t.replace(/\\n{3,}/g, "\\n\\n").trim(), names: names };
  }

  // ===== Pages =====
  var PAGES = {};

  PAGES.overview = function () {
    var m = page("Tổng quan", "Trạng thái hệ thống " + BRAND.name);
    var grid = el("div", { "class": "stats" }); m.appendChild(grid);
    var items = [
      ["agents", "Agents", "/v1/agents", "agents"],
      ["sessions", "Sessions", "/v1/sessions", "sessions"],
      ["channels", "Channels", "/v1/channels", "channels"],
      ["skills", "Skills", "/v1/skills", "skills"],
      ["cron", "Cron jobs", "/v1/cron", "jobs"],
      ["hooks", "Hooks", "/v1/hooks", "hooks"],
      ["traces", "Traces", "/v1/traces", "traces"],
    ];
    items.forEach(function (it) {
      var s = el("div", { "class": "stat" }); s.appendChild(el("div", { "class": "n", id: "stat-" + it[0] }, "…"));
      s.appendChild(el("div", { "class": "l" }, it[1])); grid.appendChild(s);
      api(it[2]).then(function (j) { $("#stat-" + it[0]).textContent = (j[it[3]] || []).length; }).catch(function () { $("#stat-" + it[0]).textContent = "–"; });
    });
    var u = card(m, "Sử dụng token tháng này");
    api("/v1/usage").then(function (j) {
      u.appendChild(el("div", null, "Đã dùng: <b>" + j.monthTokens + "</b> token" + (j.cap ? " / hạn mức " + j.cap : " (không giới hạn)")));
    });
  };

  PAGES.chat = function () {
    var m = page("Chat", isMember() ? "Trò chuyện với trợ lý AI được cấp cho bạn" : null);
    if (!state.agents.length) {
      m.appendChild(el("div", { "class": "card" }, isMember()
        ? "<b>Bạn chưa được gán trợ lý AI nào.</b> Hãy liên hệ quản trị viên để được cấp quyền chat."
        : "<b>Chưa có agent nào.</b> Tạo agent trong mục Agents trước."));
      return;
    }
    var wrap = el("div", { id: "chatWrap" });
    var bar = el("div", { "class": "row", style: "margin-bottom:8px" });
    var sel = el("select", { id: "chatAgent" });
    state.agents.forEach(function (a) { sel.appendChild(el("option", { value: a.key }, esc(isMember() ? a.name : a.name + " (" + a.provider + "/" + a.model + ")"))); });
    bar.appendChild(sel);
    var btnNew = el("button", { "class": "ghost" }, "Cuộc mới"); bar.appendChild(btnNew);
    var hist = el("select", { id: "chatHist", title: "Phiên gần đây" }); bar.appendChild(hist);
    var st = el("span", { "class": "muted", id: "chatStatus" }); bar.appendChild(st);
    wrap.appendChild(bar);
    var log = el("div", { id: "log" }); wrap.appendChild(log);
    function agentById(id) { for (var i = 0; i < state.agents.length; i++) if (state.agents[i].id === id) return state.agents[i]; return null; }
    function loadHist() {
      api("/v1/sessions").then(function (j) {
        hist.innerHTML = '<option value="">— phiên gần đây —</option>';
        (j.sessions || []).slice(0, 30).forEach(function (sx) {
          var a = agentById(sx.agentId); if (!a) return;
          hist.appendChild(el("option", { value: sx.id, "data-agent": a.key }, esc((sx.title || "Phiên " + sx.id.slice(0, 6)) + " · " + a.name + " · " + String(sx.updatedAt || "").slice(0, 16).replace("T", " "))));
        });
        if (state.sessionId) hist.value = state.sessionId;
      }).catch(function () {});
    }
    hist.onchange = function () {
      var id = hist.value; if (!id) return;
      var opt = hist.options[hist.selectedIndex]; if (opt && opt.getAttribute("data-agent")) sel.value = opt.getAttribute("data-agent");
      state.sessionId = id; log.innerHTML = ""; st.textContent = "đang tải lịch sử…";
      api("/v1/sessions/" + id + "/messages").then(function (j) {
        (j.messages || []).forEach(function (msg) {
          var c = msg.content || {};
          if (msg.role === "user" && c.kind === "text") {
            var su = splitUserText(c.text);
            if (su.text || su.names.length) {
              var ud = showMsg("user", su.text || "");
              if (su.names.length) { var ua = el("div", { "class": "atts" }); ua.innerHTML = su.names.map(function (n) { return fileChip(n, IMG_RE.test(n)); }).join(""); ud.appendChild(ua); }
            }
          }
          else if (msg.role === "assistant" && c.text) {
            var sb = splitBotText(c.text);
            if (sb.files.length) { showFiles(sb.files); }
            else if (sb.text) showMsg("bot", sb.text);
          }
        });
        st.textContent = "";
      }).catch(function (e) { st.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
    loadHist();
    var pend = el("div", { id: "pend" }); wrap.appendChild(pend);
    var cb = el("div", { "class": "chatbar" });
    var clip = el("button", { "class": "clip", type: "button", title: "Đính kèm ảnh / file (hoặc dán, kéo thả)" }, "📎");
    var fileIn = el("input", { type: "file", multiple: "multiple", style: "display:none", accept: "image/*,.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.md,.csv,.json,.zip" });
    var inp = el("input", { id: "msg", type: "text", placeholder: "Nhập tin nhắn… (📎 để gửi ảnh/file cho agent)" });
    var send = el("button", null, "Gửi");
    cb.appendChild(clip); cb.appendChild(fileIn); cb.appendChild(inp); cb.appendChild(send); wrap.appendChild(cb);
    m.appendChild(wrap);

    // ----- file đính kèm chờ gửi -----
    var pending = [];
    function addPending(file) {
      if (!file) return;
      if (pending.length >= 10) { toast("Tối đa 10 file mỗi tin", true); return; }
      if (file.size > 100 * 1024 * 1024) { toast(file.name + ": vượt 100MB", true); return; }
      if (pending.reduce(function (n, it) { return n + it.file.size; }, file.size) > 100 * 1024 * 1024) { toast("Tổng file mỗi tin vượt 100MB", true); return; }
      var item = { file: file, name: file.name || ("anh-" + Date.now() + ".png"), url: file.type.indexOf("image/") === 0 ? URL.createObjectURL(file) : null };
      pending.push(item); renderPending();
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
    clip.onclick = function () { fileIn.click(); };
    fileIn.onchange = function () { Array.prototype.forEach.call(fileIn.files, addPending); fileIn.value = ""; inp.focus(); };
    inp.addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length) { e.preventDefault(); Array.prototype.forEach.call(items, addPending); }
    });
    wrap.addEventListener("dragover", function (e) { e.preventDefault(); wrap.classList.add("drop"); });
    wrap.addEventListener("dragleave", function () { wrap.classList.remove("drop"); });
    wrap.addEventListener("drop", function (e) { e.preventDefault(); wrap.classList.remove("drop"); Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], addPending); });
    function readB64(file) {
      return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { var d = String(r.result); res(d.slice(d.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(file); });
    }

    function showMsg(kind, text) { var d = el("div", { "class": "msg " + kind }); if (kind === "bot") d.innerHTML = md(splitBotText(text).text); else d.textContent = text; log.appendChild(d); d.scrollIntoView(); return d; }
    function showFiles(files) { if (!files || !files.length) return null; var d = el("div", { "class": "files" }); d.innerHTML = files.map(fileCard).join(""); log.appendChild(d); d.scrollIntoView(); return d; }
    btnNew.onclick = function () {
      api("/v1/sessions", { method: "POST", body: { agentKey: sel.value } })
        .then(function (j) { state.sessionId = j.session.id; log.innerHTML = ""; st.textContent = "phiên mới"; loadHist(); })
        .catch(function (e) { st.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
    function doSend() {
      var text = inp.value.trim(); if (!text && !pending.length) return;
      if (!state.sessionId) { btnNew.onclick(); setTimeout(doSend, 500); return; }
      var atts = pending.slice(); pending = []; renderPending();
      inp.value = ""; send.disabled = true;
      var ud = showMsg("user", text);
      if (atts.length) {
        var ua = el("div", { "class": "atts" });
        ua.innerHTML = atts.map(function (it) { return it.url ? '<img class="thumb" src="' + it.url + '" alt="">' : '<span class="chip">' + fileIcon(it.name) + ' <span class="nm">' + esc(it.name) + '</span></span>'; }).join("");
        ud.appendChild(ua);
      }
      var bot = showMsg("bot", "…"); var botText = ""; var botFiles = null;
      Promise.all(atts.map(function (it) { return readB64(it.file).then(function (b64) { return { name: it.name, contentB64: b64, mime: it.file.type || "" }; }); }))
        .then(function (files) {
          return fetch("/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: state.sessionId, message: text, stream: true, files: files }) });
        })
        .then(function (res) {
          if (!res.ok) { return res.text().then(function (t) { var j = {}; try { j = JSON.parse(t); } catch (e) {} throw new Error(j.error || ("HTTP " + res.status)); }); }
          var rd = res.body.getReader(), dec = new TextDecoder(), buf = "";
          function pump() {
            return rd.read().then(function (r) {
              if (r.done) { send.disabled = false; return; }
              buf += dec.decode(r.value, { stream: true }); var i;
              while ((i = buf.indexOf("\\n")) >= 0) {
                var line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (line.indexOf("data: ") === 0) {
                  var d = line.slice(6); if (d === "[DONE]") continue;
                  try { var ev = JSON.parse(d);
                    if (ev.type === "text_delta") { botText += ev.text; bot.innerHTML = md(splitBotText(botText).text); }
                    else if (ev.type === "tool_call") showMsg("tool", "🔧 " + ev.name + "(" + JSON.stringify(ev.args).slice(0, 400) + ")");
                    else if (ev.type === "tool_result") showMsg("tool", "↳ " + (ev.isError ? "❌ " : "") + String(ev.result).slice(0, 300));
                    else if (ev.type === "saved") { /* file người dùng đã lưu server-side → đổi chip tạm thành link thật */ if (ud && ev.files && ev.files.length) { var ua2 = ud.querySelector(".atts") || el("div", { "class": "atts" }); ua2.innerHTML = ev.files.map(function (f) { return fileChip(f.p, f.isImage); }).join(""); if (!ua2.parentNode) ud.appendChild(ua2); } }
                    else if (ev.type === "file") { if (!botFiles) botFiles = el("div", { "class": "files" }); botFiles.innerHTML += fileCard(ev); if (!botFiles.parentNode) log.appendChild(botFiles); botFiles.scrollIntoView(); }
                    else if (ev.type === "done") { if (!botText) { var ft = splitBotText(ev.finalText || "").text; if (ft) bot.innerHTML = md(ft); else if (botFiles) bot.remove(); else bot.textContent = "(trống)"; } if (botFiles) log.appendChild(botFiles); loadHist(); }
                    else if (ev.type === "error") { bot.textContent = "❌ " + ev.message; }
                  } catch (e) {}
                }
              }
              bot.scrollIntoView(); return pump();
            });
          }
          return pump();
        }).catch(function (e) { bot.textContent = "❌ " + e.message; send.disabled = false; });
    }
    send.onclick = doSend;
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) doSend(); });
  };

  // Bộ chọn model dùng chung: select provider + select model (nạp từ API) +
  // ô gõ tay. Chọn trong danh sách → tự điền vào ô; ô gõ tay là giá trị cuối.
  function wireModelPicker(root, provSel, modelSel, freeInput, initial) {
    function loadModels(keepValue) {
      var n = $(provSel, root).value;
      $(modelSel, root).innerHTML = '<option value="">(đang tải model...)</option>';
      api("/v1/providers/" + n + "/models").then(function (j) {
        $(modelSel, root).innerHTML = '<option value="">' + (j.models.length ? '— chọn model —' : '(không tìm thấy model — gõ tay)') + '</option>' +
          j.models.map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.displayName || x.slug) + "</option>"; }).join("");
        if (keepValue && $(freeInput, root).value) {
          $(modelSel, root).value = $(freeInput, root).value;
        } else if (j.defaultModel) {
          $(freeInput, root).value = j.defaultModel;
          $(modelSel, root).value = j.defaultModel;
        }
      }).catch(function () {
        $(modelSel, root).innerHTML = '<option value="">(provider không liệt kê model — gõ tay)</option>';
      });
    }
    api("/v1/providers").then(function (j) {
      $(provSel, root).innerHTML = j.providers.map(function (p) { return "<option>" + esc(p.name) + "</option>"; }).join("");
      if (initial && initial.provider) $(provSel, root).value = initial.provider;
      if (initial && initial.model) $(freeInput, root).value = initial.model;
      loadModels(true);
    });
    $(provSel, root).onchange = function () { $(freeInput, root).value = ""; loadModels(false); };
    $(modelSel, root).onchange = function () { if ($(modelSel, root).value) $(freeInput, root).value = $(modelSel, root).value; };
  }

  // Chuyển tên → key: bỏ dấu tiếng Việt, chữ thường, gạch ngang
  function slugifyKey(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  function openAgentCreate(onDone) {
    var dlg = el("dialog", { style: "width:680px;max-width:95vw;padding:20px" });
    dlg.innerHTML =
      '<h3 style="margin:0 0 4px">Tạo agent mới</h3>' +
      '<div class="muted" style="margin-bottom:12px">Agent là một trợ lý AI có tên, model và system prompt riêng. Tạo xong có thể gắn vào kênh chat (Telegram...) hoặc chat thử ngay trong mục Chat.</div>' +
      '<div class="row"><div style="flex:1"><label>Tên hiển thị *</label><input id="nName" placeholder="vd: Trợ lý Kinh doanh" style="width:100%"></div>' +
      '<div style="flex:1"><label>Key (định danh) *</label><input id="nKey" placeholder="tự sinh từ tên" style="width:100%"><div class="muted" style="font-size:.75rem">Chữ thường không dấu, số, gạch ngang. Dùng trong API/kênh chat.</div></div></div>' +
      '<label style="margin-top:10px">Model *</label>' +
      '<div class="row"><select id="nProv" style="flex:1"></select><select id="nModel" style="flex:2"></select><input id="nModelFree" placeholder="hoặc gõ model id" style="flex:1"></div>' +
      '<div class="muted" style="font-size:.75rem">Chọn provider rồi chọn model trong danh sách; provider không liệt kê model thì gõ tay (vd gpt-5.5).</div>' +
      '<div class="row" style="margin-top:10px"><div><label>Thinking (suy luận)</label><select id="nThink"><option value="off">off — nhanh nhất</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium — cân bằng</option><option value="high">high — kỹ nhất</option></select></div>' +
      '<div><label>Max vòng lặp tool</label><input id="nIter" type="number" value="10" min="1" max="50" style="width:90px"></div></div>' +
      '<label style="display:flex;align-items:center;gap:7px;margin-top:10px"><input id="nWsMem" type="checkbox" checked style="flex:0"> Dùng Workspace Semantic <span class="muted">— kiến thức chung của workspace</span></label>' +
      '<label style="margin-top:10px">System prompt (tính cách, nhiệm vụ, quy tắc trả lời)</label>' +
      '<textarea id="nPrompt" rows="10" style="width:100%;font-size:.85rem" placeholder="Ví dụ:&#10;Bạn là trợ lý kinh doanh của công ty ABC.&#10;- Trả lời tiếng Việt, ngắn gọn, thân thiện.&#10;- Khi khách hỏi giá: tra tài liệu trong Vault trước.&#10;- Không hứa hẹn điều chưa chắc chắn."></textarea>' +
      '<div class="muted" style="font-size:.75rem">Có thể để trống và bổ sung sau (nút Cấu hình). Hệ thống tự thêm hướng dẫn về thư mục làm việc, ghi nhớ, skills.</div>' +
      '<div class="row" style="margin-top:14px"><button id="nCreate">Tạo agent</button><button class="ghost" id="nCancel">Hủy</button><span id="nMsg" class="muted"></span></div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    wireModelPicker(dlg, "#nProv", "#nModel", "#nModelFree", null);
    var keyDirty = false;
    $("#nKey", dlg).oninput = function () { keyDirty = true; };
    $("#nName", dlg).oninput = function () { if (!keyDirty) $("#nKey", dlg).value = slugifyKey($("#nName", dlg).value); };
    $("#nCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
    $("#nCreate", dlg).onclick = function () {
      var key = $("#nKey", dlg).value.trim();
      var name = $("#nName", dlg).value.trim();
      var model = $("#nModelFree", dlg).value.trim() || $("#nModel", dlg).value;
      var errs = [];
      if (!name) errs.push("nhập Tên hiển thị");
      if (!key) errs.push("nhập Key");
      else if (!/^[a-z0-9-]+$/.test(key)) errs.push("key chỉ gồm chữ thường không dấu, số, gạch ngang");
      if (!model) errs.push("chọn hoặc gõ model");
      if (errs.length) { $("#nMsg", dlg).innerHTML = '<span class="err">' + esc(errs.join(" · ")) + "</span>"; return; }
      $("#nMsg", dlg).textContent = "Đang tạo...";
      api("/v1/agents", { method: "POST", body: { key: key, name: name, provider: $("#nProv", dlg).value, model: model, systemPrompt: $("#nPrompt", dlg).value, maxIterations: parseInt($("#nIter", dlg).value, 10) || 10, workspaceMemoryEnabled: $("#nWsMem", dlg).checked } })
        .then(function (r) {
          var think = $("#nThink", dlg).value;
          var after = think !== "off" ? api("/v1/agents/" + r.agent.id, { method: "PATCH", body: { thinkingLevel: think } }) : Promise.resolve();
          return after.then(function () { toast("Đã tạo agent " + name); dlg.close(); dlg.remove(); onDone(); });
        })
        .catch(function (e) { $("#nMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
  }

  PAGES.agents = function () {
    var m = page("Agents", "Trợ lý AI trong workspace — mỗi agent có model, system prompt và quyền riêng");
    var top = card(m);
    top.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center"><span class="muted">Tạo agent mới rồi gắn vào kênh chat, hoặc bấm "Cấu hình" để sửa agent có sẵn.</span><button id="aOpen">＋ Tạo agent</button></div>';
    $("#aOpen").onclick = function () { openAgentCreate(function () { load(); refreshAgents(); }); };
    var listC = card(m, "Danh sách");

    // Dialog cấu hình chi tiết agent: thinking, vòng lặp, tools, skills, fallback
    function openConfig(a, reload) {
      var dlg = el("dialog", { style: "width:680px;max-width:95vw;padding:18px" });
      dlg.innerHTML =
        '<h3 style="margin:0 0 10px">Cấu hình: ' + esc(a.name) + ' <code>' + esc(a.key) + '</code></h3>' +
        '<label>Tên hiển thị</label><input id="dName" style="width:100%">' +
        '<label style="margin-top:8px">Model</label>' +
        '<div class="row"><select id="dProv" style="flex:1"></select><select id="dModel" style="flex:2"></select><input id="dModelFree" placeholder="hoặc gõ model id" style="flex:1"></div>' +
        '<div class="row" style="margin-top:8px"><span class="muted">Thinking:</span><select id="dThink"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option></select>' +
        '<span class="muted">Max vòng lặp:</span><input id="dIter" type="number" min="1" max="50" style="width:80px;flex:0"></div>' +
        '<label style="display:flex;align-items:center;gap:7px;margin-top:9px"><input id="dWsMem" type="checkbox" style="flex:0"> Dùng Workspace Semantic <span class="muted">— tắt nếu agent không được dùng kiến thức chung</span></label>' +
        '<label style="display:flex;align-items:center;gap:7px;margin-top:6px"><input id="dLibW" type="checkbox" style="flex:0"> Cho agent ghi vào Thư viện file của mình <span class="muted">— mặc định chỉ đọc · <a href="#/library?agent=' + esc(a.id) + '" id="dLibLink">mở thư viện của agent</a></span></label>' +
        '<div id="dBrWrap" hidden><label>Hồ sơ trình duyệt <span class="muted">— cookie đăng nhập sẵn cho tool browser (quản lý ở <a href="#/browser" id="dBrLink">Trình duyệt</a>)</span></label><select id="dBr" style="width:100%"><option value="">(trình duyệt trống — không đăng nhập sẵn)</option></select></div>' +
        '<label>System prompt</label><textarea id="dPrompt" rows="8" style="width:100%;font-size:.85rem"></textarea>' +
        '<label>Model dự phòng <span class="muted">— model chính lỗi, hết hạn mức hoặc quá tải thì thử lần lượt từ trên xuống</span></label>' +
        '<div id="dFbList"></div><div><button class="ghost" id="dFbAdd" type="button">＋ Thêm model dự phòng</button></div>' +
        '<label>Tools (bỏ tick = tắt cho agent này)</label><div id="dTools" class="row" style="max-height:150px;overflow:auto"></div>' +
        '<label>Skills được cấp (grant riêng cho agent — skill phạm vi "granted" chỉ agent được cấp mới thấy)</label><div id="dSkills" style="max-height:170px;overflow:auto"></div>' +
        '<label>MCP servers được cấp (server phạm vi "granted" chỉ agent được cấp mới dùng tool)</label><div id="dMcp" style="max-height:170px;overflow:auto"></div>' +
        '<div class="row" style="margin-top:12px"><button id="dSave">Lưu</button><button class="ghost" id="dClose">Đóng</button><span id="dMsg" class="muted"></span></div>';
      document.body.appendChild(dlg);
      dlg.showModal();
      wireModelPicker(dlg, "#dProv", "#dModel", "#dModelFree", { provider: a.provider, model: a.model });
      $("#dName", dlg).value = a.name || "";
      $("#dThink", dlg).value = a.thinkingLevel || "off";
      $("#dIter", dlg).value = a.maxIterations || 10;
      $("#dWsMem", dlg).checked = a.workspaceMemoryEnabled !== false;
      $("#dLibW", dlg).checked = a.libraryWritable === true;
      $("#dLibLink", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#dBrLink", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      var brLoaded = false;
      if (isAdmin()) api("/v1/browser").then(function (j) {
        var sel = $("#dBr", dlg);
        j.profiles.forEach(function (p) { sel.appendChild(el("option", { value: p.id }, esc(p.name) + " (" + p.cookieCount + " cookie)")); });
        sel.value = a.browserProfileId || "";
        $("#dBrWrap", dlg).hidden = false; brLoaded = true;
      }).catch(function () {});
      $("#dPrompt", dlg).value = a.systemPrompt || "";
      // Mỗi dòng dự phòng = chọn provider + model (như ô Model phía trên), ✕ để bỏ.
      function addFallbackRow(init) {
        var row = el("div", { "class": "row fbrow", style: "margin:4px 0" },
          '<select class="fbP" style="flex:1"></select><select class="fbM" style="flex:2"></select>' +
          '<input class="fbF" placeholder="hoặc gõ model id" style="flex:1">' +
          '<button class="ghost fbX" type="button" title="Bỏ dòng này" style="flex:0">✕</button>');
        $("#dFbList", dlg).appendChild(row);
        wireModelPicker(row, ".fbP", ".fbM", ".fbF", init);
        $(".fbX", row).onclick = function () { row.remove(); };
      }
      (Array.isArray(a.providerFallback) ? a.providerFallback : []).forEach(function (f) {
        if (f && f.provider && f.model) addFallbackRow({ provider: f.provider, model: f.model });
      });
      $("#dFbAdd", dlg).onclick = function () { addFallbackRow(null); };
      var disabled = a.disabledTools || [];
      api("/v1/tools").then(function (j) {
        $("#dTools", dlg).innerHTML = j.tools.map(function (t) {
          var off = disabled.indexOf(t.name) >= 0;
          return '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0"><input type="checkbox" class="tk" value="' + esc(t.name) + '"' + (off ? "" : " checked") + '> <code>' + esc(t.name) + '</code></label>';
        }).join("");
      });
      var grantsInit = {};
      api("/v1/agents/" + a.id + "/skills").then(function (j) {
        $("#dSkills", dlg).innerHTML = j.skills.length ? j.skills.map(function (s) {
          grantsInit[s.id] = s.granted;
          return '<label style="display:flex;align-items:center;gap:6px;margin:3px 0"><input type="checkbox" class="sk" value="' + esc(s.id) + '"' + (s.granted ? " checked" : "") + '> <code>' + esc(s.slug) + '</code> <span class="muted">' + esc(s.name) + '</span> <span class="pill">' + esc(s.visibility) + (s.enabled ? "" : " · tắt") + '</span></label>';
        }).join("") : '<span class="muted">chưa có skill nào trong workspace</span>';
      });
      var mcpInit = {};
      api("/v1/agents/" + a.id + "/mcp").then(function (j) {
        $("#dMcp", dlg).innerHTML = j.servers.length ? j.servers.map(function (s) {
          mcpInit[s.id] = s.granted;
          return '<label style="display:flex;align-items:center;gap:6px;margin:3px 0"><input type="checkbox" class="mc" value="' + esc(s.id) + '"' + (s.granted ? " checked" : "") + '> <code>' + esc(s.name) + '</code> <span class="muted">' + esc(s.transport) + (s.tools && s.tools.length ? " · " + s.tools.length + " tool" : "") + '</span> <span class="pill">' + esc(s.visibility) + (s.enabled ? "" : " · tắt") + '</span></label>';
        }).join("") : '<span class="muted">chưa có MCP server nào trong workspace</span>';
      });
      $("#dClose", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#dSave", dlg).onclick = function () {
        var fb = [], fbMissing = false;
        dlg.querySelectorAll(".fbrow").forEach(function (row) {
          var fp = $(".fbP", row).value, fm = $(".fbF", row).value.trim() || $(".fbM", row).value;
          if (!fp || !fm) { fbMissing = true; return; }
          fb.push({ provider: fp, model: fm });
        });
        if (fbMissing) { $("#dMsg", dlg).innerHTML = '<span class="err">Model dự phòng: chọn đủ provider và model, hoặc bấm ✕ để bỏ dòng</span>'; return; }
        var disabledNow = [];
        dlg.querySelectorAll(".tk").forEach(function (cb) { if (!cb.checked) disabledNow.push(cb.value); });
        var model = $("#dModelFree", dlg).value.trim() || $("#dModel", dlg).value;
        if (!model) { $("#dMsg", dlg).innerHTML = '<span class="err">Chưa chọn model</span>'; return; }
        var patch = {
          name: $("#dName", dlg).value.trim() || a.name,
          provider: $("#dProv", dlg).value,
          model: model,
          thinkingLevel: $("#dThink", dlg).value,
          maxIterations: parseInt($("#dIter", dlg).value, 10) || 10,
          systemPrompt: $("#dPrompt", dlg).value,
          providerFallback: fb,
          disabledTools: disabledNow,
          workspaceMemoryEnabled: $("#dWsMem", dlg).checked,
          libraryWritable: $("#dLibW", dlg).checked
        };
        if (brLoaded) patch.browserProfileId = $("#dBr", dlg).value || null;
        var ops = [api("/v1/agents/" + a.id, { method: "PATCH", body: patch })];
        dlg.querySelectorAll(".sk").forEach(function (cb) {
          var was = grantsInit[cb.value];
          if (cb.checked && !was) ops.push(api("/v1/skills/" + cb.value + "/grants/agent", { method: "POST", body: { agentId: a.id } }));
          if (!cb.checked && was) ops.push(api("/v1/skills/" + cb.value + "/grants/agent/" + a.id, { method: "DELETE" }));
        });
        dlg.querySelectorAll(".mc").forEach(function (cb) {
          var was = mcpInit[cb.value];
          if (cb.checked && !was) ops.push(api("/v1/mcp/" + cb.value + "/grants/agent", { method: "POST", body: { agentId: a.id } }));
          if (!cb.checked && was) ops.push(api("/v1/mcp/" + cb.value + "/grants/agent/" + a.id, { method: "DELETE" }));
        });
        Promise.all(ops).then(function () { toast("Đã lưu cấu hình"); dlg.close(); dlg.remove(); reload(); })
          .catch(function (e) { $("#dMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }

    function load() {
      api("/v1/agents").then(function (j) {
        listC.innerHTML = "<h3>Danh sách</h3>";
        if (!j.agents.length) {
          listC.innerHTML += '<div class="muted">Chưa có agent nào — bấm "＋ Tạo agent" ở trên.</div>';
          return;
        }
        listC.appendChild(table(["Key", "Tên", "Model", "Thinking", "Workspace Memory", "Prompt", ""], j.agents, function (a) {
          var tr = el("tr");
          var promptPreview = (a.systemPrompt || "").replace(/\s+/g, " ").slice(0, 60);
          tr.innerHTML =
            "<td><code>" + esc(a.key) + "</code></td><td>" + esc(a.name) + "</td>" +
            "<td><span class='pill'>" + esc(a.provider) + "</span> <code>" + esc(a.model) + "</code></td>" +
            "<td><span class='pill'>" + esc(a.thinkingLevel || "off") + "</span></td>" +
            "<td><span class='pill " + (a.workspaceMemoryEnabled === false ? "" : "ok") + "'>" + (a.workspaceMemoryEnabled === false ? "Tắt" : "Bật") + "</span></td>" +
            "<td class='muted' style='max-width:220px'>" + (promptPreview ? esc(promptPreview) + "…" : "<i>(trống)</i>") + "</td>";
          var td = el("td");
          var cfg = el("button", { "class": "ghost sm" }, "Cấu hình"); cfg.onclick = function () { openConfig(a, load); };
          var del = el("button", { "class": "ghost sm" }, "Xóa"); del.onclick = function () { if (confirm('Xóa agent "' + a.name + '"?')) api("/v1/agents/" + a.id, { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); }); };
          td.appendChild(cfg); td.appendChild(document.createTextNode(" ")); td.appendChild(del);
          tr.appendChild(td); return tr;
        }));
      });
    }
    load();
  };

  // ---- Providers: danh sách gộp (subscription CLI + API key DB) kiểu card gọn.
  // Chi tiết (đăng nhập, tài khoản, token) ẩn trong phần mở rộng từng dòng;
  // thêm provider API key qua dialog thay vì form luôn mở.
  PAGES.providers = function () {
    var m = page("Providers", "Nhà cung cấp LLM — gói subscription (ChatGPT, Claude, Antigravity) và API key");
    var c = card(m);
    c.innerHTML =
      '<div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Danh sách</h3>' +
      '<button id="pvAdd" class="sm">＋ Thêm provider API key</button></div>' +
      '<div id="pvList" style="margin-top:6px"><span class="muted">đang tải...</span></div>';
    $("#pvAdd").onclick = function () { openProviderCreate(); };

    function accStatusHtml(a) {
      if (a.status === "needs_reauth") return '<span class="pill err">cần đăng nhập lại</span>';
      if (a.status === "cooldown") return '<span class="pill">nghẽn — nghỉ ' + (a.cooldownSeconds || 0) + "s</span>";
      return '<span class="pill ok">sẵn sàng</span>' + (a.inFlight ? ' <span class="pill">' + a.inFlight + " đang chạy</span>" : "");
    }

    // Đăng nhập codex (OAuth). PenAI chạy trên server nên trang callback
    // localhost:1455 mở ở MÁY NGƯỜI DÙNG, server không nhận được → hiện ô dán
    // link callback để hoàn tất. Vẫn poll phòng khi chạy local (tự hoàn tất).
    function codexLogin(container, pName, btn, expectCount) {
      btn.disabled = true; btn.textContent = "Đang lấy link...";
      api("/v1/providers/" + pName + "/login", { method: "POST" }).then(function (r) {
        window.open(r.authorizeUrl, "_blank");
        btn.textContent = "Đang chờ đăng nhập...";
        var f = el("div", { style: "margin-top:8px" });
        f.className = "pv-login-flow";
        f.innerHTML =
          '<div style="margin-bottom:6px">1) <a href="' + esc(r.authorizeUrl) + '" target="_blank" rel="noopener">Mở link đăng nhập ChatGPT</a> (tab mới đã tự mở)</div>' +
          '<div class="muted" style="font-size:.78rem;margin-bottom:6px">2) Đăng nhập xong trình duyệt dừng ở trang lỗi <code>localhost:1455</code> — copy TOÀN BỘ link trên thanh địa chỉ rồi dán vào đây (hạn 10 phút, link chỉ dùng được một lần).</div>' +
          '<div class="row"><input class="pv-cb" placeholder="http://localhost:1455/auth/callback?code=..." style="flex:1"><button class="sm pv-cb-btn">Hoàn tất</button><span class="muted pv-cb-msg"></span></div>';
        var old = container.querySelector(".pv-login-flow");
        if (old) old.remove();
        container.appendChild(f);
        container.style.display = "";
        var poll = setInterval(function () {
          api("/v1/providers").then(function (jj) {
            var pv = jj.providers.find(function (x) { return x.name === pName; });
            var n = (pv && pv.accounts) ? pv.accounts.length : 0;
            if (pv && pv.loggedIn && (expectCount === undefined || n > expectCount)) { clearInterval(poll); PAGES.providers(); }
          }).catch(function () {});
        }, 2500);
        setTimeout(function () { clearInterval(poll); }, 600000);
        var input = f.querySelector(".pv-cb"), submit = f.querySelector(".pv-cb-btn"), msg = f.querySelector(".pv-cb-msg");
        submit.onclick = function () {
          var v = input.value.trim();
          if (!v) { msg.innerHTML = '<span class="err">Hãy dán link callback</span>'; return; }
          submit.disabled = true; msg.textContent = "Đang xác thực...";
          api("/v1/providers/" + pName + "/login/callback", { method: "POST", body: { url: v } })
            .then(function (res) { clearInterval(poll); toast("ChatGPT: đã thêm " + (res.email || "tài khoản")); PAGES.providers(); })
            .catch(function (e) { submit.disabled = false; msg.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
        };
        input.onkeydown = function (ev) { if (ev.key === "Enter") submit.onclick(); };
      }).catch(function (e) { btn.disabled = false; btn.textContent = "Lỗi: " + e.message; });
    }

    // Đăng nhập CLI subscription (claude-code / antigravity): link + dán code
    function cliLoginFlow(container, p, label, btn) {
      btn.disabled = true; var oldText = btn.textContent; btn.textContent = "Đang lấy link...";
      api("/v1/providers/" + p.name + "/login", { method: "POST" }).then(function (r) {
        btn.textContent = "Đang chờ đăng nhập...";
        var f = el("div", { style: "margin-top:8px" });
        f.innerHTML =
          '<div style="margin-bottom:6px">1) <a href="' + esc(r.authorizeUrl) + '" target="_blank" rel="noopener">Mở link đăng nhập ' + esc(label) + "</a></div>" +
          '<div class="muted" style="font-size:.78rem;margin-bottom:6px">2) Đăng nhập xong copy authorization code dán vào đây (một số luồng tự hoàn tất — trang này tự cập nhật).</div>' +
          '<div class="row"><input class="pv-code" placeholder="dán authorization code" style="flex:1"><button class="sm pv-code-btn">Xác nhận</button><span class="muted pv-code-msg"></span></div>';
        var old = container.querySelector(".pv-login-flow");
        if (old) old.remove();
        f.className = "pv-login-flow";
        container.appendChild(f);
        var poll = setInterval(function () {
          api("/v1/providers").then(function (jj) {
            var cur = jj.providers.find(function (x) { return x.name === p.name; });
            if (cur && cur.loggedIn) { clearInterval(poll); toast(label + ": đăng nhập thành công"); PAGES.providers(); }
          }).catch(function () {});
        }, 3000);
        setTimeout(function () { clearInterval(poll); }, 240000);
        var input = f.querySelector(".pv-code"), submit = f.querySelector(".pv-code-btn"), msg = f.querySelector(".pv-code-msg");
        submit.onclick = function () {
          var codeVal = input.value.trim();
          if (!codeVal) { msg.innerHTML = '<span class="err">Hãy dán code</span>'; return; }
          submit.disabled = true; msg.textContent = "Đang xác thực...";
          api("/v1/providers/" + p.name + "/login/code", { method: "POST", body: { code: codeVal } })
            .then(function () { clearInterval(poll); toast(label + ": đăng nhập thành công"); PAGES.providers(); })
            .catch(function (e) { submit.disabled = false; msg.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
        };
        input.onkeydown = function (ev) { if (ev.key === "Enter") submit.onclick(); };
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = oldText;
        toast(e.message, 1);
        if (/đã đăng nhập sẵn/.test(e.message)) PAGES.providers();
      });
    }

    function kindLabel(p, dbRow) {
      if (p.kind === "codex") return "ChatGPT subscription";
      if (p.kind === "claude-code") return "Claude Max";
      if (p.kind === "antigravity") return "Google Antigravity";
      if (dbRow) {
        if (dbRow.kind === "openai") return "OpenAI API";
        if (dbRow.kind === "gemini") return "Gemini API";
        if (dbRow.kind === "qwen" || dbRow.kind === "dashscope") return "Qwen API";
        if (dbRow.kind === "anthropic") return "Anthropic API";
        if (dbRow.kind === "openai-compat") return "OpenAI-compatible";
        return dbRow.kind;
      }
      return "LLM";
    }

    function openProviderEdit(row) {
      var dlg = el("dialog", { style: "width:620px;max-width:95vw;padding:20px" });
      dlg.innerHTML =
        '<h3 style="margin:0 0 4px">Cấu hình provider ' + esc(row.name) + "</h3>" +
        '<div class="muted" style="margin-bottom:10px">Để trống API key nếu chỉ đổi model. Khi lưu, PenAI kiểm tra thật chat và embedding trước khi cập nhật.</div>' +
        '<label>API key mới (không bắt buộc)</label><input id="peKey" type="password" autocomplete="off" placeholder="Chỉ dán khi cần xoay khóa" style="width:100%">' +
        '<label>Model chat mặc định</label><input id="peChat" style="width:100%" value="' + esc(row.defaultModel || "") + '">' +
        '<label>Model embedding</label><input id="peEmbed" style="width:100%" value="' + esc(row.defaultEmbeddingModel || "") + '">' +
        '<div class="row"><div><label>Số chiều</label><input id="peDim" type="number" min="64" max="4096" value="' + esc(row.embeddingDimensions || 768) + '" style="width:110px"></div>' +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:22px"><input id="peDefault" type="checkbox" style="flex:0"' + (row.isDefaultEmbedding ? " checked" : "") + '> Embedding mặc định của workspace</label>' +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:22px"><input id="peEnabled" type="checkbox" style="flex:0"' + (row.enabled ? " checked" : "") + "> Bật provider</label></div>" +
        '<div class="row" style="margin-top:14px"><button id="peSave">Kiểm tra & lưu</button><button id="peCancel" class="ghost">Hủy</button><span id="peMsg" class="muted"></span></div>';
      document.body.appendChild(dlg); dlg.showModal();
      $("#peCancel", dlg).onclick = function () { dlg.close(); };
      dlg.onclose = function () { dlg.remove(); };
      $("#peSave", dlg).onclick = function () {
        var body = {
          defaultModel: $("#peChat", dlg).value.trim() || null,
          defaultEmbeddingModel: $("#peEmbed", dlg).value.trim() || null,
          embeddingDimensions: parseInt($("#peDim", dlg).value, 10) || null,
          isDefaultEmbedding: $("#peDefault", dlg).checked,
          enabled: $("#peEnabled", dlg).checked
        };
        var key = $("#peKey", dlg).value.trim(); if (key) body.apiKey = key;
        $("#peSave", dlg).disabled = true; $("#peMsg", dlg).textContent = "Đang kiểm tra...";
        api("/v1/providers-db/" + row.id, { method: "PATCH", body: body })
          .then(function () { toast("Đã cập nhật provider"); dlg.close(); PAGES.providers(); })
          .catch(function (e) { $("#peSave", dlg).disabled = false; $("#peMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }

    Promise.all([api("/v1/providers"), api("/v1/providers-db").catch(function () { return { providers: [] }; })]).then(function (rs) {
      var live = rs[0].providers || [];
      var dbRows = rs[1].providers || [];
      var dbByName = {};
      dbRows.forEach(function (d) { dbByName[d.name] = d; });
      var listEl = $("#pvList");
      listEl.innerHTML = "";

      function addRow(p, dbRow, offline) {
        var box = el("div", { style: "border-bottom:1px solid var(--border);padding:10px 0" });
        var head = el("div", { "class": "row", style: "justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap" });
        var pills = '<span class="pill">' + esc(kindLabel(p, dbRow)) + "</span> ";
        if (offline) {
          pills += '<span class="pill">đã tắt</span>';
        } else if (p.kind === "codex") {
          var accs = p.accounts || [];
          pills += accs.length ? '<span class="pill ok">' + accs.length + " tài khoản</span>" : '<span class="pill err">chưa đăng nhập</span>';
          if (accs.some(function (a) { return a.status === "needs_reauth"; })) pills += ' <span class="pill err">có tài khoản cần đăng nhập lại</span>';
        } else if (p.kind === "claude-code" || p.kind === "antigravity") {
          if (p.cliInstalled === false) pills += '<span class="pill err">chưa cài CLI</span>';
          else pills += p.loggedIn ? '<span class="pill ok">đã đăng nhập</span>' : '<span class="pill err">chưa đăng nhập</span>';
        } else if (dbRow) {
          pills += dbRow.hasKey ? '<span class="pill ok">API key</span>' : '<span class="pill err">thiếu key</span>';
        }
        var modelInfo = "";
        if (dbRow && dbRow.defaultModel) modelInfo += ' <span class="muted" style="font-size:.78rem">chat: ' + esc(dbRow.defaultModel) + "</span>";
        if (dbRow && dbRow.defaultEmbeddingModel) modelInfo += ' <span class="muted" style="font-size:.78rem">embedding: ' + esc(dbRow.defaultEmbeddingModel) + " (" + esc(dbRow.embeddingDimensions || "auto") + "D)</span>";
        if (dbRow && dbRow.isDefaultEmbedding) modelInfo += ' <span class="pill ok">embedding mặc định</span>';
        head.innerHTML = "<span><b>" + esc(p.name) + "</b> " + pills + modelInfo + "</span>";
        var btns = el("span", { "class": "row", style: "gap:6px;align-items:center" });
        head.appendChild(btns);
        box.appendChild(head);
        var detail = el("div", { style: "margin:8px 0 0 14px;display:none" });
        box.appendChild(detail);
        var detailBuilt = false;

        function toggleDetail(build) {
          if (!detailBuilt) { build(); detailBuilt = true; }
          detail.style.display = detail.style.display === "none" ? "" : "none";
        }

        if (!offline && (p.kind === "claude-code" || p.kind === "antigravity")) {
          var label = kindLabel(p, dbRow);
          var buildCli = function () {
            var loginBtn = el("button", { "class": "ghost sm" }, p.loggedIn ? "Đăng nhập lại" : "Lấy link đăng nhập");
            loginBtn.onclick = function () { cliLoginFlow(detail, p, label, loginBtn); };
            var lr = el("div", { "class": "row", style: "align-items:center;gap:8px" });
            lr.appendChild(loginBtn);
            if (p.kind === "claude-code") {
              lr.appendChild(el("span", { "class": "muted", style: "font-size:.78rem" }, "Token có hạn 1 năm — hết hạn thì đăng nhập lại tại đây."));
            }
            detail.appendChild(lr);
            if (p.kind === "claude-code") {
              var tokRow = el("div", { "class": "row", style: "margin-top:8px" });
              tokRow.innerHTML =
                '<input class="pv-tok" type="password" autocomplete="off" placeholder="hoặc dán token sk-ant-… (lấy bằng lệnh: claude setup-token)" style="flex:1">' +
                '<button class="ghost sm pv-tok-btn">Lưu token</button><span class="muted pv-tok-msg"></span>';
              detail.appendChild(tokRow);
              var tokIn = tokRow.querySelector(".pv-tok"), tokBtn = tokRow.querySelector(".pv-tok-btn"), tokMsg = tokRow.querySelector(".pv-tok-msg");
              tokBtn.onclick = function () {
                var t = tokIn.value.trim();
                if (!t) { tokMsg.innerHTML = '<span class="err">Hãy dán token</span>'; return; }
                tokBtn.disabled = true; tokMsg.textContent = "Đang kiểm tra token...";
                api("/v1/providers/" + p.name + "/login/token", { method: "POST", body: { token: t } })
                  .then(function (r) { toast("Claude: " + (r.message || "token hợp lệ")); PAGES.providers(); })
                  .catch(function (e) { tokBtn.disabled = false; tokMsg.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
              };
            }
          };
          if (p.cliInstalled === false) {
            // Máy chủ chưa có file chạy của CLI: hướng dẫn cài thay vì để bấm đăng nhập rồi lỗi.
            var cliName = p.kind === "claude-code" ? "claude" : "agy";
            var howB = el("button", { "class": "sm" }, "Cách cài");
            howB.onclick = function () {
              toggleDetail(function () {
                detail.innerHTML =
                  '<div class="muted" style="font-size:.85rem;line-height:1.6">Máy chủ chưa có công cụ dòng lệnh <code>' + cliName + "</code> của " + esc(label) + ". " +
                  "Đăng nhập SSH vào máy chủ rồi chạy:<br><code>sudo penai install-cli " + cliName + "</code><br>" +
                  "(máy cài nhiều bản PenAI thì thêm <code>--instance &lt;tên&gt;</code> sau chữ penai). Cài xong tải lại trang này rồi bấm <b>Đăng nhập</b>.</div>";
              });
            };
            btns.appendChild(howB);
          } else if (p.loggedIn) {
            var moreB = el("button", { "class": "ghost sm" }, "Chi tiết");
            moreB.onclick = function () { toggleDetail(buildCli); };
            btns.appendChild(moreB);
          } else {
            var loginNow = el("button", { "class": "sm" }, "Đăng nhập");
            loginNow.onclick = function () {
              if (!detailBuilt) { buildCli(); detailBuilt = true; }
              detail.style.display = "";
              var inner = detail.querySelector("button");
              if (inner) inner.click();
              loginNow.style.display = "none";
            };
            btns.appendChild(loginNow);
          }
        } else if (!offline && p.kind === "codex") {
          var accs2 = p.accounts || [];
          var addB = el("button", { "class": "sm" }, accs2.length ? "＋ Tài khoản" : "Đăng nhập ChatGPT");
          addB.onclick = function () { codexLogin(detail, p.name, addB, accs2.length); };
          btns.appendChild(addB);
          if (accs2.length) {
            var accB = el("button", { "class": "ghost sm" }, "Chi tiết");
            accB.onclick = function () {
              toggleDetail(function () {
                accs2.forEach(function (a) {
                  var ar = el("div", { "class": "row", style: "justify-content:space-between;align-items:center;margin:4px 0" });
                  ar.innerHTML = "<span>👤 " + esc(a.email || a.alias) + " " + accStatusHtml(a) + "</span>";
                  var abtns = el("span");
                  if (a.status === "needs_reauth") {
                    var re = el("button", { "class": "ghost sm" }, "Đăng nhập lại");
                    re.onclick = function () { codexLogin(p.name, re, undefined); };
                    abtns.appendChild(re); abtns.appendChild(document.createTextNode(" "));
                  }
                  var delA = el("button", { "class": "ghost sm" }, "Gỡ");
                  delA.onclick = function () {
                    if (!confirm("Gỡ tài khoản " + (a.email || a.alias) + " khỏi pool?")) return;
                    api("/v1/providers/" + p.name + "/accounts/" + encodeURIComponent(a.alias), { method: "DELETE" })
                      .then(function () { toast("Đã gỡ"); PAGES.providers(); })
                      .catch(function (e) { toast(e.message, 1); });
                  };
                  abtns.appendChild(delA);
                  ar.appendChild(abtns);
                  detail.appendChild(ar);
                });
                var hint = el("div", { "class": "muted", style: "font-size:.78rem;margin-top:4px" });
                hint.textContent = "Thêm tài khoản thứ 2, 3... để nhiều người chat cùng lúc — hệ thống tự chia việc, tài khoản hết quota tự chuyển.";
                detail.appendChild(hint);
              });
            };
            btns.appendChild(accB);
          }
        } else if (dbRow) {
          var editB = el("button", { "class": "ghost sm" }, "Cấu hình");
          editB.onclick = function () { openProviderEdit(dbRow); };
          btns.appendChild(editB);
          var delB = el("button", { "class": "ghost sm" }, "Xóa");
          delB.onclick = function () {
            if (!confirm("Xóa provider " + p.name + "?")) return;
            api("/v1/providers-db/" + dbRow.id, { method: "DELETE" })
              .then(function () { toast("Đã xóa"); PAGES.providers(); })
              .catch(function (e) { toast(e.message, 1); });
          };
          btns.appendChild(delB);
        }
        listEl.appendChild(box);
      }

      live.forEach(function (p) { addRow(p, dbByName[p.name] || null, false); });
      // Provider DB đang tắt (không nạp runtime) vẫn hiện để quản lý
      dbRows.forEach(function (d) {
        if (!live.some(function (p) { return p.name === d.name; })) addRow({ name: d.name, kind: "llm" }, d, true);
      });
      if (!listEl.childNodes.length) listEl.innerHTML = '<span class="muted">(chưa có provider nào)</span>';
    }).catch(function (e) { $("#pvList").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });

    // Dialog thêm provider bằng API key: một credential phục vụ cả chat và embedding.
    function openProviderCreate() {
      var dlg = el("dialog", { style: "width:720px;max-width:95vw;padding:20px" });
      dlg.innerHTML =
        '<h3 style="margin:0 0 4px">Thêm provider bằng API key</h3>' +
        '<div class="muted" style="margin-bottom:12px">Provider gói subscription (ChatGPT, Claude Max, Antigravity) đã được hệ thống cấu hình sẵn ở danh sách — mục này chỉ dành cho provider dùng API key.</div>' +
        '<div class="row"><div style="flex:1"><label>Tên provider</label><input id="pName" placeholder="vd: openai" style="width:100%"><div id="pNameHint" class="muted" style="font-size:.75rem"></div></div>' +
        '<div style="flex:1"><label>Loại provider</label><select id="pKind" style="width:100%"><option value="openai">OpenAI API</option><option value="gemini">Gemini API</option><option value="qwen">Qwen API</option><option value="anthropic">Anthropic (chỉ chat)</option><option value="openai-compat">OpenAI-compatible khác</option></select></div></div>' +
        '<div id="pBaseWrap"><label>Base URL</label><input id="pBase" style="width:100%"></div>' +
        '<label>API key</label><input id="pKey" type="password" autocomplete="off" placeholder="Dán API key của provider" style="width:100%">' +
        '<div class="row" style="margin-top:8px"><button id="pPreview" class="ghost">Kiểm tra key & tải model</button><span id="pCheck" class="muted"></span></div>' +
        '<div id="pModelWrap" style="margin-top:8px"><label>Model chat mặc định</label><div class="row"><select id="pModelSelect" style="flex:1"><option value="">— kiểm tra key để tải model —</option></select><input id="pModelFree" placeholder="hoặc nhập model chat ID" style="flex:1"></div></div>' +
        '<div id="pEmbedWrap" style="margin-top:8px"><label>Model embedding</label><div class="row"><select id="pEmbedSelect" style="flex:1"><option value="">— kiểm tra key để tải model —</option></select><input id="pEmbedFree" placeholder="hoặc nhập model embedding ID" style="flex:1"><input id="pEmbedDim" type="number" min="64" max="4096" value="768" title="Số chiều vector" style="width:90px"></div>' +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:6px"><input id="pEmbedDefault" type="checkbox" style="flex:0"> Dùng làm embedding mặc định của workspace</label></div>' +
        '<div class="row" style="margin-top:14px"><button id="pCreate">Thêm provider</button><button id="pCancel" class="ghost">Hủy</button><span id="pMsg" class="muted"></span></div>';
      document.body.appendChild(dlg);
      dlg.showModal();
      $("#pCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      dlg.onclose = function () { dlg.remove(); };

      var providerNameTouched = false;
      var providerModelsLoaded = false;
      function apiProviderKind() { return $("#pKind", dlg).value; }
      function normalizedProviderName() { return slugifyKey($("#pName", dlg).value).slice(0, 60); }
      function showProviderName() {
        var normalized = normalizedProviderName();
        $("#pNameHint", dlg).textContent = normalized && normalized !== $("#pName", dlg).value ? "Sẽ lưu thành: " + normalized : "Chỉ dùng chữ thường, số và gạch ngang.";
      }
      function resetProviderModels() {
        providerModelsLoaded = false;
        $("#pModelSelect", dlg).innerHTML = '<option value="">— kiểm tra key để tải model —</option>';
        $("#pEmbedSelect", dlg).innerHTML = '<option value="">— kiểm tra key để tải model —</option>';
      }
      function applyProviderKind() {
        var kind = $("#pKind", dlg).value;
        var defaults = { openai: "openai-api", gemini: "gemini-api", qwen: "qwen-api", anthropic: "anthropic", "openai-compat": "llm-custom" };
        if (!providerNameTouched || !$("#pName", dlg).value.trim()) $("#pName", dlg).value = defaults[kind];
        var base = $("#pBase", dlg);
        base.disabled = kind === "openai" || kind === "gemini";
        if (kind === "openai") { base.value = ""; base.placeholder = "Tự động: https://api.openai.com/v1"; }
        else if (kind === "gemini") { base.value = ""; base.placeholder = "Tự động: Gemini API chính thức"; }
        else if (kind === "qwen") base.placeholder = "Endpoint workspace ...aliyuncs.com/compatible-mode/v1 (hoặc để trống)";
        else if (kind === "anthropic") base.placeholder = "Để trống = Anthropic mặc định";
        else base.placeholder = "Bắt buộc, vd: https://openrouter.ai/api/v1";
        $("#pEmbedWrap", dlg).style.display = kind === "anthropic" ? "none" : "";
        showProviderName(); resetProviderModels();
      }
      function previewProviderModels() {
        var key = $("#pKey", dlg).value.trim();
        var baseUrl = $("#pBase", dlg).value.trim();
        if (!key) { $("#pCheck", dlg).innerHTML = '<span class="err">Hãy dán API key trước</span>'; return Promise.reject(new Error("thiếu key")); }
        if ($("#pKind", dlg).value === "openai-compat" && !baseUrl) { $("#pCheck", dlg).innerHTML = '<span class="err">Provider tùy chỉnh cần Base URL</span>'; return Promise.reject(new Error("thiếu base URL")); }
        var body = { kind: apiProviderKind(), apiKey: key };
        if (baseUrl) body.baseUrl = baseUrl;
        $("#pPreview", dlg).disabled = true; $("#pCheck", dlg).textContent = "Đang kiểm tra...";
        return api("/v1/providers/preview-models", { method: "POST", body: body }).then(function (j) {
          providerModelsLoaded = true;
          var models = j.models || [];
          var embeddingModels = j.embeddingModels || [];
          $("#pModelSelect", dlg).innerHTML = '<option value="">— chọn model —</option>' + models.map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.displayName || x.slug) + "</option>"; }).join("");
          $("#pEmbedSelect", dlg).innerHTML = '<option value="">— chọn model embedding —</option>' + embeddingModels.map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.displayName || x.slug) + "</option>"; }).join("");
          var kind = $("#pKind", dlg).value;
          var preferred = $("#pModelFree", dlg).value.trim() || (kind === "openai" ? "gpt-4.1-mini" : kind === "gemini" ? "gemini-3.7-flash" : kind === "qwen" ? "qwen-plus" : "");
          if (preferred && models.some(function (x) { return x.slug === preferred; })) { $("#pModelSelect", dlg).value = preferred; $("#pModelFree", dlg).value = preferred; }
          if (!$("#pModelFree", dlg).value && models[0]) { $("#pModelSelect", dlg).value = models[0].slug; $("#pModelFree", dlg).value = models[0].slug; }
          var preferredEmbed = $("#pEmbedFree", dlg).value.trim() || (kind === "openai" ? "text-embedding-3-small" : kind === "gemini" ? "gemini-embedding-2" : kind === "qwen" ? "text-embedding-v4" : "");
          if (preferredEmbed && embeddingModels.some(function (x) { return x.slug === preferredEmbed; })) { $("#pEmbedSelect", dlg).value = preferredEmbed; $("#pEmbedFree", dlg).value = preferredEmbed; }
          if (!$("#pEmbedFree", dlg).value && embeddingModels[0]) { $("#pEmbedSelect", dlg).value = embeddingModels[0].slug; $("#pEmbedFree", dlg).value = embeddingModels[0].slug; }
          $("#pCheck", dlg).innerHTML = '<span class="ok">✓ key hợp lệ · ' + models.length + " model chat · " + embeddingModels.length + " model embedding</span>";
          return j;
        }).catch(function (e) {
          providerModelsLoaded = false;
          $("#pCheck", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>";
          throw e;
        }).finally(function () { $("#pPreview", dlg).disabled = false; });
      }
      $("#pName", dlg).oninput = function () { providerNameTouched = true; showProviderName(); };
      $("#pName", dlg).onblur = function () { var normalized = normalizedProviderName(); if (normalized) $("#pName", dlg).value = normalized; showProviderName(); };
      $("#pKind", dlg).onchange = applyProviderKind;
      $("#pBase", dlg).oninput = resetProviderModels;
      $("#pKey", dlg).oninput = function () { if (providerModelsLoaded) resetProviderModels(); $("#pCheck", dlg).textContent = ""; };
      $("#pModelSelect", dlg).onchange = function () { if ($("#pModelSelect", dlg).value) $("#pModelFree", dlg).value = $("#pModelSelect", dlg).value; };
      $("#pEmbedSelect", dlg).onchange = function () { if ($("#pEmbedSelect", dlg).value) $("#pEmbedFree", dlg).value = $("#pEmbedSelect", dlg).value; };
      $("#pPreview", dlg).onclick = function () { previewProviderModels().catch(function () {}); };
      applyProviderKind();
      $("#pCreate", dlg).onclick = function () {
        var name = normalizedProviderName();
        var key = $("#pKey", dlg).value.trim();
        var baseUrl = $("#pBase", dlg).value.trim();
        var model = $("#pModelFree", dlg).value.trim() || $("#pModelSelect", dlg).value;
        var embeddingModel = $("#pEmbedFree", dlg).value.trim() || $("#pEmbedSelect", dlg).value;
        var dimensions = parseInt($("#pEmbedDim", dlg).value, 10) || 768;
        if (!name || !key) { $("#pMsg", dlg).innerHTML = '<span class="err">Hãy nhập tên và API key</span>'; return; }
        if ($("#pKind", dlg).value === "openai-compat" && !baseUrl) { $("#pMsg", dlg).innerHTML = '<span class="err">Provider tùy chỉnh cần Base URL</span>'; return; }
        if (!model) { $("#pMsg", dlg).innerHTML = '<span class="err">Hãy tải/chọn model hoặc nhập model ID</span>'; return; }
        if (["openai", "gemini", "qwen"].includes($("#pKind", dlg).value) && !embeddingModel) { $("#pMsg", dlg).innerHTML = '<span class="err">Hãy chọn model embedding</span>'; return; }
        var body = { name: name, kind: apiProviderKind(), apiKey: key, defaultModel: model };
        if (embeddingModel) { body.defaultEmbeddingModel = embeddingModel; body.embeddingDimensions = dimensions; body.isDefaultEmbedding = $("#pEmbedDefault", dlg).checked; }
        if (baseUrl) body.baseUrl = baseUrl;
        $("#pCreate", dlg).disabled = true; $("#pMsg", dlg).textContent = "Đang kiểm tra và lưu...";
        api("/v1/providers-db", { method: "POST", body: body })
          .then(function () { toast("Đã thêm provider — dùng được ngay"); dlg.close(); PAGES.providers(); })
          .catch(function (e) { $("#pMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; $("#pCreate", dlg).disabled = false; });
      };
    }
  };

  // Generic CRUD resource page
  function crudPage(cfg) {
    return function () {
      var m = page(cfg.title, cfg.sub);
      var c = card(m, "Tạo mới");
      var form = el("div"); form.innerHTML = cfg.formHtml; c.appendChild(form);
      var btn = el("button", null, cfg.btnLabel || "Tạo"); var msg = el("span", { "class": "muted", style: "margin-left:8px" });
      var brow = el("div", { "class": "row", style: "margin-top:8px" }); brow.appendChild(btn); brow.appendChild(msg); c.appendChild(brow);
      if (cfg.betweenHtml) { var midC = card(m); midC.innerHTML = cfg.betweenHtml; }
      var listC = card(m, "Danh sách");
      function load() {
        api(cfg.list).then(function (j) {
          listC.innerHTML = "<h3>Danh sách</h3>";
          listC.appendChild(table(cfg.cols, j[cfg.key] || [], function (r) {
            var tr = el("tr"); tr.innerHTML = cfg.rowHtml(r);
            if (cfg.del) { var td = el("td"); var del = el("button", { "class": "ghost sm" }, "Xóa"); del.onclick = function () { if (confirm("Xóa?")) api(cfg.del(r), { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); }); }; td.appendChild(del); tr.appendChild(td); }
            if (cfg.extraCell) cfg.extraCell(tr, r, load);
            return tr;
          }));
        }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      }
      btn.onclick = function () {
        var body = cfg.collect(); if (!body) { msg.innerHTML = '<span class="err">thiếu thông tin</span>'; return; }
        // create mặc định = chính endpoint danh sách (POST cùng collection);
        // trước đây cfg.create luôn undefined → nút Tạo gọi vào "/undefined".
        api(cfg.create || cfg.list, { method: "POST", body: body }).then(function (r) { toast(cfg.btnLabel ? "Đã lưu" : "Đã tạo"); msg.innerHTML = cfg.afterCreate ? cfg.afterCreate(r) : ""; load(); }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      if (cfg.onReady) cfg.onReady(load);
      load();
    };
  }

  // ---- Channels: kênh nhắn tin gắn với 1 agent ----
  var CHANNEL_HINTS = {
    telegram: 'Bot token từ <b>@BotFather</b> (dạng <code>123456:ABC-DEF...</code>). Tạo bot: nhắn /newbot cho @BotFather.',
    discord: "Bot token từ Discord Developer Portal → Bot → Reset Token. Nhớ bật MESSAGE CONTENT INTENT.",
    slack: "Bot token (xoxb-...) từ Slack App → OAuth & Permissions.",
    whatsapp: "Access token WhatsApp Cloud API (Meta for Developers).",
    zalo: "Access token Zalo Official Account.",
    zalo_personal: "Zalo cá nhân qua zca-js (unofficial). Không cần token; tạo kênh xong bấm Kết nối QR. Mọi tin nhắn được lưu vào Inbox để nhân viên cùng xem/trả lời (tắt được trong Inbox → Cài đặt). AI chỉ tự trả lời trong thread được chỉ định demo (hoặc mọi tin riêng nếu tắt pairing).",
    whatsapp_personal: "WhatsApp cá nhân (kết nối không chính thức, kiểu thiết bị đã liên kết). Không cần token; tạo kênh xong bấm Kết nối QR. Điện thoại vẫn dùng WhatsApp bình thường. Mọi tin nhắn được lưu vào Inbox để nhân viên cùng xem/trả lời. AI chỉ tự trả lời trong hội thoại được chỉ định (hoặc mọi tin riêng nếu tắt pairing). Nên dùng số dành riêng — WhatsApp có thể khóa số gửi dồn cho người lạ.",
    feishu: "App credentials Feishu/Lark (app_id:app_secret).",
    msteams: "Bot Microsoft Teams qua Azure Bot. Token = <b>client secret</b> của App Registration; điền thêm App ID + Tenant ID bên dưới. Azure Bot → Configuration → Messaging endpoint phải trỏ: <code>" + location.origin + "/webhooks/teams</code>."
  };

  // Tên hiển thị của loại kênh: mã "zalo" là Zalo Official Account — ghi rõ để khỏi nhầm với zalo_personal
  function channelKindLabel(k) { return k === "zalo" ? "Zalo OA" : k; }
  // Kênh "tài khoản cá nhân": đăng nhập bằng mã QR, có Inbox trực chat và chế độ an toàn
  var PERSONAL_KINDS = { zalo_personal: "Zalo", whatsapp_personal: "WhatsApp" };
  function isPersonalKind(k) { return !!PERSONAL_KINDS[k]; }
  function platformName(k) { return PERSONAL_KINDS[k] || "Zalo"; }
  // Loại kênh chưa hoàn thiện: không cho tạo mới từ Dashboard (kênh đã tạo vẫn chạy và sửa được)
  var HIDDEN_CHANNEL_KINDS = { whatsapp: true };

  function agentSelectHtml(id) {
    return '<select id="' + id + '" style="flex:1"></select>';
  }
  function fillAgentSelect(root, selId, selectedKey, cb) {
    api("/v1/agents").then(function (j) {
      $(selId, root).innerHTML = j.agents.map(function (a) {
        return '<option value="' + esc(a.key) + '"' + (a.key === selectedKey ? " selected" : "") + ">" + esc(a.name) + " (" + esc(a.key) + ")</option>";
      }).join("");
      if (cb) cb(j.agents);
    });
  }

  function openChannelDialog(existing, kinds, onDone) {
    var isEdit = !!existing;
    var dlg = el("dialog", { style: "width:620px;max-width:95vw;padding:20px" });
    dlg.innerHTML =
      '<h3 style="margin:0 0 4px">' + (isEdit ? "Sửa channel: " + esc(existing.name) : "Thêm kênh chat") + "</h3>" +
      '<div class="muted" style="margin-bottom:12px">' + (isEdit ? "Đổi agent/token/pairing sẽ áp dụng NGAY sau khi lưu (channel tự khởi động lại)." : "Kênh nhắn tin (Telegram, Discord...) nối người dùng với một agent. Mỗi kênh gắn đúng 1 agent.") + "</div>" +
      '<div class="row"><div style="flex:1"><label>Loại kênh</label><select id="cKind" style="width:100%"' + (isEdit ? " disabled" : "") + ">" +
      kinds.filter(function (k) { return !HIDDEN_CHANNEL_KINDS[k] || (isEdit && existing.kind === k); }).map(function (k) { return '<option value="' + esc(k) + '"' + (isEdit && existing.kind === k ? " selected" : "") + ">" + esc(channelKindLabel(k)) + "</option>"; }).join("") +
      '</select></div><div style="flex:1"><label>Tên kênh</label><input id="cName" placeholder="vd: Bot CSKH" style="width:100%" value="' + (isEdit ? esc(existing.name) : "") + '"></div></div>' +
      '<label style="margin-top:10px">Agent trả lời trên kênh này *</label><div class="row">' + agentSelectHtml("cAgent") + "</div>" +
      '<div id="cTokenWrap"><label style="margin-top:10px">Token / credential' + (isEdit ? ' <span class="muted">(bỏ trống = giữ token cũ)</span>' : " *") + "</label>" +
      '<input id="cToken" placeholder="bot token..." style="width:100%"></div>' +
      '<div id="cTeamsWrap" style="display:none"><div class="row" style="margin-top:8px">' +
      '<div style="flex:1"><label>Microsoft App ID *</label><input id="cAppId" placeholder="00000000-0000-0000-0000-000000000000" style="width:100%" value="' + (isEdit ? esc((existing.config || {}).appId || "") : "") + '"></div>' +
      '<div style="flex:1"><label>Tenant ID <span class="muted">(bot Single Tenant; Multi Tenant để trống)</span></label><input id="cTenant" placeholder="35ee052b-..." style="width:100%" value="' + (isEdit ? esc((existing.config || {}).tenantId || "") : "") + '"></div></div></div>' +
      '<div class="muted" id="cHint" style="font-size:.78rem;margin-top:4px"></div>' +
      '<div class="row" style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cAgentReply"' + (isEdit && (existing.config || {}).agent_reply === false ? "" : " checked") + "> Agent tự trả lời</label>" +
      '<span class="muted" style="font-size:.78rem">Bỏ tick: kênh vẫn kết nối và lưu tin (Inbox), AI không trả lời; lịch hẹn vẫn gửi</span></div>' +
      '<div class="row" style="margin-top:6px"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cPair"' + (isEdit ? (existing.requirePairing ? " checked" : "") : " checked") + "> Yêu cầu pairing</label>" +
      '<span class="muted" style="font-size:.78rem">Người lạ nhắn lần đầu phải được admin duyệt mã (an toàn, nên bật)</span></div>' +
      (isEdit ? '<div class="row" style="margin-top:6px"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cEnabled"' + (existing.enabled ? " checked" : "") + "> Đang hoạt động</label><span class='muted' style='font-size:.78rem'>Bỏ tick để tạm dừng kênh</span></div>" : "") +
      '<div class="row" style="margin-top:14px"><button id="cSave">' + (isEdit ? "Lưu & khởi động lại" : "Tạo kênh") + '</button><button class="ghost" id="cCancel">Hủy</button><span id="cMsg" class="muted"></span></div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    fillAgentSelect(dlg, "#cAgent", isEdit ? existing.agentKey : null);
    function showHint() {
      var kind = $("#cKind", dlg).value;
      $("#cHint", dlg).innerHTML = CHANNEL_HINTS[kind] || "";
      $("#cTokenWrap", dlg).style.display = isPersonalKind(kind) ? "none" : "block";
      $("#cTeamsWrap", dlg).style.display = kind === "msteams" ? "block" : "none";
      $("#cPair", dlg).disabled = false;
    }
    $("#cKind", dlg).onchange = showHint; showHint();
    $("#cCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
    $("#cSave", dlg).onclick = function () {
      var name = $("#cName", dlg).value.trim();
      var token = $("#cToken", dlg).value.trim();
      var kind = $("#cKind", dlg).value;
      var agentKey = $("#cAgent", dlg).value;
      var errs = [];
      if (!name) errs.push("nhập Tên kênh");
      if (!agentKey) errs.push("chọn Agent (chưa có thì tạo ở trang Agents trước)");
      if (!isEdit && !token && !isPersonalKind(kind)) errs.push("nhập Token");
      if (kind === "msteams" && !$("#cAppId", dlg).value.trim()) errs.push("nhập Microsoft App ID");
      if (errs.length) { $("#cMsg", dlg).innerHTML = '<span class="err">' + esc(errs.join(" · ")) + "</span>"; return; }
      $("#cMsg", dlg).textContent = "Đang lưu...";
      var body;
      if (isEdit) {
        body = { name: name, agentKey: agentKey, requirePairing: $("#cPair", dlg).checked, enabled: $("#cEnabled", dlg).checked };
        if (token) body.token = token;
      } else {
        body = { kind: kind, name: name, agentKey: agentKey, token: token, requirePairing: $("#cPair", dlg).checked };
      }
      if (kind === "msteams") {
        body.config = { appId: $("#cAppId", dlg).value.trim(), tenantId: $("#cTenant", dlg).value.trim() };
      }
      body.config = Object.assign(body.config || {}, { agent_reply: $("#cAgentReply", dlg).checked });
      var req = isEdit
        ? api("/v1/channels/" + existing.id, { method: "PATCH", body: body })
        : api("/v1/channels", { method: "POST", body: body });
      req.then(function (r) { toast(r.note || "Đã lưu"); dlg.close(); dlg.remove(); onDone(); })
        .catch(function (e) { $("#cMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
  }

  function openPairings(ch, onDone) {
    var dlg = el("dialog", { style: "width:520px;padding:18px" });
    dlg.innerHTML = '<h3 style="margin:0 0 8px">Pairing chờ duyệt — ' + esc(ch.name) + '</h3><div id="pList" class="muted">Đang tải...</div>' +
      '<div class="row" style="margin-top:12px"><button class="ghost" id="pClose">Đóng</button></div>';
    document.body.appendChild(dlg); dlg.showModal();
    $("#pClose", dlg).onclick = function () { dlg.close(); dlg.remove(); if (onDone) onDone(); };
    function loadP() {
      api("/v1/channels/" + ch.id + "/pairings").then(function (j) {
        var box = $("#pList", dlg);
        if (!j.pending.length) { box.innerHTML = '<span class="muted">Không có yêu cầu nào chờ duyệt. Người dùng mới nhắn cho bot sẽ nhận được mã pairing và hiện ở đây.</span>'; return; }
        box.innerHTML = "";
        j.pending.forEach(function (p) {
          var row = el("div", { "class": "row", style: "justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0" });
          row.innerHTML = "<span><code>" + esc(p.code) + "</code> · " + (p.displayName ? esc(p.displayName) + " " : "người dùng ") + "<code>" + esc(p.externalUserId || "?") + "</code></span>";
          var ok = el("button", { "class": "sm" }, "Duyệt");
          ok.onclick = function () {
            api("/v1/channels/" + ch.id + "/pairings/" + p.code + "/approve", { method: "POST" })
              .then(function () { toast("Đã duyệt " + p.code); loadP(); if (onDone) onDone(); })
              .catch(function (e) { toast(e.message, 1); });
          };
          row.appendChild(ok); box.appendChild(row);
        });
      }).catch(function (e) { $("#pList", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    loadP();
  }

  function openZaloPersonal(ch, onDone) {
    var dlg = el("dialog", { style: "width:640px;max-width:95vw;padding:18px" });
    var pollTimer = null;
    var P = platformName(ch.kind), isWa = ch.kind === "whatsapp_personal";
    dlg.innerHTML = '<h3 style="margin:0 0 8px">Kết nối ' + P + ' cá nhân — ' + esc(ch.name) + '</h3>' +
      '<div class="muted" style="margin-bottom:10px">' + (isWa
        ? "Kết nối không chính thức, PenAI là một «thiết bị đã liên kết» của tài khoản WhatsApp — điện thoại vẫn dùng bình thường. WhatsApp có thể giới hạn hoặc khóa số gửi dồn cho người lạ; nên dùng số dành riêng."
        : "Tích hợp dùng zca-js/API không chính thức; không mở Zalo Web bằng cùng tài khoản trong lúc hệ thống đang lắng nghe.") + '<br><b>Chế độ an toàn luôn bật:</b> sau đăng nhập bot chỉ QUAN SÁT — ghi nhận ai/nhóm nhắn tới (tên, id), không trả lời, không tự gửi tin. Chỉ thread được chỉ định demo bên dưới mới được nhận/gửi. Ngoại lệ: nếu kênh <b>tắt "yêu cầu pairing"</b> thì mọi tin nhắn RIÊNG (DM) được trả lời liền — nhóm vẫn phải chỉ định demo.</div>' +
      '<div id="zpState" class="muted">Đang kiểm tra...</div>' +
      '<div id="zpQr" style="text-align:center;margin:12px 0"></div>' +
      '<div class="row"><button id="zpLogin">Tạo mã QR</button><button class="ghost" id="zpLogout" style="display:none">Ngắt kết nối</button><button class="ghost" id="zpClose">Đóng</button></div>' +
      '<h4 style="margin:14px 0 4px">Thread demo được phép nhận/gửi</h4>' +
      '<div id="zpDemo" class="muted">Đang tải...</div>' +
      '<div class="row" style="margin:8px 0"><input id="zpAddKey" placeholder="group:123456789 hoặc direct:987654" style="flex:1"><button class="ghost sm" id="zpAddBtn">Thêm thủ công</button></div>' +
      '<h4 style="margin:14px 0 4px">Danh sách chờ duyệt (ai/nhóm nào nhắn tới)</h4>' +
      '<div class="muted" style="font-size:.78rem;margin-bottom:6px">Ai/nhóm nhắn tới đều tự hiện ở đây (tên + id, nhóm được ghi rõ là nhóm) — chỉ ghi tên + id + số tin, không lưu nội dung; danh sách lưu trong DB nên không mất khi restart. Bấm «Chỉ định demo» để duyệt cho bot nhận/gửi trong thread đó.</div>' +
      '<div class="row" style="margin-bottom:6px"><button class="ghost sm" id="zpObsReload">Làm mới</button></div>' +
      '<div id="zpObs" class="muted">Đang tải...</div>';
    document.body.appendChild(dlg); dlg.showModal();
    function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
    function close() { stopPoll(); dlg.close(); dlg.remove(); if (onDone) onDone(); }
    $("#zpClose", dlg).onclick = close;
    dlg.onclose = stopPoll;
    var demoThreads = [];
    function saveThreads(threads) {
      api("/v1/channels/" + ch.id + "/personal/demo-threads", { method: "PUT", body: { threads: threads } })
        .then(function () { toast("Đã cập nhật thread demo"); loadObserved(); })
        .catch(function (e) { toast(e.message, 1); });
    }
    function loadObserved() {
      api("/v1/channels/" + ch.id + "/personal/observed").then(function (j) {
        demoThreads = j.demoThreads || [];
        var demoBox = $("#zpDemo", dlg);
        var openNote = j.openDirect
          ? '<div style="margin-bottom:6px"><span class="pill ok">DM mở</span> Kênh đã <b>tắt yêu cầu pairing</b> — mọi tin nhắn RIÊNG được trả lời liền; nhóm vẫn phải chỉ định demo bên dưới.</div>'
          : "";
        if (!demoThreads.length) {
          demoBox.innerHTML = openNote + (j.openDirect
            ? '<span class="pill">nhóm: chỉ quan sát</span> Chưa chỉ định nhóm demo nào.'
            : '<span class="pill">chỉ quan sát</span> Chưa chỉ định thread nào — bot không nhắn đi đâu và không trả lời ai.');
        } else {
          demoBox.innerHTML = openNote;
          demoThreads.forEach(function (key) {
            var row = el("div", { "class": "row", style: "justify-content:space-between;border-bottom:1px solid var(--border);padding:4px 0" });
            row.innerHTML = '<span><span class="pill ok">demo</span> <code>' + esc(key) + "</code></span>";
            var rm = el("button", { "class": "ghost sm" }, "Bỏ");
            rm.onclick = function () {
              saveThreads(demoThreads.filter(function (k) { return k !== key; }));
            };
            row.appendChild(rm); demoBox.appendChild(row);
          });
        }
        var obsBox = $("#zpObs", dlg);
        var peers = j.peers || [];
        if (!peers.length) {
          obsBox.innerHTML = '<span class="muted">Chưa ghi nhận ai nhắn tới. Sau khi đăng nhập, nhắn 1 tin vào nhóm cần demo (bằng chính tài khoản này cũng được) rồi bấm Làm mới.</span>';
          return;
        }
        obsBox.innerHTML = "";
        peers.forEach(function (p) {
          var row = el("div", { "class": "row", style: "justify-content:space-between;border-bottom:1px solid var(--border);padding:4px 0;gap:8px" });
          var when = p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString("vi-VN") : "";
          row.innerHTML = '<span style="flex:1"><span class="pill' + (p.allowed ? " ok" : "") + '">' + (p.type === "group" ? "nhóm" : "cá nhân") + "</span> " +
            esc(p.name) + ' <code style="font-size:.75rem">' + esc(p.threadId) + '</code>' +
            '<span class="muted" style="font-size:.75rem"> · ' + p.messageCount + " tin · " + esc(when) +
            (p.type === "group" ? "" : " · gửi bởi " + esc(p.lastSenderName)) + "</span></span>";
          var btn = el("button", { "class": "ghost sm" }, p.allowed ? "Bỏ demo" : "Chỉ định demo");
          btn.onclick = function () {
            if (p.allowed) {
              saveThreads(demoThreads.filter(function (k) { return k !== p.chatKey; }));
            } else if (confirm('Cho phép bot nhận/gửi tin trong "' + p.name + '" (' + p.chatKey + ')?')) {
              saveThreads(demoThreads.concat([p.chatKey]));
            }
          };
          row.appendChild(btn); obsBox.appendChild(row);
        });
      }).catch(function (e) {
        $("#zpObs", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>";
      });
    }
    $("#zpObsReload", dlg).onclick = loadObserved;
    $("#zpAddBtn", dlg).onclick = function () {
      var key = $("#zpAddKey", dlg).value.trim();
      var keyOk = (key.indexOf("group:") === 0 || key.indexOf("direct:") === 0) && key.split(":")[1] && key.indexOf(" ") < 0;
      if (!keyOk) { toast('Định dạng: "group:<id>" hoặc "direct:<id>"', 1); return; }
      if (demoThreads.indexOf(key) >= 0) { toast("Thread đã có trong danh sách"); return; }
      saveThreads(demoThreads.concat([key]));
      $("#zpAddKey", dlg).value = "";
    };
    function showStatus() {
      api("/v1/channels/" + ch.id + "/personal/status").then(function (j) {
        var s = j.status;
        if (s.connected) {
          $("#zpState", dlg).innerHTML = '<span class="pill ok">đã kết nối</span> ' + esc(s.account ? s.account.name : P) +
            (s.listening ? ' · đang nhận tin' : ' · listener đang nối lại');
          $("#zpLogin", dlg).style.display = "none";
          $("#zpLogout", dlg).style.display = "inline-block";
          $("#zpQr", dlg).innerHTML = "";
        } else {
          $("#zpState", dlg).innerHTML = '<span class="pill">chưa kết nối</span>' + (s.error ? ' · <span class="err">' + esc(s.error) + '</span>' : '');
          $("#zpLogin", dlg).style.display = "inline-block";
          $("#zpLogout", dlg).style.display = "none";
        }
      }).catch(function (e) { $("#zpState", dlg).innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }
    function pollLogin(loginId) {
      api("/v1/channels/" + ch.id + "/personal/login/" + loginId).then(function (j) {
        var s = j.login;
        if (s.pairingCode) {
          $("#zpQr", dlg).innerHTML = '<div class="muted">Mã liên kết bằng số điện thoại</div><div style="font-size:2rem;font-weight:700;letter-spacing:5px;margin:6px 0">' + esc(s.pairingCode) + '</div><div class="muted">Trên điện thoại: WhatsApp → Cài đặt → Thiết bị đã liên kết → Liên kết thiết bị → <b>Liên kết bằng số điện thoại</b> → nhập mã này.</div>';
        } else if (s.qrDataUrl) {
          $("#zpQr", dlg).innerHTML = '<img alt="QR đăng nhập ' + P + '" src="' + s.qrDataUrl + '" style="width:280px;max-width:90%;background:white;padding:8px;border-radius:10px"><div class="muted">' +
            (isWa ? 'Trên điện thoại: WhatsApp → Cài đặt → Thiết bị đã liên kết → Liên kết thiết bị → quét mã này. Mã tự đổi sau mỗi 20–60 giây.<div style="margin-top:6px"><a href="#" id="zpPair">Không quét được? Liên kết bằng số điện thoại</a></div>' : "Mở Zalo trên điện thoại → quét QR → xác nhận đăng nhập") + "</div>";
          var pl = $("#zpPair", dlg);
          if (pl) pl.onclick = function (ev) {
            ev.preventDefault();
            var phone = prompt("Số điện thoại của tài khoản WhatsApp cần liên kết (vd 0901234567 hoặc 84901234567):");
            if (!phone) return;
            api("/v1/channels/" + ch.id + "/personal/pairing-code", { method: "POST", body: { loginId: loginId, phone: phone } }).catch(function (e) { toast(e.message, 1); });
          };
        }
        if (s.status === "scanned") $("#zpState", dlg).textContent = "Đã quét QR" + (s.scannedName ? " bằng " + s.scannedName : "") + " — hãy xác nhận trên điện thoại...";
        if (s.status === "success") { stopPoll(); toast("Đã kết nối " + P + " cá nhân"); showStatus(); return; }
        if (s.status === "failed") { stopPoll(); $("#zpState", dlg).innerHTML = '<span class="err">' + esc(s.error || "Đăng nhập thất bại") + '</span>'; $("#zpLogin", dlg).disabled = false; return; }
        pollTimer = setTimeout(function () { pollLogin(loginId); }, 1500);
      }).catch(function (e) { stopPoll(); $("#zpState", dlg).innerHTML = '<span class="err">' + esc(e.message) + '</span>'; $("#zpLogin", dlg).disabled = false; });
    }
    $("#zpLogin", dlg).onclick = function () {
      $("#zpLogin", dlg).disabled = true;
      $("#zpState", dlg).textContent = "Đang tạo QR...";
      api("/v1/channels/" + ch.id + "/personal/login", { method: "POST" }).then(function (j) {
        pollLogin(j.loginId);
      }).catch(function (e) { $("#zpLogin", dlg).disabled = false; $("#zpState", dlg).innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    };
    $("#zpLogout", dlg).onclick = function () {
      if (!confirm("Ngắt kết nối " + P + " cá nhân? Lần sau phải quét QR lại.")) return;
      api("/v1/channels/" + ch.id + "/personal/logout", { method: "POST" }).then(function () { toast("Đã ngắt " + P); showStatus(); }).catch(function (e) { toast(e.message, 1); });
    };
    showStatus();
    loadObserved();
  }

  PAGES.channels = function () {
    var m = page("Channels", "Kênh nhắn tin (Telegram, Discord...) — mỗi kênh gắn 1 agent trả lời");
    var top = card(m);
    top.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center"><span class="muted">Thêm/sửa kênh áp dụng ngay, không cần restart server. Yêu cầu pairing mới xuất hiện trong mục chờ duyệt ngay bên dưới.</span><button id="chAdd">＋ Thêm kênh</button></div>';
    // Danh sách kênh đứng đầu (hay dùng nhất), rồi mới tới các mục chờ duyệt
    var listC = card(m, "Danh sách kênh");
    var pendingC = card(m, "Yêu cầu chờ duyệt");
    var zaloC = card(m, "Zalo — nhóm/thread chờ duyệt");
    var kinds = ["telegram", "discord", "slack", "whatsapp", "whatsapp_personal", "zalo", "zalo_personal", "feishu", "msteams"];
    function loadPending() {
      pendingC.innerHTML = '<h3>Yêu cầu chờ duyệt</h3><div class="muted">Đang tải...</div>';
      api("/v1/channel-pairings/pending").then(function (j) {
        pendingC.innerHTML = '<h3>Yêu cầu chờ duyệt <span class="pill" style="margin-left:6px">' + j.pending.length + '</span></h3>';
        if (!j.pending.length) {
          pendingC.innerHTML += '<div class="muted">Không có yêu cầu nào. Khi người mới nhắn cho bot, mã ghép nối sẽ tự xuất hiện tại đây.</div>';
          return;
        }
        pendingC.appendChild(table(["Kênh", "Mã ghép nối", "Người dùng", "Thời điểm", ""], j.pending, function (p) {
          var tr = el("tr");
          var created = p.createdAt ? new Date(p.createdAt).toLocaleString("vi-VN") : "";
          tr.innerHTML =
            "<td>" + esc(p.channelName) + " <code>" + esc(p.channelKind) + "</code></td>" +
            "<td><code>" + esc(p.code) + "</code></td>" +
            "<td>" + (p.displayName ? esc(p.displayName) + " " : "") + '<code style="font-size:.75rem">' + esc(p.externalUserId || "?") + "</code></td>" +
            '<td class="muted">' + esc(created) + "</td>";
          var td = el("td");
          var approve = el("button", { "class": "sm" }, "Duyệt");
          approve.onclick = function () {
            approve.disabled = true;
            approve.textContent = "Đang duyệt...";
            api("/v1/channels/" + p.channelId + "/pairings/" + p.code + "/approve", { method: "POST" })
              .then(function () { toast("Đã duyệt " + p.code); loadPending(); })
              .catch(function (e) { approve.disabled = false; approve.textContent = "Duyệt"; toast(e.message, 1); });
          };
          td.appendChild(approve); tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { pendingC.innerHTML = '<h3>Yêu cầu chờ duyệt</h3><span class="err">' + esc(e.message) + "</span>"; });
    }
    // Zalo Personal: thread (nhóm/cá nhân) đã nhắn tới nhưng CHƯA được duyệt
    // nhận/gửi — duyệt ở đây = thêm vào demo threads của kênh.
    function loadZaloPending() {
      zaloC.style.display = "none";
      api("/v1/channels").then(function (j) {
        var zaloChannels = (j.channels || []).filter(function (c) { return isPersonalKind(c.kind) && c.enabled; });
        if (!zaloChannels.length) return;
        Promise.all(zaloChannels.map(function (c) {
          return api("/v1/channels/" + c.id + "/personal/observed")
            .then(function (o) { return { ch: c, peers: o.peers || [], demoThreads: o.demoThreads || [] }; })
            .catch(function () { return null; }); // kênh chưa kết nối thì bỏ qua
        })).then(function (results) {
          var rows = [];
          results.forEach(function (r) {
            if (!r) return;
            r.peers.forEach(function (p) {
              if (!p.allowed) rows.push({ ch: r.ch, demoThreads: r.demoThreads, p: p });
            });
          });
          if (!rows.length) return;
          zaloC.style.display = "";
          zaloC.innerHTML = '<h3>Zalo — nhóm/thread chờ duyệt <span class="pill" style="margin-left:6px">' + rows.length + '</span></h3>' +
            '<div class="muted" style="font-size:.78rem;margin-bottom:6px">Ai/nhóm nhắn tới tài khoản Zalo / WhatsApp mà chưa được duyệt sẽ hiện ở đây. «Duyệt» = cho bot nhận/gửi trong thread đó (thêm vào demo threads). Nhóm được ghi rõ là nhóm.</div>';
          zaloC.appendChild(table(["Kênh", "Loại", "Tên", "Id", "Tin nhắn", "Lần cuối", ""], rows, function (r) {
            var p = r.p;
            var tr = el("tr");
            var when = p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString("vi-VN") : "";
            tr.innerHTML =
              "<td>" + esc(r.ch.name) + "</td>" +
              "<td>" + (p.type === "group" ? '<span class="pill">nhóm</span>' : '<span class="pill ok">cá nhân</span>') + "</td>" +
              "<td>" + esc(p.name) + (p.type === "group" ? ' <span class="muted" style="font-size:.75rem">· gửi bởi ' + esc(p.lastSenderName) + "</span>" : "") + "</td>" +
              '<td><code style="font-size:.75rem">' + esc(p.threadId) + "</code></td>" +
              "<td>" + p.messageCount + '</td><td class="muted">' + esc(when) + "</td>";
            var td = el("td");
            var ok = el("button", { "class": "sm" }, "Duyệt");
            ok.onclick = function () {
              if (!confirm('Cho bot nhận/gửi tin trong "' + p.name + '" (' + p.chatKey + ')?')) return;
              ok.disabled = true;
              ok.textContent = "Đang duyệt...";
              api("/v1/channels/" + r.ch.id + "/personal/demo-threads", { method: "PUT", body: { threads: r.demoThreads.concat([p.chatKey]) } })
                .then(function () { toast("Đã duyệt " + p.name); loadZaloPending(); })
                .catch(function (e) { ok.disabled = false; ok.textContent = "Duyệt"; toast(e.message, 1); });
            };
            td.appendChild(ok); tr.appendChild(td); return tr;
          }));
        });
      }).catch(function () {});
    }
    function load() {
      api("/v1/channels").then(function (j) {
        if (j.supportedKinds && j.supportedKinds.length) kinds = j.supportedKinds;
        listC.innerHTML = "<h3>Danh sách kênh</h3>";
        if (!j.channels.length) {
          listC.innerHTML += '<div class="muted">Chưa có kênh nào. Bấm "＋ Thêm kênh", chọn agent và dán bot token là xong.</div>';
          return;
        }
        listC.appendChild(table(["Kênh", "Tên", "Agent trả lời", "Pairing", "Trạng thái", ""], j.channels, function (r) {
          var tr = el("tr");
          tr.innerHTML =
            "<td><code>" + esc(channelKindLabel(r.kind)) + "</code></td><td>" + esc(r.name) + "</td>" +
            "<td>" + (r.agentName ? esc(r.agentName) + " <code>" + esc(r.agentKey) + "</code>" : "<span class='err'>chưa gắn</span>") + "</td>" +
            "<td>" + (r.requirePairing ? '<span class="pill">duyệt tay</span>' : '<span class="pill ok">mở</span>') + "</td>" +
            "<td>" + (r.enabled ? '<span class="pill ok">đang chạy</span>' : '<span class="pill">tạm dừng</span>') + "</td>";
          var td = el("td");
          var edit = el("button", { "class": "ghost sm" }, "Sửa");
          edit.onclick = function () { openChannelDialog(r, kinds, load); };
          var pair = el("button", { "class": "ghost sm" }, "Xem pairing");
          pair.onclick = function () { openPairings(r, loadPending); };
          var connect = null;
          if (isPersonalKind(r.kind)) {
            connect = el("button", { "class": "ghost sm" }, "Kết nối QR");
            connect.onclick = function () { openZaloPersonal(r, function () { load(); loadZaloPending(); }); };
          }
          var tog = el("button", { "class": "ghost sm" }, r.enabled ? "Tạm dừng" : "Bật");
          tog.onclick = function () {
            api("/v1/channels/" + r.id, { method: "PATCH", body: { enabled: !r.enabled } })
              .then(function (x) { toast(x.note || "Đã cập nhật"); load(); })
              .catch(function (e) { toast(e.message, 1); });
          };
          var del = el("button", { "class": "ghost sm" }, "Xóa");
          del.onclick = function () { if (confirm('Xóa kênh "' + r.name + '"?')) api("/v1/channels/" + r.id, { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); }); };
          td.appendChild(edit); td.appendChild(document.createTextNode(" "));
          td.appendChild(pair); td.appendChild(document.createTextNode(" "));
          if (connect) { td.appendChild(connect); td.appendChild(document.createTextNode(" ")); }
          td.appendChild(tog); td.appendChild(document.createTextNode(" "));
          td.appendChild(del);
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    $("#chAdd").onclick = function () { openChannelDialog(null, kinds, load); };
    loadPending();
    loadZaloPending();
    load();
  };

  // ---- Cron: lịch chạy agent — quản trị viên tạo ở đây, hoặc agent tự tạo khi chat (tool cron_*) ----
  PAGES.cron = function () {
    var m = page("Cron & lịch hẹn", "Agent chạy theo lịch: báo cáo định kỳ, nhắc việc. Người dùng cũng có thể nhờ agent đặt lịch ngay trong lúc chat.");
    var info = card(m);
    info.innerHTML =
      '<div style="font-size:.86rem;line-height:1.55">💡 <b>Agent tự đặt lịch khi chat</b>: người dùng nhắn kiểu <i>"nhắc tôi 8h sáng mai gọi anh Nam"</i>, <i>"30 phút nữa báo tôi"</i>, <i>"sáng thứ Hai hằng tuần gửi tôi tóm tắt tin tức"</i> — agent tạo lịch bằng tool <code>cron_create</code>, tới giờ tự chạy và <b>gửi kết quả về đúng cuộc trò chuyện</b> đó (Telegram, Zalo… hoặc trang Chat). Lịch agent tạo hiện ở bảng dưới với cột "Tạo bởi" / "Gửi về". ' +
      'Giới hạn: lịch lặp tối thiểu 5 phút một lần, mỗi người tối đa 20 lịch đang bật. Tắt tính năng cho một agent: Agents → Sửa → bỏ tick <code>cron_create</code>.</div>';
    var c = card(m, "Tạo lịch (quản trị viên)");
    c.innerHTML += '<div class="row"><input id="jName" placeholder="Tên lịch, vd Báo cáo sáng" style="flex:1"><select id="jAgent" style="flex:1"></select><input id="jSched" placeholder="0 8 * * 1-5" style="flex:1"></div>' +
      '<div class="muted" id="jHint" style="font-size:.78rem;margin-top:4px">Lịch: <code>in 30m</code> (sau 30 phút) · <code>at 2026-10-01 08:00</code> (một lần) · <code>every 2h</code> (mỗi 2 giờ) · cron <code>0 8 * * *</code> (8:00 hằng ngày), <code>30 17 * * 1-5</code> (17:30 thứ Hai–thứ Sáu).</div>' +
      '<label>Việc agent làm mỗi lần chạy (kết quả xem ở nút "Lịch sử")</label><textarea id="jPrompt" rows="2" style="width:100%"></textarea>' +
      '<div class="row" style="margin-top:8px"><button id="jCreate">Tạo</button><span id="jMsg" class="muted"></span></div>';
    fillAgentSelect(c, "#jAgent", null);
    var listC = card(m, "Danh sách");

    function openRuns(r) {
      api("/v1/cron/" + r.id + "/runs").then(function (j) {
        var d = el("dialog", { style: "width:760px;max-width:95vw;padding:18px" });
        d.innerHTML = "<h3 style='margin:0 0 4px'>Lịch sử chạy: " + esc(r.name) + "</h3><div class='muted' style='font-size:.8rem;margin-bottom:8px'>20 lần gần nhất</div><div id='rList' style='max-height:60vh;overflow:auto'></div><div class='row' style='margin-top:10px'><button class='ghost' id='rClose'>Đóng</button></div>";
        document.body.appendChild(d); d.showModal();
        $("#rClose", d).onclick = function () { d.close(); d.remove(); };
        var box = $("#rList", d);
        if (!j.runs.length) { box.innerHTML = '<span class="muted">Chưa chạy lần nào.</span>'; return; }
        j.runs.forEach(function (run) {
          var item = el("div", { style: "border-bottom:1px solid var(--border);padding:6px 0" });
          item.innerHTML = (run.status === "ok" ? '<span class="pill ok">ok</span>' : '<span class="pill" style="color:#dc2626">lỗi</span>') +
            ' <span class="muted">' + esc(new Date(run.runAt).toLocaleString("vi-VN")) + "</span>";
          var pre = el("div", { style: "white-space:pre-wrap;font-size:.82rem;margin-top:4px" });
          pre.textContent = run.output || "";
          item.appendChild(pre); box.appendChild(item);
        });
      }).catch(function (e) { toast(e.message, 1); });
    }

    function load() {
      api("/v1/cron").then(function (j) {
        $("#jHint").innerHTML = $("#jHint").innerHTML.replace(/ \\(múi giờ[^)]*\\)$/, "") + " (múi giờ " + esc(j.timezone || "") + ")";
        listC.innerHTML = "<h3>Danh sách</h3>";
        listC.appendChild(table(["Tên", "Agent", "Lịch", "Lần chạy kế tiếp", "Tạo bởi", "Gửi về", "Trạng thái", ""], j.jobs, function (r) {
          var tr = el("tr");
          var once = /^at\\s/i.test(r.schedule);
          var state = r.enabled ? '<span class="pill ok">đang bật</span>' : (once && r.lastRun ? '<span class="pill">đã chạy xong</span>' : '<span class="pill">tạm dừng</span>');
          tr.innerHTML =
            "<td>" + esc(r.name) + "</td>" +
            "<td><code>" + esc(r.agentKey || "") + "</code></td>" +
            "<td>" + esc(r.scheduleText || r.schedule) + '<div class="muted" style="font-size:.72rem"><code>' + esc(r.schedule) + "</code>" + (r.timezone ? " · " + esc(r.timezone) : " · giờ máy chủ") + "</div></td>" +
            "<td class='muted'>" + (r.enabled ? esc(r.nextRunText || "") : (r.lastRunText ? "lần cuối " + esc(r.lastRunText) : "")) + "</td>" +
            "<td>" + (r.createdVia === "agent" ? "🤖 " + esc(r.creatorText || "agent") : '<span class="muted">quản trị viên</span>') + "</td>" +
            "<td>" + (r.deliverText ? esc(r.deliverText) : '<span class="muted">—</span>') + "</td>" +
            "<td>" + state + "</td>";
          var td = el("td");
          var runs = el("button", { "class": "ghost sm" }, "Lịch sử");
          runs.onclick = function () { openRuns(r); };
          td.appendChild(runs);
          if (isAdmin()) {
            var tog = el("button", { "class": "ghost sm" }, r.enabled ? "Tạm dừng" : "Bật");
            tog.onclick = function () {
              api("/v1/cron/" + r.id, { method: "PATCH", body: { enabled: !r.enabled } })
                .then(function () { toast(r.enabled ? "Đã tạm dừng" : "Đã bật lại"); load(); })
                .catch(function (e) { toast(e.message, 1); });
            };
            var del = el("button", { "class": "ghost sm" }, "Xóa");
            del.onclick = function () {
              if (confirm('Xóa lịch "' + r.name + '"?')) api("/v1/cron/" + r.id, { method: "DELETE" }).then(load).catch(function (e) { toast(e.message, 1); });
            };
            td.appendChild(document.createTextNode(" ")); td.appendChild(tog);
            td.appendChild(document.createTextNode(" ")); td.appendChild(del);
          }
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }

    $("#jCreate").onclick = function () {
      var name = $("#jName").value.trim(), sched = $("#jSched").value.trim(), prompt = $("#jPrompt").value.trim();
      if (!name || !sched || !prompt) { $("#jMsg").innerHTML = '<span class="err">Nhập đủ tên, lịch và việc cần làm</span>'; return; }
      api("/v1/cron", { method: "POST", body: { agentKey: $("#jAgent").value, name: name, schedule: sched, prompt: prompt } })
        .then(function () { $("#jMsg").innerHTML = ""; $("#jName").value = ""; $("#jSched").value = ""; $("#jPrompt").value = ""; toast("Đã tạo lịch"); load(); })
        .catch(function (e) { $("#jMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
    load();
  };

  // ---- Dialog phụ trợ cho trang Skills ----
  function skillDlg(html) {
    var d = el("dialog", { style: "width:720px;padding:18px" });
    d.innerHTML = html;
    document.body.appendChild(d); d.showModal();
    return d;
  }
  function b64ToText(b64) { return decodeURIComponent(escape(atob(b64))); }

  // File kèm skill: xem/sửa file văn bản, xóa, thêm mới (nhị phân thì qua ZIP)
  function openSkillFiles(r, reload) {
    api("/v1/skills/" + r.id + "/files").then(function (j) {
      var d = skillDlg(
        "<h3 style='margin:0 0 8px'>File của " + esc(r.slug) + "</h3><div id='fList'></div>" +
        "<h4 style='margin:12px 0 4px'>Thêm / sửa file văn bản</h4>" +
        '<input id="fPath" placeholder="scripts/tao_bao_cao.py" style="width:100%">' +
        '<textarea id="fContent" rows="8" style="width:100%;font-family:ui-monospace,monospace;font-size:.8rem"></textarea>' +
        '<div class="row" style="margin-top:8px"><button id="fSave">Lưu file</button><button class="ghost" id="fClose">Đóng</button><span id="fMsg" class="muted"></span></div>' +
        '<div class="muted" style="margin-top:6px;font-size:.8rem">File nhị phân (ảnh, template office) nạp qua ZIP. Agent thấy file tại <code>shared/skills/' + esc(r.slug) + '/...</code></div>');
      function renderList(files) {
        var box = $("#fList", d);
        box.innerHTML = files.length ? "" : '<span class="muted">chưa có file kèm theo</span>';
        files.forEach(function (f) {
          var row = el("div", { "class": "row", style: "justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0" });
          row.innerHTML = "<code>" + esc(f.path) + '</code><span class="muted">' + Math.max(1, Math.round(f.sizeBytes / 1024)) + " KB</span>";
          var btns = el("span");
          var edit2 = el("button", { "class": "ghost sm" }, "Sửa");
          edit2.onclick = function () {
            api("/v1/skills/" + r.id + "/files/content?path=" + encodeURIComponent(f.path)).then(function (fc) {
              $("#fPath", d).value = f.path;
              try { $("#fContent", d).value = b64ToText(fc.contentB64); $("#fMsg", d).textContent = ""; }
              catch (e) { $("#fContent", d).value = ""; $("#fMsg", d).innerHTML = '<span class="err">file nhị phân — không sửa dạng text được</span>'; }
            }).catch(function (e) { toast(e.message, 1); });
          };
          var del = el("button", { "class": "ghost sm" }, "Xóa");
          del.onclick = function () {
            if (!confirm("Xóa " + f.path + "?")) return;
            api("/v1/skills/" + r.id + "/files?path=" + encodeURIComponent(f.path), { method: "DELETE" })
              .then(function () { refresh(); reload(); }).catch(function (e) { toast(e.message, 1); });
          };
          btns.appendChild(edit2); btns.appendChild(document.createTextNode(" ")); btns.appendChild(del);
          row.appendChild(btns); box.appendChild(row);
        });
      }
      function refresh() { api("/v1/skills/" + r.id + "/files").then(function (jj) { renderList(jj.files); }); }
      renderList(j.files);
      $("#fClose", d).onclick = function () { d.close(); d.remove(); };
      $("#fSave", d).onclick = function () {
        var p = $("#fPath", d).value.trim();
        if (!p) { $("#fMsg", d).innerHTML = '<span class="err">thiếu path</span>'; return; }
        api("/v1/skills/" + r.id + "/files", { method: "PUT", body: { path: p, content: $("#fContent", d).value } })
          .then(function () { toast("Đã lưu file"); refresh(); reload(); })
          .catch(function (e) { $("#fMsg", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }).catch(function (e) { toast(e.message, 1); });
  }

  // Lịch sử phiên bản + khôi phục
  function openSkillVersions(r, reload) {
    api("/v1/skills/" + r.id + "/versions").then(function (j) {
      var d = skillDlg("<h3 style='margin:0 0 8px'>Phiên bản: " + esc(r.slug) + " (hiện tại v" + (r.version || 1) + ")</h3><div id='vList'></div>" +
        '<div class="row" style="margin-top:10px"><button class="ghost" id="vClose">Đóng</button></div>');
      var box = $("#vList", d);
      if (!j.versions.length) box.innerHTML = '<span class="muted">chưa có snapshot — tự tạo mỗi lần sửa / nạp ZIP đè</span>';
      j.versions.forEach(function (v) {
        var row = el("div", { "class": "row", style: "justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0" });
        row.innerHTML = "<span><b>v" + v.version + '</b> <span class="muted">' + esc(v.note || "") + " · " + v.fileCount + " file · " + esc((v.createdAt || "").slice(0, 16)) + "</span></span>";
        var rs = el("button", { "class": "ghost sm" }, "Khôi phục");
        rs.onclick = function () {
          if (!confirm("Khôi phục về v" + v.version + "? (bản hiện tại sẽ được snapshot trước)")) return;
          api("/v1/skills/versions/" + v.id + "/restore", { method: "POST" })
            .then(function (res) { toast("Đã khôi phục v" + v.version + " → v" + res.newVersion); d.close(); d.remove(); reload(); })
            .catch(function (e) { toast(e.message, 1); });
        };
        row.appendChild(rs); box.appendChild(row);
      });
      $("#vClose", d).onclick = function () { d.close(); d.remove(); };
    }).catch(function (e) { toast(e.message, 1); });
  }

  // Phân quyền theo chiều skill: phạm vi + tick agent + quyền quản lý (publish đè)
  function openSkillGrants(r, reload) {
    api("/v1/skills/" + r.id + "/agents").then(function (j) {
      var d = skillDlg("<h3 style='margin:0 0 8px'>Phân quyền: " + esc(r.slug) + "</h3>" +
        '<div class="row"><span class="muted">Phạm vi:</span><select id="gVis"><option value="workspace"' + (r.visibility === "workspace" ? " selected" : "") + '>workspace — mọi agent dùng được</option><option value="granted"' + (r.visibility === "granted" ? " selected" : "") + '>granted — chỉ agent được cấp</option></select></div>' +
        '<div id="gList" style="margin-top:8px;max-height:280px;overflow:auto"></div>' +
        '<div class="muted" style="font-size:.8rem;margin-top:6px">"Quản lý" = agent được ghi đè skill này bằng publish_skill. Tick agent chỉ có tác dụng khi phạm vi là granted.</div>' +
        '<div class="row" style="margin-top:10px"><button id="gSave">Lưu</button><button class="ghost" id="gClose">Đóng</button><span id="gMsg" class="muted"></span></div>');
      var init = {};
      $("#gList", d).innerHTML = j.agents.length ? j.agents.map(function (a) {
        init[a.agentId] = { granted: a.granted, canManage: a.canManage };
        return '<div class="row" style="gap:10px;margin:3px 0"><label style="display:flex;align-items:center;gap:6px;flex:1"><input type="checkbox" class="ga" value="' + esc(a.agentId) + '"' + (a.granted ? " checked" : "") + '> <code>' + esc(a.key) + '</code> <span class="muted">' + esc(a.name) + '</span></label><label style="display:flex;align-items:center;gap:4px"><input type="checkbox" class="gm" data-id="' + esc(a.agentId) + '"' + (a.canManage ? " checked" : "") + '> <span class="muted">quản lý</span></label></div>';
      }).join("") : '<span class="muted">chưa có agent nào trong workspace</span>';
      $("#gClose", d).onclick = function () { d.close(); d.remove(); };
      $("#gSave", d).onclick = function () {
        var ops = [];
        if ($("#gVis", d).value !== r.visibility) {
          ops.push(api("/v1/skills/" + r.id + "/visibility", { method: "POST", body: { visibility: $("#gVis", d).value } }));
        }
        d.querySelectorAll(".ga").forEach(function (cb) {
          var id = cb.value;
          var mg = d.querySelector('.gm[data-id="' + id + '"]');
          var can = !!(mg && mg.checked);
          var was = init[id] || { granted: false, canManage: false };
          if (cb.checked && (!was.granted || was.canManage !== can)) {
            ops.push(api("/v1/skills/" + r.id + "/grants/agent", { method: "POST", body: { agentId: id, canManage: can } }));
          }
          if (!cb.checked && was.granted) {
            ops.push(api("/v1/skills/" + r.id + "/grants/agent/" + id, { method: "DELETE" }));
          }
        });
        Promise.all(ops)
          .then(function () { toast("Đã lưu phân quyền"); d.close(); d.remove(); reload(); })
          .catch(function (e) { $("#gMsg", d).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }).catch(function (e) { toast(e.message, 1); });
  }

  PAGES.skills = crudPage({
    title: "Skills", sub: "Kỹ năng (SKILL.md + scripts/ + references/) — dán nội dung hoặc nạp ZIP; phạm vi workspace (mọi agent) hoặc granted (cấp từng agent qua nút Phân quyền)",
    list: "/v1/skills", key: "skills", cols: ["Slug", "Tên", "Mô tả", "Phiên bản", "Trạng thái", "Phạm vi", ""],
    formHtml: '<div class="row"><input id="sSlug" placeholder="slug (bỏ trống nếu có frontmatter)"><input id="sName" placeholder="Tên"></div><input id="sDesc" placeholder="Mô tả ngắn" style="width:100%;margin-top:6px"><label>Nội dung SKILL.md (dán cả frontmatter <code>--- name: ... ---</code> thì tự điền các ô trên)</label><textarea id="sContent" rows="5" style="width:100%"></textarea>' +
      '<div class="row" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px"><input type="file" id="sZip" accept=".zip" style="flex:1"><button id="sZipBtn" class="ghost">Nạp từ ZIP</button><span id="sZipMsg" class="muted"></span></div>' +
      '<div class="muted" style="font-size:.8rem">ZIP chứa SKILL.md (có frontmatter) + scripts/ + references/. Trùng slug sẽ ghi đè (bản cũ được snapshot).</div>',
    collect: function () { var c = $("#sContent").value.trim(); if (!c) return null; return { slug: $("#sSlug").value.trim(), name: $("#sName").value.trim(), description: $("#sDesc").value.trim(), content: c }; },
    rowHtml: function (r) {
      return "<td><code>" + esc(r.slug) + "</code></td><td>" + esc(r.name) + "</td><td class='muted'>" + esc(r.description) + "</td><td>v" + (r.version || 1) + (r.fileCount ? " · " + r.fileCount + " file" : "") + "</td>";
    },
    extraCell: function (tr, r, reload) {
      var tdLast = tr.lastElementChild;
      function addBtn(label, fn) {
        var b = el("button", { "class": "ghost sm" }, label);
        b.onclick = fn;
        tdLast.insertBefore(b, tdLast.firstChild ? tdLast.firstChild : null);
        tdLast.insertBefore(document.createTextNode(" "), b.nextSibling);
      }
      // thứ tự chèn ngược để hiện: Sửa · Files · Phiên bản · Phân quyền · ZIP · Xóa
      addBtn("ZIP", function () {
        fetch("/v1/skills/" + r.id + "/export")
          .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.blob(); })
          .then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = r.slug + ".zip"; a.click(); URL.revokeObjectURL(a.href); })
          .catch(function (e) { toast(e.message, 1); });
      });
      addBtn("Phân quyền", function () { openSkillGrants(r, reload); });
      addBtn("Phiên bản", function () { openSkillVersions(r, reload); });
      addBtn("Files", function () { openSkillFiles(r, reload); });
      addBtn("Sửa", function () {
        api("/v1/skills/" + r.id).then(function (j) {
          var dlg = skillDlg(
            "<h3 style='margin:0 0 8px'>" + esc(j.skill.slug) + " <span class='muted'>v" + (j.skill.version || 1) + "</span></h3>" +
            '<div class="row"><input id="edName" style="flex:1"><input id="edDesc" style="flex:2"></div>' +
            '<label>Nội dung</label><textarea id="edContent" rows="16" style="width:100%;font-family:ui-monospace,monospace;font-size:.82rem"></textarea>' +
            '<div class="row" style="margin-top:10px"><button id="edSave">Lưu</button><button class="ghost" id="edClose">Đóng</button><span id="edMsg" class="muted"></span></div>');
          $("#edName", dlg).value = j.skill.name;
          $("#edDesc", dlg).value = j.skill.description;
          $("#edContent", dlg).value = j.skill.content;
          $("#edClose", dlg).onclick = function () { dlg.close(); dlg.remove(); };
          $("#edSave", dlg).onclick = function () {
            api("/v1/skills/" + r.id, { method: "PATCH", body: { name: $("#edName", dlg).value, description: $("#edDesc", dlg).value, content: $("#edContent", dlg).value } })
              .then(function () { toast("Đã lưu skill"); dlg.close(); dlg.remove(); reload(); })
              .catch(function (e) { $("#edMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
          };
        }).catch(function (e) { toast(e.message, 1); });
      });

      var tdSt = el("td");
      var tg = el("button", { "class": "ghost sm" }, r.enabled ? "Đang bật" : "Đã tắt");
      if (!r.enabled) tg.style.opacity = ".5";
      tg.onclick = function () {
        api("/v1/skills/" + r.id + "/toggle", { method: "POST", body: { enabled: !r.enabled } })
          .then(reload).catch(function (e) { toast(e.message, 1); });
      };
      tdSt.appendChild(tg);
      var tdVis = el("td");
      tdVis.innerHTML = '<span class="pill">' + esc(r.visibility) + "</span>";
      var last = tr.lastElementChild;
      tr.insertBefore(tdSt, last); tr.insertBefore(tdVis, last);
    },
    del: function (r) { return "/v1/skills/" + r.id; },
    onReady: function (reloadList) {
      $("#sZipBtn").onclick = function () {
        var f = $("#sZip").files[0];
        if (!f) { $("#sZipMsg").innerHTML = '<span class="err">chọn file .zip trước</span>'; return; }
        var rd = new FileReader();
        rd.onload = function () {
          var b64 = String(rd.result).split(",")[1] || "";
          $("#sZipMsg").textContent = "đang nạp...";
          api("/v1/skills/import", { method: "POST", body: { zipBase64: b64 } }).then(function (j) {
            $("#sZipMsg").innerHTML = '<span class="ok">' + (j.overwritten ? "đã ghi đè " : "đã tạo ") + esc(j.skill.slug) + " (v" + j.skill.version + ", " + j.fileCount + " file)</span>";
            toast("Đã nạp skill từ ZIP");
            if (reloadList) reloadList();
          }).catch(function (e) { $("#sZipMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
        };
        rd.readAsDataURL(f);
      };
    }
  });

  PAGES.tools = crudPage({
    title: "Custom Tools", sub: "Tool shell động — {{param}} thay bằng tham số (escape an toàn)",
    list: "/v1/custom-tools", key: "tools", cols: ["Tên", "Mô tả", "Lệnh", ""],
    formHtml: '<div class="row"><input id="tName" placeholder="ten_tool (a-z0-9_)"><input id="tDesc" placeholder="Mô tả"></div><label>Command template</label><input id="tCmd" placeholder="curl -s {{url}}" style="width:100%">',
    collect: function () { var n = $("#tName").value.trim(), cmd = $("#tCmd").value.trim(); if (!n || !cmd) return null; return { name: n, description: $("#tDesc").value.trim(), commandTemplate: cmd }; },
    rowHtml: function (r) { return "<td><code>" + esc(r.name) + "</code></td><td class='muted'>" + esc(r.description) + "</td><td><code>" + esc(r.commandTemplate) + "</code></td>"; },
    del: function (r) { return "/v1/custom-tools/" + r.id; }
  });

  // Dialog cấp quyền MCP theo NGƯỜI DÙNG CUỐI (contact kênh chat).
  // userKey = "<kind>-<externalId>". Allow trống = mọi tool; Deny luôn thắng.
  function openMcpUserGrants(r) {
    var dlg = el("dialog", { style: "width:760px;max-width:95vw;padding:18px" });
    dlg.innerHTML =
      '<h3 style="margin:0 0 6px">Người dùng được cấp: ' + esc(r.name) + "</h3>" +
      '<div class="muted" style="margin-bottom:10px;font-size:.82rem">Chính sách <b>granted</b>: chỉ người được tick mới dùng được tool của server này. Chính sách <b>all</b>: mọi người đã pair đều dùng được — tick một người chỉ để thu hẹp (Allow) hoặc chặn tool (Deny) riêng cho họ. Allow/Deny nhập tên tool cách nhau dấu phẩy; Allow trống = mọi tool; Deny luôn thắng.' +
      (r.tools && r.tools.length ? "<br>Tool của server: <code style='font-size:.72rem'>" + esc(r.tools.join(", ")) + "</code>" : "") + "</div>" +
      '<div id="ugList" style="max-height:340px;overflow:auto"><span class="muted">đang tải...</span></div>' +
      '<div class="row" style="margin-top:12px"><button id="ugSave">Lưu</button><button class="ghost" id="ugClose">Đóng</button><span id="ugMsg" class="muted"></span></div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    $("#ugClose", dlg).onclick = function () { dlg.close(); dlg.remove(); };
    var init = {};
    Promise.all([api("/v1/contacts"), api("/v1/mcp/" + r.id + "/grants/users")]).then(function (res) {
      var contacts = res[0].contacts || [], grants = res[1].grants || [];
      var byKey = {};
      grants.forEach(function (g) { byKey[g.userKey] = g; });
      var rows = contacts.map(function (c) {
        return { userKey: c.channelKind + "-" + c.externalId, name: c.displayName || c.externalId };
      });
      // Grant của contact đã bị xóa vẫn hiện để thu hồi được
      grants.forEach(function (g) {
        var dup = rows.some(function (x) { return x.userKey === g.userKey; });
        if (!dup) rows.push({ userKey: g.userKey, name: g.displayName || g.userKey });
      });
      if (!rows.length) {
        $("#ugList", dlg).innerHTML = '<span class="muted">Chưa có contact nào — người dùng nhắn vào kênh chat sẽ xuất hiện ở đây.</span>';
        return;
      }
      $("#ugList", dlg).innerHTML = rows.map(function (x) {
        var g = byKey[x.userKey];
        init[x.userKey] = !!g;
        return '<div class="row" style="align-items:center;gap:6px;margin:4px 0">' +
          '<label style="display:flex;align-items:center;gap:6px;flex:1.2;min-width:0"><input type="checkbox" class="ug" data-k="' + esc(x.userKey) + '"' + (g ? " checked" : "") + '> <b>' + esc(x.name) + '</b> <code style="font-size:.7rem">' + esc(x.userKey) + "</code></label>" +
          '<input class="uga" data-k="' + esc(x.userKey) + '" placeholder="allow (trống = mọi tool)" style="flex:1" value="' + esc(g ? (g.toolAllow || []).join(",") : "") + '">' +
          '<input class="ugd" data-k="' + esc(x.userKey) + '" placeholder="deny" style="flex:1" value="' + esc(g ? (g.toolDeny || []).join(",") : "") + '">' +
          "</div>";
      }).join("");
    }).catch(function (e) { $("#ugList", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    $("#ugSave", dlg).onclick = function () {
      var allowMap = {}, denyMap = {};
      dlg.querySelectorAll(".uga").forEach(function (inp) { allowMap[inp.getAttribute("data-k")] = inp.value; });
      dlg.querySelectorAll(".ugd").forEach(function (inp) { denyMap[inp.getAttribute("data-k")] = inp.value; });
      function parseList(s) { return (s || "").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return !!x; }); }
      var ops = [];
      dlg.querySelectorAll(".ug").forEach(function (cb) {
        var k = cb.getAttribute("data-k");
        if (cb.checked) {
          ops.push(api("/v1/mcp/" + r.id + "/grants/user", { method: "POST", body: { userKey: k, toolAllow: parseList(allowMap[k]), toolDeny: parseList(denyMap[k]) } }));
        } else if (init[k]) {
          ops.push(api("/v1/mcp/" + r.id + "/grants/user?userKey=" + encodeURIComponent(k), { method: "DELETE" }));
        }
      });
      $("#ugMsg", dlg).textContent = "Đang lưu...";
      Promise.all(ops).then(function () { toast("Đã lưu quyền người dùng"); dlg.close(); dlg.remove(); })
        .catch(function (e) { $("#ugMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
  }

  PAGES.mcp = crudPage({
    title: "MCP Servers", sub: "Kết nối MCP server (stdio / sse / http) — kết nối ngay, tự kết nối lại khi rớt (ping 30s), hỗ trợ OAuth cho server http/sse. Phạm vi granted = cấp cho từng agent trong trang Agents. Người dùng granted = chỉ người dùng kênh chat được cấp (nút Người dùng) mới dùng được tool.",
    list: "/v1/mcp", key: "servers", cols: ["Tên", "Transport", "Nguồn", "Trạng thái", "Phạm vi", "Người dùng", ""],
    formHtml:
      '<div class="row"><input id="mName" placeholder="Tên"><select id="mTr"><option value="stdio">stdio (chạy lệnh)</option><option value="http">http (streamable)</option><option value="sse">sse</option></select></div>' +
      '<label id="mCmdLbl">Command + args (cách nhau dấu cách)</label><input id="mCmd" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp" style="width:100%">' +
      '<label id="mUrlLbl" style="display:none">URL server</label><input id="mUrl" placeholder="https://..." style="width:100%;display:none">' +
      '<label id="mEnvLbl">Biến môi trường (mỗi dòng KEY=value; với http/sse dùng làm HTTP header)</label><textarea id="mEnv" rows="2" style="width:100%" placeholder="API_KEY=xxx"></textarea>' +
      '<div class="row" style="margin-top:6px"><button id="mTest" class="ghost">Kiểm tra kết nối</button><span id="mTestMsg" class="muted"></span></div>',
    collect: function () {
      var tr = $("#mTr").value;
      var body = { name: $("#mName").value.trim(), transport: tr };
      if ($("#mEnv").value.trim()) body.env = $("#mEnv").value.trim();
      if (tr === "stdio") {
        var parts = $("#mCmd").value.trim().split(/\\s+/);
        if (!parts[0]) return null;
        body.command = parts[0]; body.args = parts.slice(1);
      } else {
        if (!$("#mUrl").value.trim()) return null;
        body.url = $("#mUrl").value.trim();
      }
      return body;
    },
    afterCreate: function (r) {
      if (r.status && r.status.connected) return '<span class="ok">đã kết nối, ' + r.status.toolCount + " tool</span>";
      if (r.status && r.status.error) return '<span class="err">lỗi: ' + esc(r.status.error) + "</span>";
      return "";
    },
    rowHtml: function (r) {
      var src = r.transport === "stdio" ? (r.command || "") + " " + ((r.args || []).join(" ")) : (r.url || "");
      var st;
      if (r.connected) st = '<span class="pill ok">đã kết nối · ' + r.toolCount + " tool</span>";
      else if (r.needsAuth) st = '<span class="pill" style="background:#7a5c00;color:#ffd97a">cần đăng nhập OAuth</span>';
      else st = '<span class="pill err">' + esc(r.error ? "lỗi" : "chưa kết nối") + "</span>";
      return "<td>" + esc(r.name) + "</td><td><code>" + esc(r.transport) + "</code></td><td><code>" + esc(src.trim()) + "</code></td><td>" + st + "</td>";
    },
    extraCell: function (tr, r, reload) {
      var td = tr.lastElementChild; // gắn thêm nút cạnh nút Xóa
      // Phạm vi: workspace (mọi agent) | granted (cấp trong trang Agents)
      var tdVis = el("td");
      var sel = el("select", { "class": "sm", style: "padding:4px" });
      sel.innerHTML = '<option value="workspace"' + (r.visibility === "workspace" ? " selected" : "") + '>workspace</option><option value="granted"' + (r.visibility === "granted" ? " selected" : "") + '>granted</option>';
      sel.onchange = function () {
        api("/v1/mcp/" + r.id + "/visibility", { method: "POST", body: { visibility: sel.value } })
          .then(function () { toast("Đã đổi phạm vi"); reload(); }).catch(function (e) { toast(e.message, 1); reload(); });
      };
      tdVis.appendChild(sel);
      tr.insertBefore(tdVis, td);

      // Chính sách người dùng: all (mọi user đã pair) | granted (cấp từng người)
      var tdUser = el("td");
      var selU = el("select", { "class": "sm", style: "padding:4px" });
      selU.innerHTML = '<option value="all"' + (r.userPolicy === "granted" ? "" : " selected") + '>all</option><option value="granted"' + (r.userPolicy === "granted" ? " selected" : "") + '>granted</option>';
      selU.onchange = function () {
        api("/v1/mcp/" + r.id + "/user-policy", { method: "POST", body: { userPolicy: selU.value } })
          .then(function () { toast("Đã đổi chính sách người dùng"); reload(); }).catch(function (e) { toast(e.message, 1); reload(); });
      };
      tdUser.appendChild(selU);
      tdUser.appendChild(document.createTextNode(" "));
      var ug = el("button", { "class": "ghost sm" }, "Người dùng");
      ug.onclick = function () { openMcpUserGrants(r); };
      tdUser.appendChild(ug);
      tr.insertBefore(tdUser, td);

      var rc = el("button", { "class": "ghost sm" }, "Kết nối lại");
      rc.onclick = function () {
        rc.disabled = true; rc.textContent = "Đang nối...";
        api("/v1/mcp/" + r.id + "/reconnect", { method: "POST" })
          .then(function (j) { toast(j.status.connected ? "OK, " + j.status.toolCount + " tool" : "Lỗi: " + (j.status.error || "?"), j.status.connected ? 0 : 1); reload(); })
          .catch(function (e) { toast(e.message, 1); rc.disabled = false; rc.textContent = "Kết nối lại"; });
      };
      td.insertBefore(rc, td.firstChild);
      td.insertBefore(document.createTextNode(" "), rc.nextSibling);
      // Server yêu cầu OAuth: mở trang đồng ý, callback quay về server → poll trạng thái
      if (r.needsAuth && r.authUrl) {
        var lg = el("button", { "class": "sm" }, "Đăng nhập");
        lg.onclick = function () {
          window.open(r.authUrl, "_blank");
          lg.textContent = "Hoàn tất ở tab mới...";
          var n = 0, poll = setInterval(function () {
            n++; if (n > 60) { clearInterval(poll); return; }
            api("/v1/mcp").then(function (jj) {
              var sv = (jj.servers || []).find(function (x) { return x.id === r.id; });
              if (sv && sv.connected) { clearInterval(poll); toast("Đã đăng nhập MCP OK"); reload(); }
            });
          }, 2500);
        };
        td.insertBefore(lg, td.firstChild);
        td.insertBefore(document.createTextNode(" "), lg.nextSibling);
      }
      if (r.tools && r.tools.length) {
        var info = el("button", { "class": "ghost sm" }, "Tool");
        info.onclick = function () { alert("Tool của " + r.name + ":\\n\\n" + r.tools.join("\\n")); };
        td.insertBefore(info, td.firstChild);
        td.insertBefore(document.createTextNode(" "), info.nextSibling);
      }
      if (r.error && !r.needsAuth) {
        var errRow = el("tr");
        errRow.innerHTML = '<td colspan="7" class="err" style="font-size:.82rem">⚠ ' + esc(r.error) + "</td>";
        setTimeout(function () { if (tr.parentNode) tr.parentNode.insertBefore(errRow, tr.nextSibling); }, 0);
      }
    },
    del: function (r) { return "/v1/mcp/" + r.id; },
    onReady: function () {
      function syncFields() {
        var stdio = $("#mTr").value === "stdio";
        $("#mCmd").style.display = stdio ? "" : "none";
        $("#mCmdLbl").style.display = stdio ? "" : "none";
        $("#mUrl").style.display = stdio ? "none" : "";
        $("#mUrlLbl").style.display = stdio ? "none" : "";
      }
      $("#mTr").onchange = syncFields; syncFields();
      $("#mTest").onclick = function () {
        var tr = $("#mTr").value;
        var body = { name: $("#mName").value.trim() || "test", transport: tr };
        if ($("#mEnv").value.trim()) body.env = $("#mEnv").value.trim();
        if (tr === "stdio") { var p = $("#mCmd").value.trim().split(/\\s+/); body.command = p[0]; body.args = p.slice(1); }
        else body.url = $("#mUrl").value.trim();
        $("#mTestMsg").textContent = "đang thử...";
        api("/v1/mcp/test", { method: "POST", body: body }).then(function (j) {
          $("#mTestMsg").innerHTML = j.ok
            ? '<span class="ok">OK — ' + j.tools.length + " tool: " + esc(j.tools.slice(0, 6).join(", ")) + "</span>"
            : '<span class="err">' + esc(j.error) + "</span>";
        }).catch(function (e) { $("#mTestMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }
  });

  PAGES.hooks = crudPage({
    title: "Hooks", sub: "Gọi HTTP khi có sự kiện lifecycle (SSRF-guarded)",
    list: "/v1/hooks", key: "hooks", cols: ["Event", "Matcher", "URL", ""],
    formHtml: '<div class="row"><select id="hEv"><option>pre_tool_use</option><option>post_tool_use</option><option>stop</option><option>session_start</option></select><input id="hMatch" placeholder="matcher regex" value=".*"></div><input id="hUrl" placeholder="https://..." style="width:100%;margin-top:6px">',
    collect: function () { var u = $("#hUrl").value.trim(); if (!u) return null; return { event: $("#hEv").value, matcher: $("#hMatch").value.trim() || ".*", url: u }; },
    rowHtml: function (r) { return "<td><code>" + esc(r.event) + "</code></td><td><code>" + esc(r.matcher) + "</code></td><td class='muted'>" + esc(r.url) + "</td>"; },
    del: function (r) { return "/v1/hooks/" + r.id; }
  });

  PAGES.vault = function () {
    var m = page("Kho tri thức (Vault)", "Collection + phân quyền agent/người dùng + hybrid RAG (keyword và semantic)");
    var settingsC = card(m, "Cấu hình RAG chung");
    settingsC.innerHTML =
      '<div class="row"><div><label>Chunk (token ước tính)</label><input id="vrChunk" type="number" min="100" max="4000" style="width:120px"></div>' +
      '<div><label>Overlap</label><input id="vrOverlap" type="number" min="0" max="1000" style="width:110px"></div>' +
      '<div><label>Ngân sách context</label><input id="vrContext" type="number" min="500" max="64000" style="width:130px"></div>' +
      '<div><label>Full-doc (token/tài liệu)</label><input id="vrFull" type="number" min="500" max="64000" style="width:140px" title="Tài liệu ≤ ngưỡng này được nạp NGUYÊN VĂN khi tìm trúng"></div>' +
      '<div><label>Số kết quả</label><input id="vrLimit" type="number" min="1" max="30" style="width:100px"></div>' +
      '<label style="display:flex;align-items:center;gap:6px;margin-top:22px"><input id="vrAuto" type="checkbox" style="flex:0"> Tự truy hồi trước khi gọi AI</label></div>' +
      '<div class="row" style="margin-top:8px"><button id="vrSave">Lưu cấu hình</button><button id="vrReindex" class="ghost">Lập chỉ mục lại toàn bộ</button><span id="vrMsg" class="muted">Tài liệu nổi bật được nạp NGUYÊN VĂN (tối đa Full-doc token); đổi chunk cần re-index.</span></div>';

    var collectionsC = card(m, "Collections và quyền truy cập");
    collectionsC.innerHTML =
      '<div class="row"><input id="vcName" placeholder="Tên Collection" style="flex:2"><input id="vcSlug" placeholder="slug" style="flex:1"><input id="vcDesc" placeholder="Mô tả" style="flex:3"><button id="vcAdd">＋ Tạo</button></div>' +
      '<div class="muted" style="margin-top:5px">Mỗi grant là một cặp: agent (tất cả/cụ thể) × đối tượng (tất cả/người/conversation/role).</div><div id="vcList" style="margin-top:10px"></div>';

    var docC = card(m, "Thêm tài liệu");
    docC.innerHTML =
      '<div class="row" style="margin-bottom:8px"><button id="vTabUp" class="sm">📄 Tải file lên</button><button id="vTabMd" class="ghost sm">✍ Soạn trực tiếp</button></div>' +
      '<div id="vPaneUp">' +
      '<div class="row"><select id="vuCollection" style="flex:1"></select>' +
      '<input id="vuFiles" type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.json" style="flex:2">' +
      '<button id="vuGo">Tải lên và lập chỉ mục</button></div>' +
      '<div class="muted" style="margin-top:5px">Hỗ trợ PDF, Word (docx), Excel (xlsx/xls), txt, md, csv, json — tối đa 20 file/lần, 100MB/file và 100MB/lần. Hệ thống tự trích text, đặt slug theo tên file; file trùng tên sẽ CẬP NHẬT tài liệu cũ (nội dung y hệt thì bỏ qua, không tốn embedding).</div>' +
      '<div id="vuOut" style="margin-top:8px"></div>' +
      '</div>' +
      '<div id="vPaneMd" style="display:none">' +
      '<div class="row"><select id="vdCollection" style="flex:1"></select><input id="vdSlug" placeholder="slug" style="flex:1"><input id="vdTitle" placeholder="Tiêu đề" style="flex:2"></div>' +
      '<label>Nội dung Markdown</label><textarea id="vdContent" rows="10" style="width:100%;resize:vertical"></textarea>' +
      '<div class="row" style="margin-top:8px"><button id="vdSave">Lưu và lập chỉ mục</button><button id="vdClear" class="ghost">Nhập mới</button><span id="vdMsg" class="muted"></span></div>' +
      '</div>';

    var searchC = card(m, "Preview đúng quyền agent/người dùng");
    searchC.innerHTML =
      '<div class="row"><input id="vsQ" placeholder="Câu hỏi của người dùng" style="flex:3"><select id="vsAgent" style="flex:1"></select><select id="vsPrincipal" style="flex:1"></select><select id="vsConversation" style="flex:1"></select><button id="vsGo" class="ghost">Tìm hybrid</button></div>' +
      '<div id="vsOut" style="margin-top:10px"></div>';
    var docsC = card(m, "Tài liệu và trạng thái index");

    var collections = [], access = { agents: [], principals: [], conversations: [] };
    function option(value, label, selected) { return '<option value="' + esc(value) + '"' + (selected ? " selected" : "") + '>' + esc(label) + '</option>'; }
    function collectionName(id) { var c = collections.find(function (x) { return x.id === id; }); return c ? c.name : id; }
    function fillSelectors() {
      $("#vdCollection").innerHTML = collections.map(function (c) { return option(c.id, c.name + (c.isDefault ? " (mặc định)" : "")); }).join("");
      $("#vuCollection").innerHTML = collections.map(function (c) { return option(c.id, c.name + (c.isDefault ? " (mặc định)" : "")); }).join("");
      $("#vsAgent").innerHTML = access.agents.map(function (a) { return option(a.id, a.name); }).join("");
      $("#vsPrincipal").innerHTML = option("", "Người đang đăng nhập") + access.principals.map(function (p) { return option(p.id, p.displayName); }).join("");
      $("#vsConversation").innerHTML = option("", "Không chọn conversation") + access.conversations.map(function (c) { return option(c.id, c.title || c.externalChatId); }).join("");
    }
    function grantLabel(g) {
      var agent = g.agentId ? (access.agents.find(function (a) { return a.id === g.agentId; }) || {}).name || g.agentId : "Tất cả agent";
      var audience = "Tất cả người dùng";
      if (g.audienceType === "principal") audience = "Người: " + ((access.principals.find(function (p) { return p.id === g.principalId; }) || {}).displayName || g.principalId);
      if (g.audienceType === "conversation") audience = "Conversation: " + ((access.conversations.find(function (c) { return c.id === g.conversationId; }) || {}).title || g.conversationId);
      if (g.audienceType === "role") audience = "Role: " + g.role;
      return agent + " × " + audience;
    }
    function openGrants(c) {
      Promise.all([api("/v1/vault/collections/" + c.id + "/grants"), api("/v1/vault/access-options")]).then(function (res) {
        access = res[1]; var grants = res[0].grants || [];
        var dlg = el("dialog", { style: "width:760px;max-width:95vw;padding:20px" });
        dlg.innerHTML = '<h3 style="margin-top:0">Phân quyền: ' + esc(c.name) + '</h3>' +
          '<div class="muted">Trong một dòng là AND; nhiều dòng là OR. Xóa hết grant sẽ làm Collection không agent nào đọc được.</div>' +
          '<div class="row" style="margin-top:10px"><select id="vgAgent" style="flex:1"></select><select id="vgType" style="flex:1"><option value="all">Tất cả người dùng</option><option value="principal">Người cụ thể</option><option value="conversation">Conversation cụ thể</option><option value="role">Role workspace</option></select><select id="vgTarget" style="flex:1"></select><button id="vgAdd">＋ Thêm</button></div>' +
          '<div id="vgRows" style="margin-top:12px"></div><div class="row" style="margin-top:14px"><button id="vgSave">Lưu quyền</button><button id="vgClose" class="ghost">Đóng</button><span id="vgMsg" class="muted"></span></div>';
        document.body.appendChild(dlg); dlg.showModal();
        $("#vgAgent", dlg).innerHTML = option("", "Tất cả agent") + access.agents.map(function (a) { return option(a.id, a.name); }).join("");
        function targets() {
          var t = $("#vgType", dlg).value;
          if (t === "all") $("#vgTarget", dlg).innerHTML = option("", "Không cần chọn");
          if (t === "principal") $("#vgTarget", dlg).innerHTML = access.principals.map(function (p) { return option(p.id, p.displayName); }).join("");
          if (t === "conversation") $("#vgTarget", dlg).innerHTML = access.conversations.map(function (x) { return option(x.id, x.title || x.externalChatId); }).join("");
          if (t === "role") $("#vgTarget", dlg).innerHTML = option("ws_admin", "ws_admin") + option("operator", "operator") + option("viewer", "viewer");
        }
        function rows() {
          $("#vgRows", dlg).innerHTML = grants.length ? grants.map(function (g, i) { return '<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:7px 0"><span>' + esc(grantLabel(g)) + '</span><button class="ghost sm vgDel" data-i="' + i + '">Bỏ</button></div>'; }).join("") : '<span class="muted">(không có grant — Collection đang bị khóa)</span>';
          Array.from(dlg.querySelectorAll(".vgDel")).forEach(function (b) { b.onclick = function () { grants.splice(parseInt(b.getAttribute("data-i"), 10), 1); rows(); }; });
        }
        $("#vgType", dlg).onchange = targets; targets(); rows();
        $("#vgAdd", dlg).onclick = function () {
          var type = $("#vgType", dlg).value, target = $("#vgTarget", dlg).value;
          if (type !== "all" && !target) { $("#vgMsg", dlg).textContent = "Chưa có đối tượng phù hợp để chọn"; return; }
          var g = { audienceType: type };
          if ($("#vgAgent", dlg).value) g.agentId = $("#vgAgent", dlg).value;
          if (type === "principal") g.principalId = target;
          if (type === "conversation") g.conversationId = target;
          if (type === "role") g.role = target;
          grants.push(g); rows();
        };
        $("#vgClose", dlg).onclick = function () { dlg.close(); dlg.remove(); };
        $("#vgSave", dlg).onclick = function () {
          $("#vgMsg", dlg).textContent = "Đang lưu...";
          api("/v1/vault/collections/" + c.id + "/grants", { method: "PUT", body: { grants: grants.map(function (g) { return { agentId: g.agentId || undefined, audienceType: g.audienceType, principalId: g.principalId || undefined, conversationId: g.conversationId || undefined, role: g.role || undefined }; }) } })
            .then(function () { toast("Đã cập nhật quyền Collection"); dlg.close(); dlg.remove(); })
            .catch(function (e) { $("#vgMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
        };
      }).catch(function (e) { toast(e.message, 1); });
    }
    function renderCollections() {
      $("#vcList").innerHTML = "";
      $("#vcList").appendChild(table(["Collection", "Mô tả", "Chế độ nạp", "Trạng thái", ""], collections, function (c) {
        var tr = el("tr");
        tr.innerHTML = '<td><b>' + esc(c.name) + '</b><br><code>' + esc(c.slug) + '</code>' + (c.isDefault ? ' <span class="pill ok">mặc định</span>' : '') + '</td><td class="muted">' + esc(c.description || "") + '</td>';
        // Chế độ nạp context: auto (tìm trúng → toàn văn) | always_full (nạp mọi lượt) | search_only (chỉ chunk)
        var tdMode = el("td");
        var modeSel = el("select", { "class": "sm", style: "padding:4px", title: "auto: tìm trúng thì nạp nguyên văn · luôn nạp toàn bộ: mọi tài liệu vào mọi lượt chat (bảng giá, chính sách) · chỉ tìm chunk: kho lớn chỉ trích đoạn" });
        modeSel.innerHTML = option("auto", "auto", c.retrievalMode !== "always_full" && c.retrievalMode !== "search_only") + option("always_full", "luôn nạp toàn bộ", c.retrievalMode === "always_full") + option("search_only", "chỉ tìm chunk", c.retrievalMode === "search_only");
        modeSel.onchange = function () { api("/v1/vault/collections/" + c.id, { method: "PATCH", body: { retrievalMode: modeSel.value } }).then(function () { toast("Đã đổi chế độ nạp"); loadAll(); }).catch(function (e) { toast(e.message, 1); loadAll(); }); };
        tdMode.appendChild(modeSel); tr.appendChild(tdMode);
        var tdStatus = el("td"); tdStatus.innerHTML = c.enabled ? '<span class="ok">bật</span>' : '<span class="err">tắt</span>'; tr.appendChild(tdStatus);
        var td = el("td"); var grant = el("button", { "class": "ghost sm" }, "Phân quyền"); grant.onclick = function () { openGrants(c); }; td.appendChild(grant);
        if (!c.isDefault) { var toggle = el("button", { "class": "ghost sm", style: "margin-left:5px" }, c.enabled ? "Tắt" : "Bật"); toggle.onclick = function () { api("/v1/vault/collections/" + c.id, { method: "PATCH", body: { enabled: !c.enabled } }).then(loadAll).catch(function (e) { toast(e.message, 1); }); }; td.appendChild(toggle); var del = el("button", { "class": "ghost sm", style: "margin-left:5px" }, "Xóa"); del.onclick = function () { if (confirm("Xóa Collection rỗng này?")) api("/v1/vault/collections/" + c.id, { method: "DELETE" }).then(loadAll).catch(function (e) { toast(e.message, 1); }); }; td.appendChild(del); }
        tr.appendChild(td); return tr;
      }));
    }
    function loadDocs() {
      api("/v1/vault").then(function (j) {
        docsC.innerHTML = "<h3>Tài liệu và trạng thái index</h3>";
        docsC.appendChild(table(["Collection", "Slug / Tiêu đề", "Index", "Cập nhật", ""], j.docs || [], function (r) {
          var tr = el("tr"); var statusClass = r.indexStatus === "ready" ? "ok" : (r.indexStatus === "error" ? "err" : "muted");
          tr.innerHTML = '<td>' + esc(collectionName(r.collectionId)) + '</td><td><code>' + esc(r.slug) + '</code><br>' + esc(r.title) + '</td><td><span class="' + statusClass + '">' + esc(r.indexStatus) + '</span><br><span class="muted">' + esc(r.chunkCount) + ' chunk' + (r.indexError ? ' · ' + esc(r.indexError) : '') + '</span></td><td class="muted">' + esc((r.updatedAt || "").slice(0, 16)) + '</td>';
          var td = el("td"); var edit = el("button", { "class": "ghost sm" }, "Sửa"); edit.onclick = function () { api("/v1/vault/" + encodeURIComponent(r.slug)).then(function (j2) { showPane(false); $("#vdCollection").value = j2.doc.collectionId; $("#vdSlug").value = j2.doc.slug; $("#vdTitle").value = j2.doc.title; $("#vdContent").value = j2.doc.content; docC.scrollIntoView({ behavior: "smooth" }); }); }; td.appendChild(edit); var del = el("button", { "class": "ghost sm", style: "margin-left:5px" }, "Xóa"); del.onclick = function () { if (confirm("Xóa tài liệu " + r.slug + "?")) api("/v1/vault/" + r.id, { method: "DELETE" }).then(loadDocs).catch(function (e) { toast(e.message, 1); }); }; td.appendChild(del); tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { docsC.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }
    function loadAll() {
      Promise.all([api("/v1/vault/settings"), api("/v1/vault/collections"), api("/v1/vault/access-options")]).then(function (res) {
        var s = res[0].settings; collections = res[1].collections || []; access = res[2];
        $("#vrChunk").value = s.chunkTokens; $("#vrOverlap").value = s.chunkOverlapTokens; $("#vrContext").value = s.contextTokens; $("#vrFull").value = s.fullDocTokens || 16000; $("#vrLimit").value = s.retrievalLimit; $("#vrAuto").checked = s.autoRetrieve;
        fillSelectors(); renderCollections(); loadDocs();
      }).catch(function (e) { toast(e.message, 1); });
    }
    $("#vrSave").onclick = function () {
      var body = { chunkTokens: parseInt($("#vrChunk").value, 10), chunkOverlapTokens: parseInt($("#vrOverlap").value, 10), contextTokens: parseInt($("#vrContext").value, 10), fullDocTokens: parseInt($("#vrFull").value, 10), retrievalLimit: parseInt($("#vrLimit").value, 10), autoRetrieve: $("#vrAuto").checked };
      api("/v1/vault/settings", { method: "PUT", body: body }).then(function () { $("#vrMsg").textContent = "Đã lưu — hãy bấm Lập chỉ mục lại toàn bộ."; toast("Đã lưu cấu hình RAG"); }).catch(function (e) { $("#vrMsg").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    };
    $("#vrReindex").onclick = function () { var b = $("#vrReindex"); b.disabled = true; b.textContent = "Đang re-index..."; api("/v1/vault/reindex", { method: "POST" }).then(function (j) { var failed = j.results.filter(function (x) { return !x.ok; }).length; toast("Re-index xong: " + j.results.length + " tài liệu, lỗi " + failed, failed > 0); loadDocs(); }).catch(function (e) { toast(e.message, 1); }).finally(function () { b.disabled = false; b.textContent = "Lập chỉ mục lại toàn bộ"; }); };
    $("#vcName").oninput = function () { if (!$("#vcSlug").dataset.dirty) $("#vcSlug").value = slugifyKey($("#vcName").value); }; $("#vcSlug").oninput = function () { $("#vcSlug").dataset.dirty = "1"; };
    $("#vcAdd").onclick = function () { var body = { name: $("#vcName").value.trim(), slug: $("#vcSlug").value.trim(), description: $("#vcDesc").value.trim() }; if (!body.name || !body.slug) return toast("Thiếu tên/slug Collection", 1); api("/v1/vault/collections", { method: "POST", body: body }).then(function () { $("#vcName").value = $("#vcSlug").value = $("#vcDesc").value = ""; toast("Đã tạo Collection"); loadAll(); }).catch(function (e) { toast(e.message, 1); }); };
    $("#vdClear").onclick = function () { $("#vdSlug").value = $("#vdTitle").value = $("#vdContent").value = ""; };
    $("#vdSave").onclick = function () { var body = { collectionId: $("#vdCollection").value, slug: $("#vdSlug").value.trim(), title: $("#vdTitle").value.trim(), content: $("#vdContent").value.trim() }; if (!body.slug || !body.title || !body.content) return toast("Thiếu slug, tiêu đề hoặc nội dung", 1); var b = $("#vdSave"); b.disabled = true; $("#vdMsg").textContent = "Đang chunk và tạo embedding..."; api("/v1/vault", { method: "POST", body: body }).then(function (j) { $("#vdMsg").textContent = "Đã index " + j.index.chunks + " chunk" + (j.index.embedded ? " bằng embedding" : " FTS-only"); toast("Đã lưu tài liệu"); loadDocs(); }).catch(function (e) { $("#vdMsg").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }).finally(function () { b.disabled = false; }); };
    function search() { var q = $("#vsQ").value.trim(); if (!q) return; var url = "/v1/vault-search?q=" + encodeURIComponent(q) + "&agentId=" + encodeURIComponent($("#vsAgent").value); if ($("#vsPrincipal").value) url += "&principalId=" + encodeURIComponent($("#vsPrincipal").value); if ($("#vsConversation").value) url += "&conversationId=" + encodeURIComponent($("#vsConversation").value); $("#vsOut").textContent = "Đang tìm keyword + vector..."; api(url).then(function (j) { $("#vsOut").innerHTML = j.hits.length ? j.hits.map(function (h) { return '<div style="margin-bottom:10px"><span class="pill">' + esc(h.collectionName) + '</span> <code>' + esc(h.slug) + '</code> — <b>' + esc(h.title) + '</b><br><span class="muted">' + esc(h.headingPath || "không tiêu đề") + ' · chunk ' + esc(h.ordinal) + ' · ' + esc((h.sources || []).join("+")) + '</span><br>' + esc(String(h.content || "").replace(/\\s+/g, " ").slice(0, 500)) + '</div>'; }).join("") : '<span class="muted">(không có chunk phù hợp trong phạm vi được cấp)</span>'; }).catch(function (e) { $("#vsOut").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }); }
    $("#vsGo").onclick = search; $("#vsQ").onkeydown = function (e) { if (e.key === "Enter") search(); };

    // ===== Tab Tải file lên / Soạn trực tiếp =====
    function showPane(up) {
      $("#vPaneUp").style.display = up ? "" : "none";
      $("#vPaneMd").style.display = up ? "none" : "";
      $("#vTabUp").className = up ? "sm" : "ghost sm";
      $("#vTabMd").className = up ? "ghost sm" : "sm";
    }
    $("#vTabUp").onclick = function () { showPane(true); };
    $("#vTabMd").onclick = function () { showPane(false); };

    function fileToB64(file) {
      return new Promise(function (resolvefn, rejectfn) {
        var reader = new FileReader();
        reader.onload = function () { resolvefn(String(reader.result).split(",")[1] || ""); };
        reader.onerror = function () { rejectfn(new Error("Không đọc được file " + file.name)); };
        reader.readAsDataURL(file);
      });
    }
    $("#vuGo").onclick = function () {
      var files = Array.from($("#vuFiles").files || []);
      if (!files.length) return toast("Chưa chọn file nào", 1);
      if (files.length > 20) return toast("Tối đa 20 file mỗi lần", 1);
      var tooBig = files.find(function (f) { return f.size > 100 * 1024 * 1024; });
      if (tooBig) return toast("File " + tooBig.name + " vượt 100MB", 1);
      if (files.reduce(function (n, f) { return n + f.size; }, 0) > 100 * 1024 * 1024) return toast("Tổng file mỗi lần vượt 100MB", 1);
      var b = $("#vuGo"); b.disabled = true;
      $("#vuOut").innerHTML = '<span class="muted">Đang đọc ' + files.length + " file...</span>";
      Promise.all(files.map(function (f) { return fileToB64(f).then(function (b64) { return { name: f.name, contentB64: b64 }; }); }))
        .then(function (payload) {
          $("#vuOut").innerHTML = '<span class="muted">Đang trích text, chunk và tạo embedding (' + files.length + ' file)... File lớn có thể mất 1-2 phút.</span>';
          return api("/v1/vault/upload", { method: "POST", body: { collectionId: $("#vuCollection").value, files: payload } });
        })
        .then(function (j) {
          var ok = 0;
          $("#vuOut").innerHTML = (j.results || []).map(function (r) {
            if (r.ok) ok++;
            if (!r.ok) return '<div><span class="err">✗ ' + esc(r.name) + "</span> — " + esc(r.error || "lỗi") + "</div>";
            var note = r.skipped ? "không đổi, giữ index cũ" : (r.chunks + " chunk, " + (r.embedded ? "có embedding" : "FTS-only"));
            return '<div><span class="ok">✓ ' + esc(r.name) + '</span> → <code>' + esc(r.slug) + "</code> — " + note + (r.warning ? ' <span class="err">(' + esc(r.warning) + ")</span>" : "") + "</div>";
          }).join("");
          toast("Xong: " + ok + "/" + (j.results || []).length + " file", ok < (j.results || []).length);
          $("#vuFiles").value = "";
          loadDocs();
        })
        .catch(function (e) { $("#vuOut").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; })
        .finally(function () { b.disabled = false; });
    };

    loadAll();
  };

  PAGES.memory = function () {
    var WORKSPACE = "__workspace__";
    var m = page("Memory", "Bộ nhớ dài hạn của từng agent và Workspace Semantic dùng chung cho nhiều agent");
    var c = card(m);
    c.innerHTML =
      '<div class="row"><select id="mAgent" title="Nguồn bộ nhớ"></select>' +
      '<select id="mUser"><option value="">(tất cả người dùng)</option></select>' +
      '<input id="mSearch" placeholder="tìm trong bộ nhớ..." style="flex:2">' +
      '<button id="mLoad" class="ghost">Xem</button>' +
      '<button id="mPrune" class="ghost">Dọn cũ</button></div>';
    var addC = card(m, "Thêm ghi nhớ");
    addC.innerHTML +=
      '<div id="memScopeHelp" class="muted" style="margin-bottom:8px"></div>' +
      '<label for="memText">Nội dung dạy AI</label>' +
      '<textarea id="memText" class="memory-textarea" rows="8" placeholder="Nhập thông tin, quy tắc hoặc kiến thức cần AI ghi nhớ..."></textarea>' +
      '<div class="muted" style="margin-top:5px">Có thể kéo góc dưới bên phải để mở rộng ô nhập. Nhấn Ctrl + Enter để thêm nhanh.</div>' +
      '<div class="memory-meta">' +
      '<div><label id="memTierLabel" for="memTier">Loại ghi nhớ</label><select id="memTier"><option value="semantic">semantic</option><option value="episodic">episodic</option></select></div>' +
      '<div><label for="memImp">Mức quan trọng</label><input id="memImp" type="number" step="0.1" min="0" max="1" value="0.8"></div>' +
      '<div><label id="memUserLabel" for="memUser">Phạm vi người dùng</label><input id="memUser" placeholder="user key (để trống = dùng chung)"></div>' +
      '<button id="memAdd">Thêm ghi nhớ</button></div>';
    var docsC = card(m, "File ghi nhớ (MEMORY.md, memory/*.md)");
    var listC = card(m, "Danh sách");

    function isWorkspace() { return $("#mAgent").value === WORKSPACE; }

    function syncMode() {
      var workspace = isWorkspace();
      $("#mUser").style.display = workspace ? "none" : "";
      $("#mPrune").style.display = workspace ? "none" : "";
      docsC.style.display = workspace ? "none" : "";
      $("#memTier").disabled = workspace;
      $("#memUser").disabled = workspace;
      if (workspace) {
        $("#memTier").value = "semantic";
        $("#memUser").value = "";
        $("#memTierLabel").textContent = "Loại (cố định)";
        $("#memUserLabel").textContent = "Phạm vi";
        $("#memUser").placeholder = "Tất cả agent đang bật Workspace Semantic";
        $("#memScopeHelp").innerHTML = '<span class="pill ok">Workspace Semantic</span> Dùng chung cho mọi agent đang bật. Chỉ mục được ghim mới luôn nạp; mục khác được tìm khi câu hỏi liên quan.';
        addC.querySelector("h3").textContent = "Thêm kiến thức chung cho workspace";
      } else {
        $("#memTierLabel").textContent = "Loại ghi nhớ";
        $("#memUserLabel").textContent = "Phạm vi người dùng";
        $("#memUser").placeholder = "user key (để trống = dùng chung)";
        $("#memScopeHelp").innerHTML = 'Ghi nhớ chỉ thuộc agent đang chọn. Để trống user key = dùng chung cho mọi người dùng của agent này.';
        addC.querySelector("h3").textContent = "Thêm ghi nhớ cho agent";
      }
    }

    function loadDocs() {
      var k = $("#mAgent").value; if (!k || isWorkspace()) return;
      var qs = $("#mUser").value ? "?userKey=" + encodeURIComponent($("#mUser").value) : "";
      api("/v1/agents/" + k + "/memory-docs" + qs).then(function (j) {
        docsC.innerHTML = "<h3>File ghi nhớ (MEMORY.md, memory/*.md)</h3>" +
          '<div class="muted" style="margin-bottom:6px">Agent tự ghi bằng write_file — tìm lại bằng memory_search, đọc bằng memory_get.</div>';
        if (!j.docs.length) { docsC.innerHTML += '<div class="muted">(chưa có file ghi nhớ nào)</div>'; return; }
        docsC.appendChild(table(["Path", "Phạm vi", "Kích thước", "Cập nhật", ""], j.docs, function (r) {
          var tr = el("tr");
          var scope = r.userKey ? '<span class="pill">' + esc(r.userKey) + "</span>" : '<span class="pill ok">chung</span>';
          tr.innerHTML =
            "<td><code>" + esc(r.path) + "</code></td><td>" + scope + "</td>" +
            "<td>" + Math.max(1, Math.round(r.bytes / 1024)) + " KB</td>" +
            "<td class='muted'>" + esc((r.updatedAt || "").slice(0, 16).replace("T", " ")) + "</td>";
          var td = el("td");
          var view = el("button", { "class": "ghost sm" }, "Xem");
          view.onclick = function () {
            api("/v1/memory-docs/" + r.id).then(function (d) {
              var w = window.open("", "_blank");
              w.document.write("<pre style='white-space:pre-wrap;font-family:ui-monospace,monospace;padding:16px'>" + esc(d.doc.content) + "</pre>");
              w.document.title = d.doc.path;
            }).catch(function (e) { toast(e.message, 1); });
          };
          var del = el("button", { "class": "ghost sm" }, "Xóa");
          del.onclick = function () {
            if (!confirm("Xóa file ghi nhớ " + r.path + "? (bản trên đĩa của agent không bị xóa)")) return;
            api("/v1/memory-docs/" + r.id, { method: "DELETE" }).then(loadDocs).catch(function (e) { toast(e.message, 1); });
          };
          td.appendChild(view); td.appendChild(document.createTextNode(" ")); td.appendChild(del);
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { docsC.innerHTML += '<span class="err">' + esc(e.message) + "</span>"; });
    }

    function openMemoryEdit(r, workspace) {
      var dlg = el("dialog", { "class": "memory-edit-dialog" });
      var scope = workspace ? "Workspace — tất cả agent đang bật" : (r.userKey || "chung trong agent");
      dlg.innerHTML =
        '<h3 style="margin:0 0 4px">Sửa ' + (workspace ? "Workspace Semantic" : "ghi nhớ") + '</h3>' +
        '<div class="muted" style="margin-bottom:12px">Loại: <b>' + esc(workspace ? "semantic" : r.tier) + '</b> · Phạm vi: <b>' + esc(scope) + '</b></div>' +
        '<label for="memEditText">Nội dung dạy AI</label>' +
        '<textarea id="memEditText" class="memory-textarea" rows="12"></textarea>' +
        '<div class="muted" style="margin-top:5px">Có thể kéo góc dưới bên phải để mở rộng thêm.</div>' +
        '<label for="memEditImp">Mức quan trọng (0 đến 1)</label>' +
        '<input id="memEditImp" type="number" step="0.1" min="0" max="1" style="width:150px">' +
        '<div class="dialog-actions"><button id="memEditCancel" class="ghost">Hủy</button><button id="memEditSave">Lưu thay đổi</button></div>';
      document.body.appendChild(dlg);
      var editText = $("#memEditText", dlg);
      var editImp = $("#memEditImp", dlg);
      var saveBtn = $("#memEditSave", dlg);
      editText.value = r.content;
      editImp.value = Number(r.importance).toFixed(1);
      function closeEdit() { dlg.close(); dlg.remove(); }
      dlg.addEventListener("cancel", function () { dlg.remove(); });
      $("#memEditCancel", dlg).onclick = closeEdit;
      saveBtn.onclick = function () {
        var content = editText.value.trim();
        var importance = Number(editImp.value);
        if (!content) { toast("Nội dung ghi nhớ không được để trống", 1); editText.focus(); return; }
        if (!Number.isFinite(importance) || importance < 0 || importance > 1) { toast("Mức quan trọng phải từ 0 đến 1", 1); editImp.focus(); return; }
        saveBtn.disabled = true;
        var endpoint = workspace ? "/v1/workspace-memories/" + r.id : "/v1/memories/" + r.id;
        api(endpoint, { method: "PATCH", body: { content: content, importance: importance } })
          .then(function () { toast("Đã lưu thay đổi"); closeEdit(); load(); })
          .catch(function (e) { saveBtn.disabled = false; toast(e.message, 1); });
      };
      editText.addEventListener("keydown", function (e) { if (e.ctrlKey && e.key === "Enter") saveBtn.click(); });
      dlg.showModal();
      editText.focus();
      editText.setSelectionRange(editText.value.length, editText.value.length);
    }

    function renderList(rows, workspace) {
      listC.innerHTML = "<h3>Danh sách " + (workspace ? "Workspace Semantic" : "ghi nhớ của agent") + "</h3>";
      if (workspace) {
        listC.innerHTML += '<div class="muted" style="margin-bottom:8px">📌 Ghim = luôn nạp vào agent đang bật (tối đa 4 mục, ngân sách 4.000 ký tự). Không ghim = chỉ truy hồi khi câu hỏi liên quan.</div>';
      }
      listC.appendChild(table(["Nguồn", "Phạm vi", "Nội dung", "Mức", ""], rows, function (r) {
        var tr = el("tr");
        var source = workspace ? '<span class="pill ok">workspace semantic</span>' : '<span class="pill">' + esc(r.tier) + "</span>";
        var scope = workspace
          ? '<span class="pill ok">tất cả agent đang bật</span>'
          : (r.userKey ? '<span class="pill">' + esc(r.userKey) + "</span>" : '<span class="pill ok">chung trong agent</span>');
        tr.innerHTML =
          "<td>" + source + "</td><td>" + scope + "</td>" +
          '<td><span class="memtxt">' + esc(r.content) + "</span></td>" +
          '<td>' + (r.pinned ? "📌 " : "") + Number(r.importance).toFixed(1) + "</td>";
        var td = el("td");
        var endpoint = workspace ? "/v1/workspace-memories/" + r.id : "/v1/memories/" + r.id;
        var pin = el("button", { "class": "ghost sm" }, r.pinned ? "Bỏ ghim" : "Ghim");
        pin.onclick = function () { api(endpoint, { method: "PATCH", body: { pinned: !r.pinned } }).then(load).catch(function (e) { toast(e.message, 1); }); };
        var edit = el("button", { "class": "ghost sm" }, "Sửa");
        edit.onclick = function () { openMemoryEdit(r, workspace); };
        var del = el("button", { "class": "ghost sm" }, "Xóa");
        del.onclick = function () {
          if (!confirm("Xóa " + (workspace ? "kiến thức Workspace Semantic" : "ghi nhớ") + " này?")) return;
          api(endpoint, { method: "DELETE" }).then(function () { toast("Đã xóa"); load(); }).catch(function (e) { toast(e.message, 1); });
        };
        td.appendChild(pin); td.appendChild(document.createTextNode(" "));
        td.appendChild(edit); td.appendChild(document.createTextNode(" "));
        td.appendChild(del); tr.appendChild(td); return tr;
      }));
    }

    function load() {
      var k = $("#mAgent").value; if (!k) return;
      syncMode();
      var search = $("#mSearch").value.trim();
      if (isWorkspace()) {
        var wsQs = search ? "?search=" + encodeURIComponent(search) : "";
        api("/v1/workspace-memories" + wsQs)
          .then(function (j) { renderList(j.memories, true); })
          .catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
        return;
      }
      loadDocs();
      var qs = [];
      if ($("#mUser").value) qs.push("userKey=" + encodeURIComponent($("#mUser").value));
      if (search) qs.push("search=" + encodeURIComponent(search));
      api("/v1/agents/" + k + "/memories" + (qs.length ? "?" + qs.join("&") : "")).then(function (j) {
        var cur = $("#mUser").value;
        $("#mUser").innerHTML = '<option value="">(tất cả người dùng)</option>' +
          (j.userKeys || []).map(function (u) { return '<option value="' + esc(u) + '"' + (u === cur ? " selected" : "") + ">" + esc(u) + "</option>"; }).join("");
        renderList(j.memories, false);
      }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }

    api("/v1/agents").then(function (j) {
      $("#mAgent").innerHTML = '<option value="' + WORKSPACE + '">🌐 Workspace Semantic — tất cả agent</option>' +
        j.agents.map(function (a) { return '<option value="' + esc(a.key) + '">🤖 ' + esc(a.name) + "</option>"; }).join("");
      if (j.agents.length) $("#mAgent").value = j.agents[0].key;
      syncMode(); load();
    });
    $("#mLoad").onclick = load;
    $("#mAgent").onchange = function () { $("#mUser").innerHTML = '<option value="">(tất cả người dùng)</option>'; syncMode(); load(); };
    $("#mUser").onchange = load;
    $("#mSearch").addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    $("#mPrune").onclick = function () {
      if (isWorkspace()) return;
      if (!confirm("Xóa ghi nhớ episodic cũ hơn 30 ngày, mức quan trọng thấp, chưa ghim?")) return;
      api("/v1/agents/" + $("#mAgent").value + "/memories/prune", { method: "POST", body: { olderThanDays: 30 } })
        .then(function (r) { toast("Đã dọn " + r.removed + " ghi nhớ"); load(); }).catch(function (e) { toast(e.message, 1); });
    };
    $("#memAdd").onclick = function () {
      var content = $("#memText").value.trim();
      var importance = Number($("#memImp").value);
      if (!content) { toast("Hãy nhập nội dung cần AI ghi nhớ", 1); $("#memText").focus(); return; }
      if (!Number.isFinite(importance) || importance < 0 || importance > 1) { toast("Mức quan trọng phải từ 0 đến 1", 1); $("#memImp").focus(); return; }
      var endpoint;
      var body;
      if (isWorkspace()) {
        endpoint = "/v1/workspace-memories";
        body = { content: content, importance: importance, pinned: false };
      } else {
        endpoint = "/v1/agents/" + $("#mAgent").value + "/memories";
        body = { content: content, importance: importance, tier: $("#memTier").value };
        if ($("#memUser").value.trim()) body.userKey = $("#memUser").value.trim();
      }
      api(endpoint, { method: "POST", body: body })
        .then(function () { $("#memText").value = ""; toast(isWorkspace() ? "Đã thêm Workspace Semantic" : "Đã thêm ghi nhớ"); load(); })
        .catch(function (e) { toast(e.message, 1); });
    };
    $("#memText").addEventListener("keydown", function (e) { if (e.ctrlKey && e.key === "Enter") $("#memAdd").click(); });
  };

  PAGES.teams = function () {
    var m = page("Teams", "Nhóm agent + bảng công việc");
    var c = card(m, "Tạo team"); c.innerHTML += '<div class="row"><input id="tmName" placeholder="Tên team"><button id="tmCreate">Tạo</button></div>';
    $("#tmCreate").onclick = function () { api("/v1/teams", { method: "POST", body: { name: $("#tmName").value.trim() } }).then(function () { toast("Đã tạo"); load(); }).catch(function (e) { toast(e.message, 1); }); };
    var listC = card(m, "Danh sách team");
    function load() {
      api("/v1/teams").then(function (j) {
        listC.innerHTML = "<h3>Danh sách team</h3>";
        listC.appendChild(table(["ID", "Tên", "Thành viên", "Task"], j.teams, function (r) {
          var tr = el("tr");
          tr.innerHTML = "<td><code>" + esc(r.id.slice(0, 8)) + "</code></td><td>" + esc(r.name) + "</td>";
          var tdM = el("td"); var addM = el("input", { placeholder: "agent key", style: "width:100px" }); var bM = el("button", { "class": "ghost sm" }, "+"); bM.onclick = function () { api("/v1/teams/" + r.id + "/members", { method: "POST", body: { agentKey: addM.value.trim() } }).then(function () { toast("Đã thêm member"); }).catch(function (e) { toast(e.message, 1); }); }; tdM.appendChild(addM); tdM.appendChild(bM); tr.appendChild(tdM);
          var tdT = el("td"); var addT = el("input", { placeholder: "tiêu đề task", style: "width:120px" }); var bT = el("button", { "class": "ghost sm" }, "+"); bT.onclick = function () { api("/v1/teams/" + r.id + "/tasks", { method: "POST", body: { title: addT.value.trim() } }).then(function () { toast("Đã thêm task"); }).catch(function (e) { toast(e.message, 1); }); }; tdT.appendChild(addT); tdT.appendChild(bT); tr.appendChild(tdT);
          return tr;
        }));
      });
    }
    load();
  };

  PAGES.kg = function () {
    var m = page("Knowledge Graph", "Đồ thị tri thức (entity + quan hệ)");
    var ex = card(m, "Trích xuất từ văn bản (LLM)");
    ex.innerHTML += '<div class="row"><input id="kgAgent" placeholder="agent key" value="tro-ly" style="width:120px"></div><textarea id="kgText" rows="3" style="width:100%;margin-top:6px" placeholder="Dán văn bản để trích entity/quan hệ..."></textarea><div class="row" style="margin-top:6px"><button id="kgExtract">Trích xuất</button><span id="kgMsg" class="muted"></span></div>';
    $("#kgExtract").onclick = function () { $("#kgMsg").textContent = "đang xử lý..."; api("/v1/kg/extract", { method: "POST", body: { agentKey: $("#kgAgent").value.trim(), text: $("#kgText").value } }).then(function (r) { $("#kgMsg").innerHTML = '<span class="ok">+' + r.entities + " entity, +" + r.relations + " quan hệ</span>"; load(); }).catch(function (e) { $("#kgMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; }); };
    var tr = card(m, "Duyệt đồ thị"); tr.innerHTML += '<div class="row"><input id="kgName" placeholder="tên entity"><button id="kgGo" class="ghost">Duyệt</button></div><div id="kgResult" style="margin-top:8px"></div>';
    $("#kgGo").onclick = function () { api("/v1/kg/traverse/" + encodeURIComponent($("#kgName").value.trim())).then(function (j) { $("#kgResult").innerHTML = j.nodes.length ? j.nodes.map(function (n) { return "→ (" + esc(n.relation) + ", sâu " + n.depth + ") <b>" + esc(n.name) + "</b>"; }).join("<br>") : '<span class="muted">(không có quan hệ)</span>'; }); };
    var listC = card(m, "Thực thể");
    function load() { api("/v1/kg/entities").then(function (j) { listC.innerHTML = "<h3>Thực thể</h3>"; listC.appendChild(table(["Tên", "Loại", "Mô tả"], j.entities, function (r) { var t = el("tr"); t.innerHTML = "<td>" + esc(r.name) + "</td><td><span class='pill'>" + esc(r.type) + "</span></td><td class='muted'>" + esc(r.summary) + "</td>"; return t; })); }); }
    load();
  };

  PAGES.webhooks = function () {
    var m = page("Webhooks", "Trigger agent từ hệ thống ngoài (HMAC)");
    var c = card(m, "Tạo webhook cho agent"); c.innerHTML += '<div class="row"><input id="whAgent" placeholder="agent key" value="tro-ly"><button id="whCreate">Tạo</button></div><div id="whMsg" style="margin-top:8px"></div>';
    $("#whCreate").onclick = function () { api("/v1/agents/" + $("#whAgent").value.trim() + "/webhooks", { method: "POST" }).then(function (r) { $("#whMsg").innerHTML = 'URL: <code>' + esc(r.url) + '</code><br>Secret (lưu ngay): <code>' + esc(r.secret) + '</code><br><span class="muted">' + esc(r.note) + '</span>'; }).catch(function (e) { $("#whMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; }); };
  };

  PAGES.apikeys = function () {
    var m = page("Khóa API (tích hợp)", "Khóa psk_… dành cho PHẦN MỀM gọi API PenAI (script, ứng dụng khác tích hợp). Người dùng đăng nhập Dashboard bằng tài khoản ở mục Người dùng.");
    var c = card(m, "Tạo key mới");
    c.innerHTML += '<div class="row"><input id="kName" placeholder="Tên key"><select id="kRole"><option>operator</option><option>viewer</option><option>ws_admin</option></select><button id="kCreate">Tạo</button></div><div id="kMsg" style="margin-top:8px"></div>';
    $("#kCreate").onclick = function () { api("/v1/api-keys", { method: "POST", body: { name: $("#kName").value.trim(), role: $("#kRole").value } }).then(function (r) { $("#kMsg").innerHTML = 'Key (lưu ngay): <code>' + esc(r.apiKey) + "</code>"; load(); }).catch(function (e) { $("#kMsg").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; }); };
    var listC = card(m, "Danh sách");
    function load() { api("/v1/api-keys").then(function (j) { listC.innerHTML = "<h3>Danh sách</h3>"; listC.appendChild(table(["Tên", "Prefix", "Role", "Trạng thái", ""], j.keys, function (r) { var tr = el("tr"); tr.innerHTML = "<td>" + esc(r.name) + "</td><td><code>" + esc(r.keyPrefix) + "…</code></td><td>" + esc(r.role) + "</td><td>" + (r.revokedAt ? '<span class="err">thu hồi</span>' : '<span class="ok">hoạt động</span>') + "</td>"; var td = el("td"); if (!r.revokedAt) { var b = el("button", { "class": "ghost sm" }, "Thu hồi"); b.onclick = function () { if (confirm("Thu hồi key?")) api("/v1/api-keys/" + r.id, { method: "DELETE" }).then(load); }; td.appendChild(b); } tr.appendChild(td); return tr; })); }).catch(function (e) { listC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; }); }
    load();
  };

  // ---- Trình duyệt của agent (1.7.0): trạng thái Chromium, phiên đang mở, hồ sơ
  // cookie đăng nhập sẵn. Giá trị cookie KHÔNG bao giờ về tới trình duyệt quản trị.
  PAGES.browser = function () {
    var m = page("Trình duyệt", "Agent dùng trình duyệt thật (chạy ngầm trên máy chủ) để xem và thao tác trang web. Hồ sơ = bộ cookie đăng nhập sẵn, lưu mã hóa; gán cho agent ở Agents → Cấu hình.");
    var stC = card(m, "Trạng thái");
    var top = card(m);
    top.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center"><span class="muted">Mỗi hồ sơ giống một trình duyệt đã đăng nhập sẵn (Shopee, Lazada, trang quản trị…). Agent chỉ dùng cookie, không đọc được giá trị.</span><button id="bpNew">＋ Tạo hồ sơ</button></div>';
    var listC = card(m, "Hồ sơ trình duyệt");
    $("#bpNew").onclick = function () { editProfile(null); };

    function fmtExp(sec) {
      if (sec == null || sec === -1) return "phiên";
      var d = new Date(sec * 1000);
      return isNaN(d.getTime()) ? "" : d.toLocaleDateString("vi-VN");
    }
    function closeDlg(dlg) { dlg.close(); dlg.remove(); }
    function niceUrl(u) { try { return decodeURI(u); } catch (e) { return u; } }

    function load() {
      api("/v1/browser").then(function (j) {
        var s = j.status || {};
        var setup = s.setup || {};
        var inst;
        if (s.installed) inst = '<span class="ok">✅ Đã cài Chromium</span>';
        else if (setup.state === "installing") inst = '<span>⏳ Đang tự cài Chromium (vài phút)…</span>';
        else inst = '<span class="err">❌ Chưa cài Chromium</span> <span class="muted">— trên máy chủ chạy <code>sudo penai install-browser</code></span>' +
          (setup.state === "failed" ? '<div class="err" style="margin-top:4px">Lần cài gần nhất lỗi: ' + esc(setup.message || "") + "</div>" : "");
        stC.innerHTML = "<h3>Trạng thái</h3>" +
          '<div class="row" style="gap:18px">' + inst +
          '<span>Phiên đang mở: <b>' + (s.sessions || []).length + "</b> / tối đa " + esc(s.maxSessions) + "</span>" +
          '<span class="muted">Phiên rảnh ' + esc(s.idleMin) + " phút tự đóng và lưu lại cookie</span></div>";
        if ((s.sessions || []).length) {
          stC.appendChild(table(["Agent", "Người dùng", "Trang đang mở", "Rảnh"], s.sessions, function (x) {
            var tr = el("tr");
            tr.innerHTML = "<td>" + esc(x.agent) + "</td><td><code>" + esc(x.user) + "</code></td><td class='muted' style='max-width:420px;word-break:break-all'>" + esc(niceUrl(x.url)) + "</td><td>" + esc(x.idleSec) + " giây</td>";
            return tr;
          }));
          var cb = el("button", { "class": "ghost sm", style: "margin-top:8px" }, "Đóng tất cả phiên");
          cb.onclick = function () { api("/v1/browser/sessions/close", { method: "POST", body: {} }).then(function (r) { toast("Đã đóng " + r.closed + " phiên"); load(); }).catch(function (e) { toast(e.message, 1); }); };
          stC.appendChild(cb);
        }
        listC.innerHTML = "<h3>Hồ sơ trình duyệt</h3>";
        if (!j.profiles.length) {
          listC.innerHTML += '<div class="muted">Chưa có hồ sơ nào. Agent vẫn dùng được trình duyệt (không đăng nhập sẵn). Bấm "＋ Tạo hồ sơ" để thêm cookie cho các trang cần đăng nhập.</div>';
          return;
        }
        listC.appendChild(table(["Hồ sơ", "Cookie theo tên miền", "Agent dùng", ""], j.profiles, function (p) {
          var tr = el("tr");
          var doms = p.domains.length ? p.domains.map(function (d) {
            var warn = d.expired ? ' <span class="err">' + d.expired + " hết hạn</span>" : "";
            var soon = d.soonest ? " · hết hạn sớm nhất " + fmtExp(d.soonest) : "";
            return '<div><span class="pill">' + esc(d.domain) + "</span> " + d.count + " cookie" + warn + '<span class="muted">' + esc(soon) + "</span></div>";
          }).join("") : '<span class="muted">(chưa có cookie)</span>';
          var ags = p.agents.length ? p.agents.map(function (a) { return '<span class="pill">' + esc(a.name) + "</span>"; }).join(" ") : '<span class="muted">chưa gán</span>';
          tr.innerHTML = "<td><b>" + esc(p.name) + "</b>" + (p.description ? '<div class="muted">' + esc(p.description) + "</div>" : "") +
            '<div class="muted">' + (p.autoSave ? "Tự lưu cookie mới" : "Không tự lưu cookie") + (p.cookiesUpdatedAt ? " · cập nhật " + esc(new Date(p.cookiesUpdatedAt).toLocaleString("vi-VN")) : "") + "</div></td>" +
            "<td>" + doms + "</td><td>" + ags + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          var b1 = el("button", { "class": "sm" }, "🍪 Cookie"); b1.onclick = function () { cookieDialog(p); };
          var b2 = el("button", { "class": "ghost sm" }, "Thử truy cập"); b2.onclick = function () { testDialog(p); };
          var b3 = el("button", { "class": "ghost sm" }, "Sửa"); b3.onclick = function () { editProfile(p); };
          var b4 = el("button", { "class": "ghost sm" }, "Xóa");
          b4.onclick = function () {
            if (!confirm('Xóa hồ sơ "' + p.name + '" và toàn bộ cookie của nó?' + (p.agents.length ? " Agent đang dùng sẽ về trình duyệt trống." : ""))) return;
            api("/v1/browser/profiles/" + p.id, { method: "DELETE" }).then(function () { toast("Đã xóa hồ sơ"); load(); }).catch(function (e) { toast(e.message, 1); });
          };
          [b1, b2, b3, b4].forEach(function (b) { td.appendChild(b); td.appendChild(document.createTextNode(" ")); });
          tr.appendChild(td);
          return tr;
        }));
      }).catch(function (e) { stC.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }

    function editProfile(p) {
      var dlg = el("dialog", { style: "width:560px;max-width:95vw;padding:18px" });
      dlg.innerHTML = '<h3 style="margin:0 0 10px">' + (p ? "Sửa hồ sơ" : "Tạo hồ sơ trình duyệt") + "</h3>" +
        '<label>Tên hồ sơ</label><input id="bpName" style="width:100%" placeholder="vd Shopee người bán – shop A">' +
        '<label>Ghi chú</label><input id="bpDesc" style="width:100%" placeholder="Tài khoản nào, dùng cho việc gì">' +
        '<label>User-Agent <span class="muted">(bỏ trống = Chrome mặc định; muốn giống hệt máy lấy cookie thì dán User-Agent của máy đó)</span></label><input id="bpUa" style="width:100%" placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) …">' +
        '<div class="row"><div style="flex:1"><label>Ngôn ngữ</label><input id="bpLoc" style="width:100%" placeholder="vi-VN"></div><div style="flex:1"><label>Múi giờ</label><input id="bpTz" style="width:100%" placeholder="Asia/Ho_Chi_Minh"></div></div>' +
        '<label style="display:flex;align-items:center;gap:7px;margin-top:10px"><input id="bpAuto" type="checkbox" style="flex:0"> Tự lưu cookie mới khi đóng phiên <span class="muted">— trang web hay tự làm mới cookie, bật để giữ đăng nhập lâu hơn</span></label>' +
        '<div class="dialog-actions"><span id="bpMsg" class="muted" style="margin-right:auto"></span><button class="ghost" id="bpCancel">Hủy</button><button id="bpSave">Lưu</button></div>';
      document.body.appendChild(dlg); dlg.showModal();
      $("#bpName", dlg).value = p ? p.name : "";
      $("#bpDesc", dlg).value = p ? p.description : "";
      $("#bpUa", dlg).value = p ? p.userAgent : "";
      $("#bpLoc", dlg).value = p ? p.locale : "vi-VN";
      $("#bpTz", dlg).value = p ? p.timezone : "Asia/Ho_Chi_Minh";
      $("#bpAuto", dlg).checked = p ? p.autoSave : true;
      $("#bpCancel", dlg).onclick = function () { closeDlg(dlg); };
      $("#bpSave", dlg).onclick = function () {
        var body = {
          name: $("#bpName", dlg).value.trim(),
          description: $("#bpDesc", dlg).value.trim(),
          userAgent: $("#bpUa", dlg).value.trim(),
          locale: $("#bpLoc", dlg).value.trim() || "vi-VN",
          timezone: $("#bpTz", dlg).value.trim() || "Asia/Ho_Chi_Minh",
          autoSave: $("#bpAuto", dlg).checked
        };
        var req = p ? api("/v1/browser/profiles/" + p.id, { method: "PATCH", body: body }) : api("/v1/browser/profiles", { method: "POST", body: body });
        req.then(function (r) {
          closeDlg(dlg); load();
          toast(p ? "Đã lưu hồ sơ" : "Đã tạo hồ sơ — thêm cookie ngay");
          if (!p && r.profile) cookieDialog({ id: r.profile.id, name: r.profile.name });
        }).catch(function (e) { $("#bpMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
    }

    function cookieDialog(p) {
      var dlg = el("dialog", { style: "width:860px;max-width:96vw;padding:18px" });
      dlg.innerHTML = '<h3 style="margin:0 0 6px">🍪 Cookie — ' + esc(p.name) + "</h3>" +
        '<details style="margin-bottom:8px"><summary class="muted" style="cursor:pointer">Cách lấy cookie (bấm để xem)</summary><ol class="muted" style="margin:6px 0 0;padding-left:18px;line-height:1.6">' +
        "<li>Trên Chrome máy tính, cài tiện ích <b>Cookie-Editor</b> (hoặc EditThisCookie).</li>" +
        "<li>Mở trang cần dùng (vd shopee.vn) và <b>đăng nhập</b> như bình thường — nên dùng một cửa sổ riêng cho việc này.</li>" +
        "<li>Bấm biểu tượng Cookie-Editor → <b>Export</b> → <b>JSON</b> (đã chép vào bộ nhớ tạm) → dán vào ô dưới đây, hoặc chọn file .json/.txt.</li>" +
        "<li>Dùng xong trên máy mình thì <b>đừng bấm Đăng xuất</b> ở cửa sổ đó — đăng xuất làm cookie trên máy chủ mất hiệu lực. Khi agent báo bị đăng xuất/bị chặn: lấy cookie mới và nhập lại.</li>" +
        "</ol><div class='muted' style='margin-top:6px'>Cũng nhận file cookies.txt (định dạng Netscape) hoặc chuỗi <code>ten=gia-tri; ten2=gia-tri2</code> chép từ DevTools (khi đó nhập thêm Tên miền).</div></details>" +
        '<textarea id="ckIn" rows="6" style="width:100%;font-family:monospace;font-size:.8rem" placeholder="Dán JSON cookie ở đây…"></textarea>' +
        '<div class="row" style="margin-top:6px"><input type="file" id="ckFile" accept=".json,.txt" style="flex:0 1 240px">' +
        '<input id="ckDom" placeholder="Tên miền (chỉ cần với chuỗi ten=gia-tri), vd shopee.vn" style="flex:1">' +
        '<select id="ckMode" style="flex:0 0 auto"><option value="merge">Gộp với cookie hiện có</option><option value="replace">Thay toàn bộ</option></select>' +
        '<button id="ckImport">Nhập cookie</button></div><div id="ckMsg" class="muted" style="margin-top:6px"></div>' +
        '<h3 style="margin:16px 0 6px">Cookie đang lưu <span class="muted">(chỉ hiện tên, tên miền, hạn — không hiện giá trị)</span></h3>' +
        '<div id="ckList" style="max-height:320px;overflow:auto"><span class="muted">Đang tải…</span></div>' +
        '<div class="row" style="margin-top:8px"><button class="ghost sm" id="ckDelSel">Xóa mục đã chọn</button><select id="ckDomSel" style="flex:0 1 220px"></select><button class="ghost sm" id="ckDelDom">Xóa cả tên miền</button><button class="ghost sm" id="ckDelAll">Xóa hết</button>' +
        '<span style="flex:1"></span><button class="ghost" id="ckClose">Đóng</button></div>';
      document.body.appendChild(dlg); dlg.showModal();
      var rows = [];
      function list() {
        api("/v1/browser/profiles/" + p.id + "/cookies").then(function (j) {
          rows = j.cookies;
          var box = $("#ckList", dlg); box.innerHTML = "";
          var now = Date.now() / 1000;
          box.appendChild(table(["", "Tên", "Tên miền", "Đường dẫn", "Hết hạn", "Cờ", "Độ dài"], rows, function (c, i) {
            var tr = el("tr");
            var exp = c.expires !== -1 && c.expires <= now ? '<span class="err">đã hết hạn</span>' : esc(fmtExp(c.expires));
            tr.innerHTML = '<td><input type="checkbox" class="ckSel"></td><td><code>' + esc(c.name) + "</code></td><td>" + esc(c.domain) + "</td><td>" + esc(c.path) + "</td><td>" + exp + "</td><td class='muted'>" + (c.httpOnly ? "httpOnly " : "") + (c.secure ? "secure" : "") + "</td><td class='muted'>" + esc(c.valueLength) + "</td>";
            return tr;
          }));
          var doms = {};
          rows.forEach(function (c) { doms[c.domain.replace(/^[.]/, "")] = 1; });
          $("#ckDomSel", dlg).innerHTML = Object.keys(doms).map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + "</option>"; }).join("") || "<option value=''>(trống)</option>";
        }).catch(function (e) { $("#ckList", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      }
      function del(body, what) {
        if (!confirm("Xóa " + what + "? Các phiên trình duyệt đang mở bằng hồ sơ này sẽ được mở lại.")) return;
        api("/v1/browser/profiles/" + p.id + "/cookies/delete", { method: "POST", body: body })
          .then(function (r) { toast("Đã xóa " + r.removed + " cookie"); list(); load(); })
          .catch(function (e) { toast(e.message, 1); });
      }
      $("#ckFile", dlg).onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { $("#ckIn", dlg).value = String(rd.result || ""); };
        rd.readAsText(f);
      };
      $("#ckImport", dlg).onclick = function () {
        var content = $("#ckIn", dlg).value;
        if (!content.trim()) { $("#ckMsg", dlg).innerHTML = '<span class="err">Chưa dán nội dung cookie</span>'; return; }
        var mode = $("#ckMode", dlg).value;
        if (mode === "replace" && !confirm("Thay TOÀN BỘ cookie hiện có của hồ sơ bằng nội dung vừa dán?")) return;
        var body = { content: content, mode: mode };
        var d = $("#ckDom", dlg).value.trim(); if (d) body.domain = d;
        $("#ckMsg", dlg).textContent = "Đang nhập…";
        api("/v1/browser/profiles/" + p.id + "/cookies", { method: "POST", body: body }).then(function (r) {
          $("#ckIn", dlg).value = "";
          $("#ckMsg", dlg).innerHTML = '<span class="ok">Đã nhập ' + r.imported + " cookie (" + esc(r.domains.join(", ")) + ") — hồ sơ có " + r.total + " cookie.</span>" +
            (r.expiredSkipped ? ' <span class="err">' + r.expiredSkipped + " cookie đã hết hạn bị bỏ qua.</span>" : "") +
            (r.closedSessions ? ' <span class="muted">Đã đóng ' + r.closedSessions + " phiên dùng cookie cũ.</span>" : "");
          list(); load();
        }).catch(function (e) { $("#ckMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      $("#ckDelSel", dlg).onclick = function () {
        var items = [];
        dlg.querySelectorAll(".ckSel").forEach(function (cb, i) { if (cb.checked && rows[i]) items.push({ name: rows[i].name, domain: rows[i].domain, path: rows[i].path }); });
        if (!items.length) { toast("Chưa chọn cookie nào", 1); return; }
        del({ items: items }, items.length + " cookie đã chọn");
      };
      $("#ckDelDom", dlg).onclick = function () { var d = $("#ckDomSel", dlg).value; if (d) del({ domain: d }, "mọi cookie của " + d); };
      $("#ckDelAll", dlg).onclick = function () { del({ all: true }, "TẤT CẢ cookie của hồ sơ"); };
      $("#ckClose", dlg).onclick = function () { closeDlg(dlg); };
      list();
    }

    function testDialog(p) {
      var dlg = el("dialog", { style: "width:900px;max-width:96vw;padding:18px" });
      var first = p.domains && p.domains.length ? "https://" + p.domains[0].domain + "/" : "https://";
      dlg.innerHTML = '<h3 style="margin:0 0 10px">Thử truy cập — ' + esc(p.name) + "</h3>" +
        '<div class="row"><input id="tsUrl" style="flex:1"><button id="tsGo">Mở trang</button><button class="ghost" id="tsClose">Đóng</button></div>' +
        '<div class="muted" style="margin-top:6px">Mở trang bằng cookie của hồ sơ trên máy chủ rồi chụp màn hình — xem đã đăng nhập chưa, có bị chặn/bắt xác minh không. Phiên thử đóng ngay, không lưu cookie.</div>' +
        '<div id="tsOut" style="margin-top:10px"></div>';
      document.body.appendChild(dlg); dlg.showModal();
      $("#tsUrl", dlg).value = first;
      $("#tsClose", dlg).onclick = function () { closeDlg(dlg); };
      $("#tsGo", dlg).onclick = function () {
        var out = $("#tsOut", dlg);
        out.innerHTML = '<span class="muted">Đang mở trang (5–30 giây)…</span>';
        $("#tsGo", dlg).disabled = true;
        api("/v1/browser/profiles/" + p.id + "/test", { method: "POST", body: { url: $("#tsUrl", dlg).value.trim() } }).then(function (r) {
          out.innerHTML = "<div><b>" + esc(r.title || "(không tiêu đề)") + '</b></div><div class="muted" style="word-break:break-all">' + esc(r.url) + "</div>" +
            (r.notes || []).map(function (n) { return '<div class="err" style="margin-top:4px">' + esc(n) + "</div>"; }).join("") +
            (r.image ? '<img src="' + r.image + '" style="width:100%;margin-top:8px;border:1px solid var(--border);border-radius:8px">' : "");
        }).catch(function (e) { out.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; })
          .then(function () { $("#tsGo", dlg).disabled = false; });
      };
    }

    load();
  };

  var ROLE_LABELS = { ws_admin: "Quản trị", operator: "Vận hành", viewer: "Chỉ xem", member: "Thành viên (chỉ chat)" };
  var ROLE_HELP = {
    ws_admin: "Toàn quyền: cấu hình, tạo người dùng, khóa API.",
    operator: "Vận hành: chat mọi agent, kênh, cron, kho tri thức. Không tạo người dùng.",
    viewer: "Chỉ xem dữ liệu, không chat.",
    member: "Chỉ thấy trang Chat và chỉ chat với các agent được gán bên dưới."
  };
  PAGES.users = function () {
    var m = page("Người dùng", "Tài khoản đăng nhập Dashboard và quyền truy cập agent (chỉ Quản trị)");
    var top = el("div", { "class": "row", style: "margin-bottom:12px" });
    var addB = el("button", null, "＋ Thêm người dùng"); top.appendChild(addB);
    m.appendChild(top);
    var c = card(m);
    var DATA = { users: [], agents: [], zaloChannels: [] };
    function zaloName(id) { var z = DATA.zaloChannels || []; for (var i = 0; i < z.length; i++) if (z[i].id === id) return z[i].name; return id.slice(0, 6); }
    function agentName(id) { for (var i = 0; i < DATA.agents.length; i++) if (DATA.agents[i].id === id) return DATA.agents[i].name; return id.slice(0, 6); }
    function load() {
      api("/v1/users").then(function (j) {
        DATA = j;
        c.innerHTML = "";
        c.appendChild(table(["Tên", "Email", "Vai trò", "Agent được chat", "Đăng nhập gần nhất", "Trạng thái", ""], j.users, function (u) {
          var tr = el("tr");
          var agentsTxt = u.role === "member" ? (u.agentIds.length ? u.agentIds.map(function (id) { return '<span class="pill">' + esc(agentName(id)) + "</span>"; }).join(" ") : '<span class="err">chưa gán</span>') : '<span class="muted">tất cả</span>';
          if (u.role === "member" && (u.zaloChannelIds || []).length) agentsTxt += '<div style="margin-top:3px">' + u.zaloChannelIds.map(function (id) { return '<span class="pill">📥 ' + esc(zaloName(id)) + "</span>"; }).join(" ") + "</div>";
          var me = state.me && state.me.user && state.me.user.id === u.id;
          tr.innerHTML = "<td>" + esc(u.name) + (me ? ' <span class="pill">bạn</span>' : "") + "</td><td>" + esc(u.email) + "</td><td><span class='role-pill'>" + esc(ROLE_LABELS[u.role] || u.role) + "</span></td><td>" + agentsTxt + "</td><td class='muted'>" + esc(u.lastLoginAt ? String(u.lastLoginAt).slice(0, 16).replace("T", " ") : "chưa") + "</td><td>" + (u.isActive ? '<span class="ok">hoạt động</span>' : '<span class="err">đã khóa</span>') + (u.mustChangePassword ? ' <span class="pill">phải đổi MK</span>' : "") + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          var ed = el("button", { "class": "ghost sm" }, "Sửa"); ed.onclick = function () { openForm(u); }; td.appendChild(ed);
          var pw = el("button", { "class": "ghost sm", style: "margin-left:4px" }, "Đặt lại MK"); pw.onclick = function () { openReset(u); }; td.appendChild(pw);
          if (!me) {
            var lk = el("button", { "class": "ghost sm", style: "margin-left:4px" }, u.isActive ? "Khóa" : "Mở khóa");
            lk.onclick = function () { api("/v1/users/" + u.id, { method: "PATCH", body: { isActive: !u.isActive } }).then(function () { toast(u.isActive ? "Đã khóa tài khoản" : "Đã mở khóa"); load(); }).catch(function (e) { toast(e.message, true); }); };
            td.appendChild(lk);
            var rm = el("button", { "class": "ghost sm", style: "margin-left:4px" }, "Gỡ"); rm.onclick = function () { if (confirm("Gỡ " + u.email + " khỏi workspace?")) api("/v1/users/" + u.id, { method: "DELETE" }).then(function () { toast("Đã gỡ"); load(); }).catch(function (e) { toast(e.message, true); }); }; td.appendChild(rm);
          }
          tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { c.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    function agentChecks(selected) {
      var box = el("div", { "class": "agent-checks", id: "uAgents" });
      if (!DATA.agents.length) { box.innerHTML = '<span class="muted">Chưa có agent nào trong workspace.</span>'; return box; }
      DATA.agents.forEach(function (a) {
        var lb = el("label"); var cb = el("input", { type: "checkbox", value: a.id }); if (selected.indexOf(a.id) >= 0) cb.checked = true;
        lb.appendChild(cb); lb.appendChild(document.createTextNode(a.name)); box.appendChild(lb);
      });
      return box;
    }
    function openForm(u) {
      var isEdit = !!u;
      var dlg = el("dialog", { style: "width:560px;padding:20px" });
      dlg.innerHTML = "<h3 style='margin:0 0 6px'>" + (isEdit ? "Sửa người dùng" : "Thêm người dùng") + "</h3>" +
        '<label>Họ tên</label><input id="uName" style="width:100%" placeholder="Nguyễn Văn A">' +
        '<label>Email (dùng để đăng nhập)</label><input id="uEmail" type="email" style="width:100%" placeholder="a@congty.vn" autocomplete="off"' + (isEdit ? " disabled" : "") + ">" +
        (isEdit ? "" : '<label>Mật khẩu ban đầu (≥ 8 ký tự)</label>' + pwField("uPass") + '<label style="display:flex;align-items:center;gap:6px;margin-top:8px"><input id="uMust" type="checkbox" style="width:auto" checked> Bắt đổi mật khẩu ở lần đăng nhập đầu</label>') +
        '<label>Vai trò</label><select id="uRole" style="width:100%">' + Object.keys(ROLE_LABELS).map(function (r) { return '<option value="' + r + '">' + esc(ROLE_LABELS[r]) + "</option>"; }).join("") + "</select>" +
        '<div id="uRoleHelp" class="muted" style="margin-top:4px"></div>' +
        '<div id="uAgentWrap"><label>Agent được phép chat</label></div>' +
        '<div id="uZaloWrap"><label>Kênh được trực (Inbox Zalo / WhatsApp — cũng là kênh tài khoản này dùng được qua MCP)</label></div>' +
        '<div class="dialog-actions"><button class="ghost" id="uCancel">Hủy</button><button id="uSave">' + (isEdit ? "Lưu" : "Tạo tài khoản") + "</button></div>" +
        '<div id="uMsg" style="margin-top:8px"></div>';
      document.body.appendChild(dlg);
      bindPwToggles(dlg);
      $("#uAgentWrap", dlg).appendChild(agentChecks(isEdit ? u.agentIds : []));
      var zbox = el("div", { "class": "agent-checks", id: "uZalo" });
      if (!(DATA.zaloChannels || []).length) zbox.innerHTML = '<span class="muted">Chưa có kênh Zalo cá nhân / WhatsApp cá nhân nào.</span>';
      (DATA.zaloChannels || []).forEach(function (z) {
        var lb = el("label"); var cb = el("input", { type: "checkbox", value: z.id }); if (isEdit && (u.zaloChannelIds || []).indexOf(z.id) >= 0) cb.checked = true;
        lb.appendChild(cb); lb.appendChild(document.createTextNode(z.name + (z.kind === "whatsapp_personal" ? " (WhatsApp)" : ""))); zbox.appendChild(lb);
      });
      $("#uZaloWrap", dlg).appendChild(zbox);
      if (isEdit) { $("#uName", dlg).value = u.name; $("#uEmail", dlg).value = u.email; $("#uRole", dlg).value = u.role; }
      else { $("#uRole", dlg).value = "member"; }
      function syncRole() { var r = $("#uRole", dlg).value; $("#uRoleHelp", dlg).textContent = ROLE_HELP[r] || ""; $("#uAgentWrap", dlg).style.display = r === "member" ? "block" : "none"; $("#uZaloWrap", dlg).style.display = r === "member" ? "block" : "none"; }
      $("#uRole", dlg).onchange = syncRole; syncRole();
      $("#uCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#uSave", dlg).onclick = function () {
        var body = { name: $("#uName", dlg).value.trim(), role: $("#uRole", dlg).value };
        body.agentIds = Array.prototype.map.call(dlg.querySelectorAll("#uAgents input:checked"), function (x) { return x.value; });
        body.zaloChannelIds = Array.prototype.map.call(dlg.querySelectorAll("#uZalo input:checked"), function (x) { return x.value; });
        var req;
        if (isEdit) req = api("/v1/users/" + u.id, { method: "PATCH", body: body });
        else {
          body.email = $("#uEmail", dlg).value.trim(); body.password = $("#uPass", dlg).value; body.mustChangePassword = $("#uMust", dlg).checked;
          if (!body.email) { $("#uMsg", dlg).innerHTML = '<span class="err">Nhập email</span>'; return; }
          if (body.password.length < 8) { $("#uMsg", dlg).innerHTML = '<span class="err">Mật khẩu tối thiểu 8 ký tự</span>'; return; }
          req = api("/v1/users", { method: "POST", body: body });
        }
        $("#uSave", dlg).disabled = true;
        req.then(function () { dlg.close(); dlg.remove(); toast(isEdit ? "Đã lưu" : "Đã tạo tài khoản"); load(); })
          .catch(function (e) { $("#uSave", dlg).disabled = false; $("#uMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      dlg.showModal();
    }
    function openReset(u) {
      var dlg = el("dialog", { style: "width:440px;padding:20px" });
      dlg.innerHTML = "<h3 style='margin:0 0 6px'>Đặt lại mật khẩu — " + esc(u.email) + "</h3>" +
        '<label>Mật khẩu mới (≥ 8 ký tự)</label>' + pwField("rPass") +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:8px"><input id="rMust" type="checkbox" style="width:auto" checked> Bắt đổi mật khẩu ở lần đăng nhập kế</label>' +
        '<div class="muted" style="margin-top:6px">Mọi phiên đăng nhập hiện tại của người này sẽ bị thu hồi.</div>' +
        '<div class="dialog-actions"><button class="ghost" id="rCancel">Hủy</button><button id="rSave">Đặt lại</button></div><div id="rMsg" style="margin-top:8px"></div>';
      document.body.appendChild(dlg);
      bindPwToggles(dlg);
      $("#rCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#rSave", dlg).onclick = function () {
        var pw = $("#rPass", dlg).value; if (pw.length < 8) { $("#rMsg", dlg).innerHTML = '<span class="err">Mật khẩu tối thiểu 8 ký tự</span>'; return; }
        api("/v1/users/" + u.id + "/password", { method: "POST", body: { password: pw, mustChange: $("#rMust", dlg).checked } })
          .then(function () { dlg.close(); dlg.remove(); toast("Đã đặt lại mật khẩu"); load(); })
          .catch(function (e) { $("#rMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      dlg.showModal();
    }
    addB.onclick = function () { openForm(null); };
    load();
  };

  PAGES.sessions = function () {
    var m = page("Sessions", "Các phiên hội thoại");
    var c = card(m);
    function load() { api("/v1/sessions").then(function (j) { c.innerHTML = ""; c.appendChild(table(["ID", "Tiêu đề", "Cập nhật", ""], j.sessions, function (r) { var tr = el("tr"); tr.innerHTML = "<td><code>" + esc(r.id.slice(0, 8)) + "</code></td><td>" + esc(r.title || "(không tên)") + "</td><td class='muted'>" + esc((r.updatedAt || "").slice(0, 16)) + "</td>"; var td = el("td"); var del = el("button", { "class": "ghost sm" }, "Xóa"); del.onclick = function () { if (confirm("Xóa session + lịch sử?")) api("/v1/sessions/" + r.id, { method: "DELETE" }).then(load); }; td.appendChild(del); tr.appendChild(td); return tr; })); }); }
    load();
  };

  PAGES.audit = function () {
    var m = page("Audit log", "Nhật ký hành động quản trị");
    var c = card(m);
    api("/v1/audit").then(function (j) { c.appendChild(table(["Thời gian", "Actor", "Hành động", "Chi tiết"], j.entries, function (r) { var tr = el("tr"); tr.innerHTML = "<td class='muted'>" + esc((r.createdAt || "").slice(0, 19).replace("T", " ")) + "</td><td><code>" + esc(String(r.actor).slice(0, 8)) + "</code></td><td>" + esc(r.action) + "</td><td class='muted'>" + esc(JSON.stringify(r.detail)) + "</td>"; return tr; })); }).catch(function (e) { c.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
  };

  // ===== Contacts: hồ sơ, nhãn và chỉ dẫn cho AI theo từng người (0029) =====
  var CH_LABELS = { telegram: "Telegram", zalo_personal: "Zalo cá nhân", whatsapp_personal: "WhatsApp cá nhân", zalo: "Zalo OA", zalo_oa: "Zalo OA", msteams: "Microsoft Teams", discord: "Discord", slack: "Slack", whatsapp: "WhatsApp", feishu: "Feishu/Lark", web: "Web" };
  var PAIR_LABELS = { da_duyet: ["Đã duyệt", "ok"], cho_duyet: ["Chờ duyệt", ""], chua_duyet: ["Chưa duyệt", "err"], khong_can: ["Không cần duyệt", ""], khong_ro: ["—", ""] };
  function chLabel(k) { return CH_LABELS[k] || k; }
  function fmtTime(s) { if (!s) return ""; var d = new Date(s); return isNaN(d.getTime()) ? "" : d.toLocaleString("vi-VN"); }
  function tagPill(t) { return '<span class="pill tagpill"><i style="background:' + esc(t.color || "#94a3b8") + '"></i>' + esc(t.name) + "</span>"; }
  function contactName(c) { return c.profileName || c.displayName || c.externalId; }
  function eachEl(root, sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); }
  function charCounter(input, out, max) {
    var upd = function () { out.textContent = input.value.length + " / " + max + " ký tự"; };
    input.addEventListener("input", upd); upd();
  }

  PAGES.contacts = function () {
    var m = page("Contacts", "Người nhắn tới các kênh chat — bấm vào một người để xem hồ sơ, nhãn và đặt chỉ dẫn riêng cho AI");
    var c = card(m);
    c.innerHTML =
      '<div class="row">' +
      '<input id="ctQ" placeholder="🔍 Tìm theo tên, UID/ID hoặc SĐT">' +
      '<select id="ctCh"><option value="">Mọi kênh</option></select>' +
      '<select id="ctTag"><option value="">Mọi nhãn</option></select>' +
      (isAdmin() ? '<button id="ctTags" class="ghost">🏷️ Quản lý nhãn</button>' : "") +
      (state.me && (state.me.role === "ws_admin" || state.me.role === "operator") ? '<button id="ctExport" class="ghost" title="Tải file Excel toàn bộ thông tin contact của kênh đang chọn (kênh Zalo cá nhân kèm danh bạ Zalo đầy đủ)">⬇ Xuất Excel</button>' : "") +
      "</div>" +
      '<div id="ctList" style="margin-top:12px"><span class="muted">Đang tải…</span></div>';
    var all = [];
    function render() {
      var box = $("#ctList"); if (!box) return;
      var q = $("#ctQ").value.trim().toLowerCase(), ch = $("#ctCh").value, tg = $("#ctTag").value;
      var rows = all.filter(function (r) {
        if (ch && r.channelId !== ch) return false;
        if (tg && !r.tags.some(function (t) { return t.id === tg; })) return false;
        if (!q) return true;
        return [r.profileName, r.displayName, r.externalId, r.zaloPhone].some(function (v) { return !!v && String(v).toLowerCase().indexOf(q) >= 0; });
      });
      box.innerHTML = "";
      box.appendChild(table(["Tên", "Kênh", "Loại", "UID / ID", "Duyệt", "Nhắn gần nhất"], rows, function (r) {
        var tr = el("tr", { "class": "ct-row", title: "Bấm để mở hồ sơ" });
        var p = PAIR_LABELS[r.pairing] || [r.pairing, ""];
        tr.innerHTML =
          "<td><b>" + esc(contactName(r)) + "</b>" +
          (r.hasInstructions ? ' <span title="Có chỉ dẫn riêng cho AI">📝</span>' : "") +
          (r.profileName && r.displayName && r.profileName !== r.displayName ? "<div class='muted'>" + esc(r.displayName) + "</div>" : "") +
          (r.tags.length ? "<div style='margin-top:3px'>" + r.tags.map(tagPill).join(" ") + "</div>" : "") + "</td>" +
          "<td>" + esc(r.channelName || chLabel(r.channelKind)) + "<div class='muted'>" + esc(chLabel(r.channelKind)) + "</div></td>" +
          "<td>" + (r.peerKind === "group" ? "👥 Nhóm" : r.peerKind === "direct" ? "👤 Cá nhân" : '<span class="muted">—</span>') + "</td>" +
          "<td><code>" + esc(r.externalId) + '</code> <button type="button" class="ghost sm ct-copy" title="Sao chép UID/ID để gửi tin lại">📋</button>' +
          (r.zaloPhone ? "<div class='muted'>" + esc(r.zaloPhone) + "</div>" : "") + "</td>" +
          "<td>" + (r.peerKind === "group" ? '<span class="muted">—</span>' : "<span class='pill " + p[1] + "'>" + esc(p[0]) + "</span>") + "</td>" +
          "<td class='muted'>" + esc(fmtTime(r.lastSeen)) + "</td>";
        tr.onclick = function () { openContact(r.id, load); };
        var cp = tr.querySelector(".ct-copy");
        if (cp) cp.onclick = function (e) {
          e.stopPropagation();
          try { navigator.clipboard.writeText(r.externalId).then(function () { toast("Đã sao chép " + r.externalId); }); } catch (x) { toast(r.externalId); }
        };
        return tr;
      }));
      box.appendChild(el("div", { "class": "muted", style: "margin-top:8px" }, rows.length + " / " + all.length + " người"));
    }
    function load() {
      Promise.all([api("/v1/contacts"), api("/v1/contact-tags"), api("/v1/channels").then(function (j) { return j.channels || []; }).catch(function () { return []; })]).then(function (res) {
        if (!$("#ctList")) return;
        all = res[0].contacts || [];
        var tags = res[1].tags || [];
        var chans = {};
        (res[2] || []).forEach(function (c) { chans[c.id] = { name: c.name, kind: c.kind }; });
        all.forEach(function (r) { if (r.channelId && !chans[r.channelId]) chans[r.channelId] = { name: r.channelName || r.channelId, kind: r.channelKind }; });
        var chSel = $("#ctCh"), curC = chSel.value;
        chSel.innerHTML = '<option value="">Mọi kênh</option>' + Object.keys(chans).map(function (id) {
          var c = chans[id];
          return '<option value="' + esc(id) + '"' + (id === curC ? " selected" : "") + ">" + esc(c.name + " (" + chLabel(c.kind) + ")") + "</option>";
        }).join("");
        var tgSel = $("#ctTag"), curT = tgSel.value;
        tgSel.innerHTML = '<option value="">Mọi nhãn</option>' + tags.map(function (t) {
          return '<option value="' + esc(t.id) + '"' + (t.id === curT ? " selected" : "") + ">" + esc(t.name) + " (" + t.memberCount + ")</option>";
        }).join("");
        render();
      }).catch(function (e) { var b = $("#ctList"); if (b) b.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    $("#ctQ").addEventListener("input", render);
    $("#ctCh").onchange = render;
    $("#ctTag").onchange = render;
    if ($("#ctTags")) $("#ctTags").onclick = function () { openTagManager(load); };
    if ($("#ctExport")) $("#ctExport").onclick = function () {
      var ch = $("#ctCh").value;
      toast("Đang tạo file Excel…");
      window.location.href = "/v1/contacts/export.xlsx" + (ch ? "?channelId=" + encodeURIComponent(ch) : "");
    };
    load();
  };

  // Hộp thoại tự gỡ khỏi trang ngay khi đóng (✕ hoặc Esc) — không dựa vào sự kiện
  // "close" (có trình duyệt nhúng không phát sự kiện này, hộp cũ nằm lại trong trang).
  function modal(cls, onClose) {
    eachEl(document, "dialog." + cls, function (x) { if (x.open) x.close(); x.remove(); });
    var dlg = el("dialog", { "class": cls });
    var closed = false;
    dlg.closeNow = function () {
      if (closed) return;
      closed = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      if (onClose) onClose();
    };
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); dlg.closeNow(); });
    document.body.appendChild(dlg);
    return dlg;
  }

  function openContact(id, onChange) {
    var dlg = modal("ct-dialog");
    dlg.innerHTML = '<span class="muted">Đang tải hồ sơ…</span>';
    dlg.showModal();
    Promise.all([api("/v1/contacts/" + id), api("/v1/contact-tags"), api("/v1/agents")]).then(function (res) {
      renderContact(dlg, res[0], res[1].tags || [], res[2].agents || [], onChange);
    }).catch(function (e) {
      dlg.innerHTML = '<p class="err">' + esc(e.message) + '</p><div class="dialog-actions"><button class="ghost" data-x="1">Đóng</button></div>';
      $("[data-x]", dlg).onclick = dlg.closeNow;
    });
  }

  function renderContact(dlg, d, allTags, agents, onChange) {
    var c = d.contact;
    var p = PAIR_LABELS[c.pairing] || [c.pairing, ""];
    var TABS = [["ho-so", "Hồ sơ & chỉ dẫn"], ["ghi-nho", "AI ghi nhớ"], ["hoi-thoai", "Hội thoại & file"], ["quyen", "Quyền & tài liệu"], ["ngu-canh", "Xem ngữ cảnh AI"]];
    dlg.innerHTML =
      '<div class="ct-head"><div><h3 style="margin:0" id="ctTitle">' + esc(contactName(c)) + "</h3>" +
      '<div class="muted" style="margin-top:3px">' + esc(chLabel(c.channelKind)) + (d.channel ? " · " + esc(d.channel.name) : "") +
      " · <code>" + esc(c.externalId) + "</code> · <span class='pill " + p[1] + "'>" + esc(p[0]) + "</span>" +
      (d.channel && d.channel.agentName ? " · agent " + esc(d.channel.agentName) : "") +
      " · nhắn lần đầu " + esc(fmtTime(c.firstSeen)) + "</div></div>" +
      '<button class="ghost sm" data-x="1" title="Đóng">✕</button></div>' +
      '<div class="ct-tabs">' + TABS.map(function (t, i) {
        return '<button type="button" data-tab="' + t[0] + '"' + (i === 0 ? ' class="on"' : "") + ">" + esc(t[1]) + "</button>";
      }).join("") + "</div>" +
      TABS.map(function (t, i) { return '<div data-pane="' + t[0] + '"' + (i === 0 ? "" : ' style="display:none"') + "></div>"; }).join("");
    $("[data-x]", dlg).onclick = dlg.closeNow;
    eachEl(dlg, "[data-tab]", function (b) {
      b.onclick = function () {
        var k = b.getAttribute("data-tab");
        eachEl(dlg, "[data-tab]", function (x) { x.className = x === b ? "on" : ""; });
        eachEl(dlg, "[data-pane]", function (pn) { pn.style.display = pn.getAttribute("data-pane") === k ? "" : "none"; });
      };
    });
    var pane = function (k) { return dlg.querySelector('[data-pane="' + k + '"]'); };
    renderProfilePane(pane("ho-so"), d, allTags, onChange);
    renderMemoryPane(pane("ghi-nho"), d);
    renderChatsPane(pane("hoi-thoai"), d);
    renderAccessPane(pane("quyen"), d);
    renderPreviewPane(pane("ngu-canh"), d, agents);
  }

  function renderProfilePane(box, d, allTags, onChange) {
    var c = d.contact, pf = d.profile || {}, L = d.limits || {};
    var mine = {};
    (d.tags || []).forEach(function (t) { mine[t.id] = 1; });
    var input = function (id, label, val, max, ph) {
      return '<div><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" style="width:100%" maxlength="' + (max || 200) +
        '" value="' + esc(val || "") + '" placeholder="' + esc(ph || "") + '"></div>';
    };
    box.innerHTML =
      '<div class="ct-help">Hồ sơ và chỉ dẫn được đưa vào ngữ cảnh mỗi khi người này nhắn (mọi agent trong workspace). Trong nhóm chat chỉ đưa tên và cách xưng hô, trừ khi bật "Dùng cả trong nhóm chat".</div>' +
      '<div class="ct-grid">' +
      input("pfName", "Tên hiển thị (quản trị viên đặt)", pf.displayName, L.displayName, c.displayName || "") +
      input("pfRole", "Vai trò / chức danh / công ty", pf.roleTitle, L.roleTitle, "vd Giám đốc Công ty ABC") +
      input("pfAddr", "AI gọi người này là", pf.addressAs, L.addressAs, "vd anh Đức, chị Lan") +
      input("pfSelf", "AI tự xưng là", pf.selfAddress, L.selfAddress, "vd em") +
      input("pfLang", "Ngôn ngữ trả lời", pf.language, L.language, "để trống = theo người dùng") +
      input("pfPhone", "Điện thoại", pf.phone, L.phone, "") +
      input("pfEmail", "Email", pf.email, L.email, "") +
      "</div>" +
      '<label class="ct-check"><input type="checkbox" id="pfShare"' + (pf.shareContactInfo ? " checked" : "") + "> Cho AI biết điện thoại và email</label>" +
      '<label>Trường tùy chỉnh (AI thấy được)</label><div id="pfFields"></div>' +
      '<button type="button" class="ghost sm" id="pfAddField">＋ Thêm trường</button>' +
      '<label style="margin-top:14px">Nhãn</label><div id="pfTags"></div>' +
      '<label for="pfAi" style="margin-top:12px">Chỉ dẫn cho AI khi trả lời người này</label>' +
      '<textarea id="pfAi" class="memory-textarea" style="min-height:130px" maxlength="' + (L.personInstructions || 2000) +
      '" placeholder="vd Khách VIP — trả lời ngắn gọn, báo giá theo bảng đại lý cấp 1, không bàn công nợ (chuyển kế toán)."></textarea>' +
      '<div class="ct-count" id="pfAiCount"></div>' +
      '<label class="ct-check"><input type="checkbox" id="pfGroups"' + (pf.useInGroups ? " checked" : "") + "> Dùng cả trong nhóm chat (hồ sơ đầy đủ + chỉ dẫn riêng)</label>" +
      '<div class="dialog-actions"><span class="muted" id="pfInfo" style="margin-right:auto"></span><button id="pfSave">Lưu hồ sơ</button></div>';
    var fbox = $("#pfFields", box);
    function addField(k, v) {
      var row = el("div", { "class": "cf-row" });
      row.innerHTML = '<input class="cfk" placeholder="Tên trường, vd Mã khách" maxlength="' + (L.customFieldKey || 60) + '" value="' + esc(k || "") + '">' +
        '<input class="cfv" placeholder="Giá trị" maxlength="' + (L.customFieldValue || 300) + '" value="' + esc(v || "") + '">';
      var x = el("button", { type: "button", "class": "ghost sm", title: "Xóa trường" }, "✕");
      x.onclick = function () { row.remove(); };
      row.appendChild(x);
      fbox.appendChild(row);
    }
    Object.keys(pf.customFields || {}).forEach(function (k) { addField(k, pf.customFields[k]); });
    $("#pfAddField", box).onclick = function () {
      if (fbox.children.length >= (L.customFieldCount || 20)) { $("#pfInfo", box).textContent = "Tối đa " + (L.customFieldCount || 20) + " trường"; return; }
      addField("", "");
    };
    var tbox = $("#pfTags", box);
    if (!allTags.length) tbox.innerHTML = '<span class="muted">Chưa có nhãn nào' + (isAdmin() ? " — tạo bằng nút 🏷️ Quản lý nhãn ở trang Contacts" : "") + ".</span>";
    allTags.forEach(function (t) {
      var lb = el("label", { "class": "tagchk" });
      lb.innerHTML = '<input type="checkbox" value="' + esc(t.id) + '"' + (mine[t.id] ? " checked" : "") + "> " + tagPill(t);
      tbox.appendChild(lb);
    });
    var ai = $("#pfAi", box);
    ai.value = pf.aiInstructions || "";
    charCounter(ai, $("#pfAiCount", box), L.personInstructions || 2000);
    $("#pfSave", box).onclick = function () {
      var fields = {};
      eachEl(fbox, ".cf-row", function (row) {
        var k = row.querySelector(".cfk").value.trim(), v = row.querySelector(".cfv").value.trim();
        if (k && v) fields[k] = v;
      });
      var tagIds = [];
      eachEl(tbox, "input[type=checkbox]", function (cb) { if (cb.checked) tagIds.push(cb.value); });
      var body = {
        displayName: $("#pfName", box).value, roleTitle: $("#pfRole", box).value,
        addressAs: $("#pfAddr", box).value, selfAddress: $("#pfSelf", box).value,
        language: $("#pfLang", box).value, phone: $("#pfPhone", box).value, email: $("#pfEmail", box).value,
        shareContactInfo: $("#pfShare", box).checked, customFields: fields,
        aiInstructions: ai.value, useInGroups: $("#pfGroups", box).checked
      };
      var btn = $("#pfSave", box), info = $("#pfInfo", box);
      btn.disabled = true; info.textContent = "Đang lưu…";
      api("/v1/contacts/" + c.id + "/profile", { method: "PUT", body: body })
        .then(function () { return api("/v1/contacts/" + c.id + "/tags", { method: "PUT", body: { tagIds: tagIds } }); })
        .then(function () {
          btn.disabled = false;
          info.textContent = "✓ Đã lưu lúc " + new Date().toLocaleTimeString("vi-VN");
          var dl = box.closest("dialog"), h = dl && dl.querySelector("#ctTitle");
          if (h) h.textContent = body.displayName.trim() || c.displayName || c.externalId;
          if (onChange) onChange();
        })
        .catch(function (e) { btn.disabled = false; info.textContent = "✗ " + e.message; });
    };
  }

  function renderMemoryPane(box, d) {
    var c = d.contact;
    box.innerHTML =
      '<div class="ct-help">AI tự ghi file USER.md khi biết thêm về người này (tên gọi, sở thích, việc đang làm…); file được nạp vào mọi lượt chat của họ. Sửa khi AI ghi sai — lời dặn cho AI nên đặt ở tab "Hồ sơ & chỉ dẫn".</div>' +
      '<textarea id="umText" class="memory-textarea" maxlength="8000"></textarea>' +
      '<div class="row" style="justify-content:space-between;margin-top:6px"><span class="muted" id="umInfo"></span><button id="umSave" class="sm">Lưu USER.md</button></div>' +
      '<h4 class="ct-sec">Ghi nhớ gắn với người này</h4><div id="umMem"></div>' +
      '<h4 class="ct-sec">File ghi nhớ riêng (MEMORY.md, memory/*.md)</h4><div id="umDocs"></div><div id="umDocView"></div>';
    var ta = $("#umText", box);
    ta.value = d.userMd.content || "";
    $("#umInfo", box).textContent = d.userMd.exists ? "" : "Chưa có — AI tạo khi người này nhắn lượt đầu (hoặc lưu ngay tại đây).";
    $("#umSave", box).onclick = function () {
      var btn = this;
      btn.disabled = true;
      api("/v1/contacts/" + c.id + "/user-md", { method: "PUT", body: { content: ta.value } })
        .then(function () { btn.disabled = false; $("#umInfo", box).textContent = "✓ Đã lưu lúc " + new Date().toLocaleTimeString("vi-VN"); })
        .catch(function (e) { btn.disabled = false; $("#umInfo", box).textContent = "✗ " + e.message; });
    };
    $("#umMem", box).appendChild(table(["Agent", "Nội dung", "Mức", ""], d.memories || [], function (r) {
      var tr = el("tr");
      tr.innerHTML = "<td>" + esc(r.agentName) + "</td><td class='umc'>" + esc(r.content) + "</td><td>" + (r.pinned ? "📌 " : "") + Number(r.importance).toFixed(1) + "</td>";
      var td = el("td", { style: "white-space:nowrap" });
      var ed = el("button", { "class": "ghost sm" }, "Sửa");
      ed.onclick = function () {
        var cell = tr.querySelector(".umc");
        if (cell.querySelector("textarea")) return;
        cell.innerHTML = '<textarea class="memory-textarea" style="min-height:80px"></textarea><div class="row" style="margin-top:4px"><button class="sm" data-ok="1">Lưu</button><button class="ghost sm" data-no="1">Hủy</button></div>';
        var t = cell.querySelector("textarea");
        t.value = r.content;
        t.focus();
        cell.querySelector("[data-no]").onclick = function () { cell.textContent = r.content; };
        cell.querySelector("[data-ok]").onclick = function () {
          var v = t.value.trim();
          if (!v) return;
          api("/v1/memories/" + r.id, { method: "PATCH", body: { content: v } })
            .then(function () { r.content = v; cell.textContent = v; })
            .catch(function (e) { alert(e.message); });
        };
      };
      var del = el("button", { "class": "ghost sm" }, "Xóa");
      del.onclick = function () {
        if (!confirm("Xóa ghi nhớ này?")) return;
        api("/v1/memories/" + r.id, { method: "DELETE" }).then(function () { tr.remove(); }).catch(function (e) { alert(e.message); });
      };
      td.appendChild(ed); td.appendChild(document.createTextNode(" ")); td.appendChild(del);
      tr.appendChild(td);
      return tr;
    }));
    var docs = (d.related && d.related.memoryDocs) || [];
    $("#umDocs", box).appendChild(table(["Agent", "File", "Kích thước", "Cập nhật", ""], docs, function (r) {
      var tr = el("tr");
      tr.innerHTML = "<td>" + esc(r.agentName) + "</td><td><code>" + esc(r.path) + "</code></td><td>" + fmtSize(r.bytes) + "</td><td class='muted'>" + esc(fmtTime(r.updatedAt)) + "</td>";
      var td = el("td");
      var v = el("button", { "class": "ghost sm" }, "Xem");
      v.onclick = function () {
        api("/v1/memory-docs/" + r.id).then(function (j) {
          var out = $("#umDocView", box);
          out.innerHTML = "";
          var pre = el("div", { "class": "ct-pre" });
          pre.textContent = j.doc.content;
          out.appendChild(pre);
        }).catch(function (e) { alert(e.message); });
      };
      td.appendChild(v);
      tr.appendChild(td);
      return tr;
    }));
  }

  function renderChatsPane(box, d) {
    var rel = d.related || {};
    box.innerHTML =
      '<h4 class="ct-sec" style="margin-top:0">Hội thoại hiện tại trên kênh</h4><div id="hsList"></div><div id="hsView"></div>' +
      '<h4 class="ct-sec">File trong thư mục riêng</h4><div class="ct-help">Ảnh, tài liệu người này gửi và file AI tạo cho họ.</div><div id="hsFiles"></div>';
    $("#hsList", box).appendChild(table(["Agent", "Số tin", "Hoạt động gần nhất", ""], rel.sessions || [], function (s) {
      var tr = el("tr");
      tr.innerHTML = "<td>" + esc(s.agentName || "") + "</td><td>" + s.messageCount + "</td><td class='muted'>" + esc(fmtTime(s.lastActive)) + "</td>";
      var td = el("td");
      var b = el("button", { "class": "ghost sm" }, "Xem tin nhắn");
      b.onclick = function () {
        var out = $("#hsView", box);
        out.innerHTML = '<span class="muted">Đang tải…</span>';
        api("/v1/sessions/" + s.id + "/messages").then(function (j) {
          var list = (j.messages || []).filter(function (msg) {
            var ct = msg.content || {};
            return (msg.role === "user" && ct.kind === "text") || (msg.role === "assistant" && ct.text);
          }).slice(-40);
          out.innerHTML = "";
          var wrap = el("div", { "class": "ct-msgs" });
          if (!list.length) wrap.appendChild(el("span", { "class": "muted" }, "(chưa có tin nhắn)"));
          list.forEach(function (msg) {
            var div = el("div", { "class": msg.role === "user" ? "u" : "b" });
            div.textContent = (msg.role === "user" ? "👤 " : "🤖 ") + String(msg.content.text || "");
            wrap.appendChild(div);
          });
          out.appendChild(wrap);
          wrap.scrollTop = wrap.scrollHeight;
        }).catch(function (e) { out.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      td.appendChild(b);
      tr.appendChild(td);
      return tr;
    }));
    $("#hsFiles", box).appendChild(table(["File", "Kích thước", "Sửa lúc"], d.files || [], function (f) {
      var tr = el("tr");
      tr.innerHTML = "<td><code>" + esc(f.path) + "</code></td><td>" + fmtSize(f.bytes) + "</td><td class='muted'>" + esc(fmtTime(f.modifiedAt)) + "</td>";
      return tr;
    }));
  }

  function renderAccessPane(box, d) {
    var rel = d.related || {};
    box.innerHTML =
      '<h4 class="ct-sec" style="margin-top:0">Tài liệu riêng trong Kho tri thức</h4>' +
      '<div class="ct-help">Bộ sưu tập cấp cho riêng người này — AI chỉ tìm được tài liệu trong đó khi người này hỏi. Cấp thêm ở trang <a href="#/vault">Kho tri thức (Vault)</a>, phân quyền "Người cụ thể".</div><div id="acVault"></div>' +
      '<h4 class="ct-sec">Quyền dùng tool MCP riêng</h4>' +
      '<div class="ct-help">Chỉnh ở trang <a href="#/mcp">MCP</a>, phần quyền theo người dùng (mã <code>' + esc(d.contact.userKey) + "</code>).</div><div id='acMcp'></div>";
    $("#acVault", box).appendChild(table(["Bộ sưu tập", "Agent được dùng"], rel.vaultCollections || [], function (v) {
      var tr = el("tr");
      tr.innerHTML = "<td>" + esc(v.name) + " <code>" + esc(v.slug) + "</code></td><td>" + esc(v.agentKey || "mọi agent") + "</td>";
      return tr;
    }));
    $("#acMcp", box).appendChild(table(["MCP server", "Trạng thái", "Cho phép", "Chặn"], rel.mcpGrants || [], function (g) {
      var tr = el("tr");
      tr.innerHTML = "<td>" + esc(g.serverName) + "</td><td>" + (g.enabled ? "<span class='pill ok'>được dùng</span>" : "<span class='pill err'>bị chặn</span>") +
        "</td><td>" + esc(g.toolAllow.join(", ") || "mọi tool") + "</td><td>" + esc(g.toolDeny.join(", ") || "—") + "</td>";
      return tr;
    }));
    eachEl(box, "a[href]", function (a) {
      a.addEventListener("click", function () { var dl = box.closest("dialog"); if (dl && dl.closeNow) dl.closeNow(); });
    });
  }

  function renderPreviewPane(box, d, agents) {
    var c = d.contact, def = d.channel && d.channel.agentKey;
    box.innerHTML =
      '<div class="ct-help">Xem đúng lời dặn hệ thống (system prompt) agent nhận khi người này nhắn: prompt của agent, hướng dẫn, ghi nhớ, tài liệu liên quan, rồi tới khối "Người đang chat" và "Chỉ dẫn của quản trị viên" ở cuối. Danh sách tool không kèm theo.</div>' +
      '<div class="row"><select id="pvAgent"></select><input id="pvMsg" placeholder="Câu hỏi mẫu (để thử phần ghi nhớ/tài liệu liên quan)" value="Xin chào">' +
      '<label class="ct-check" style="margin:0"><input type="checkbox" id="pvGroup"> Giả lập nhóm chat</label><button id="pvRun">Xem</button></div>' +
      '<div id="pvOut"></div>';
    $("#pvAgent", box).innerHTML = agents.map(function (a) {
      return '<option value="' + esc(a.key) + '"' + (a.key === def ? " selected" : "") + ">" + esc(a.name) + "</option>";
    }).join("");
    $("#pvRun", box).onclick = function () {
      var out = $("#pvOut", box), btn = this;
      out.innerHTML = '<span class="muted">Đang dựng ngữ cảnh…</span>';
      btn.disabled = true;
      var qs = "?agent=" + encodeURIComponent($("#pvAgent", box).value) + "&message=" + encodeURIComponent($("#pvMsg", box).value) + ($("#pvGroup", box).checked ? "&group=1" : "");
      api("/v1/contacts/" + c.id + "/context-preview" + qs).then(function (j) {
        btn.disabled = false;
        var ch = j.chars || {};
        out.innerHTML = '<div class="muted" style="margin-top:10px">Tổng ' + ch.total + " ký tự — prompt agent " + ch.agentPrompt + " · hướng dẫn + ghi nhớ " + ch.context + " · tài liệu " + ch.knowledge + " · người đang chat + chỉ dẫn " + ch.person + "</div>";
        var pre = el("div", { "class": "ct-pre" });
        pre.textContent = j.systemPrompt;
        out.appendChild(pre);
      }).catch(function (e) { btn.disabled = false; out.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
  }

  function openTagManager(onChange) {
    var dlg = modal("ct-dialog", onChange);
    dlg.innerHTML =
      '<div class="ct-head"><div><h3 style="margin:0">🏷️ Nhãn</h3><div class="muted" style="margin-top:3px">Phân nhóm người (VIP, Đại lý cấp 1, Học viên…). Chỉ dẫn của nhãn áp cho mọi người mang nhãn, đứng trước chỉ dẫn riêng của từng người.</div></div><button class="ghost sm" data-x="1">✕</button></div>' +
      '<div id="tgList" style="margin-top:12px"></div>' +
      '<h4 class="ct-sec" id="tgFormTitle">Thêm nhãn</h4>' +
      '<div class="row"><input id="tgName" maxlength="40" placeholder="Tên nhãn, vd VIP"><input id="tgColor" type="color" value="#3b82f6" title="Màu nhãn" style="flex:0 0 52px;min-width:52px;padding:2px"></div>' +
      '<label for="tgAi">Chỉ dẫn cho AI với mọi người mang nhãn này (không bắt buộc)</label>' +
      '<textarea id="tgAi" class="memory-textarea" style="min-height:100px" maxlength="1000" placeholder="vd Đại lý cấp 1: báo giá theo bảng đại lý, ưu tiên xử lý đơn gấp."></textarea><div class="ct-count" id="tgAiCount"></div>' +
      '<label class="ct-check"><input type="checkbox" id="tgGroups"> Dùng chỉ dẫn này cả trong nhóm chat</label>' +
      '<div class="dialog-actions"><span class="muted" id="tgInfo" style="margin-right:auto"></span><button class="ghost" id="tgCancel" style="display:none">Hủy sửa</button><button id="tgSave">Thêm nhãn</button></div>';
    var editing = null;
    var ai = $("#tgAi", dlg);
    charCounter(ai, $("#tgAiCount", dlg), 1000);
    $("[data-x]", dlg).onclick = dlg.closeNow;
    function resetForm() {
      editing = null;
      $("#tgName", dlg).value = "";
      $("#tgColor", dlg).value = "#3b82f6";
      ai.value = "";
      ai.dispatchEvent(new Event("input"));
      $("#tgGroups", dlg).checked = false;
      $("#tgFormTitle", dlg).textContent = "Thêm nhãn";
      $("#tgSave", dlg).textContent = "Thêm nhãn";
      $("#tgCancel", dlg).style.display = "none";
    }
    function load() {
      api("/v1/contact-tags").then(function (j) {
        var box = $("#tgList", dlg);
        box.innerHTML = "";
        box.appendChild(table(["Nhãn", "Số người", "Chỉ dẫn cho AI", "Trong nhóm", ""], j.tags || [], function (t) {
          var tr = el("tr");
          var note = t.aiInstructions ? (t.aiInstructions.length > 140 ? t.aiInstructions.slice(0, 140) + "…" : t.aiInstructions) : "—";
          tr.innerHTML = "<td>" + tagPill(t) + "</td><td>" + t.memberCount + "</td><td class='muted' style='max-width:380px'>" + esc(note) + "</td><td>" + (t.useInGroups ? "có" : "không") + "</td>";
          var td = el("td", { style: "white-space:nowrap" });
          var ed = el("button", { "class": "ghost sm" }, "Sửa");
          ed.onclick = function () {
            editing = t;
            $("#tgName", dlg).value = t.name;
            $("#tgColor", dlg).value = t.color || "#3b82f6";
            ai.value = t.aiInstructions || "";
            ai.dispatchEvent(new Event("input"));
            $("#tgGroups", dlg).checked = !!t.useInGroups;
            $("#tgFormTitle", dlg).textContent = "Sửa nhãn " + t.name;
            $("#tgSave", dlg).textContent = "Lưu nhãn";
            $("#tgCancel", dlg).style.display = "";
            $("#tgName", dlg).focus();
          };
          var del = el("button", { "class": "ghost sm" }, "Xóa");
          del.onclick = function () {
            if (!confirm("Xóa nhãn " + t.name + "? Nhãn sẽ bị gỡ khỏi " + t.memberCount + " người.")) return;
            api("/v1/contact-tags/" + t.id, { method: "DELETE" }).then(function () {
              if (editing && editing.id === t.id) resetForm();
              load();
            }).catch(function (e) { $("#tgInfo", dlg).textContent = "✗ " + e.message; });
          };
          td.appendChild(ed); td.appendChild(document.createTextNode(" ")); td.appendChild(del);
          tr.appendChild(td);
          return tr;
        }));
      }).catch(function (e) { $("#tgList", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    $("#tgCancel", dlg).onclick = resetForm;
    $("#tgSave", dlg).onclick = function () {
      var body = { name: $("#tgName", dlg).value.trim(), color: $("#tgColor", dlg).value, aiInstructions: ai.value, useInGroups: $("#tgGroups", dlg).checked };
      if (!body.name) { $("#tgInfo", dlg).textContent = "✗ Nhập tên nhãn"; return; }
      var req = editing
        ? api("/v1/contact-tags/" + editing.id, { method: "PATCH", body: body })
        : api("/v1/contact-tags", { method: "POST", body: body });
      req.then(function () { $("#tgInfo", dlg).textContent = "✓ Đã lưu nhãn " + body.name; resetForm(); load(); })
        .catch(function (e) { $("#tgInfo", dlg).textContent = "✗ " + e.message; });
    };
    dlg.showModal();
    load();
  }

  PAGES.traces = function () {
    var m = page("Traces", "Nhật ký gọi LLM");
    var c = card(m);
    api("/v1/traces").then(function (j) { c.appendChild(table(["Thời gian", "Kind", "In/Out tokens", "Vòng", "ms", "Lỗi"], j.traces, function (r) { var t = el("tr"); t.innerHTML = "<td class='muted'>" + esc((r.createdAt || "").slice(0, 19).replace("T", " ")) + "</td><td>" + esc(r.kind) + "</td><td>" + r.inputTokens + "/" + r.outputTokens + "</td><td>" + r.iterations + "</td><td>" + r.durationMs + "</td><td class='err'>" + esc(r.error || "") + "</td>"; return t; })); });
  };

  PAGES.usage = function () {
    var m = page("Usage & Cap", "Token đã dùng và hạn mức tháng");
    var c = card(m);
    api("/v1/usage").then(function (j) {
      c.innerHTML = '<div class="stats"><div class="stat"><div class="n">' + j.monthTokens + '</div><div class="l">Token tháng này</div></div><div class="stat"><div class="n">' + (j.cap || "∞") + '</div><div class="l">Hạn mức</div></div></div>';
      var f = el("div", { "class": "row", style: "margin-top:12px" }); f.innerHTML = '<input id="capVal" type="number" placeholder="hạn mức token/tháng" style="width:200px"><button id="capSet">Đặt hạn mức</button>'; c.appendChild(f);
      $("#capSet").onclick = function () { api("/v1/usage/cap", { method: "PUT", body: { monthlyTokenLimit: Number($("#capVal").value) } }).then(function () { toast("Đã đặt hạn mức"); PAGES.usage(); }).catch(function (e) { toast(e.message, 1); }); };
    });
  };

  // ===== Thư viện file của agent (26/09/2026) =====
  // Agent thấy thư viện riêng qua "thu-vien/", thư mục chung qua "shared/".
  function libApi(scope, sub) { return "/v1/library/" + encodeURIComponent(scope) + sub; }
  function libFileUrl(scope, rel, dl) { return libApi(scope, "/file?path=" + encodeURIComponent(rel) + (dl ? "&dl=1" : "")); }
  function extOf(name) { var i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; }
  var LIB_IMG = ["png", "jpg", "jpeg", "webp", "gif"];
  var LIB_TEXT = ["txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm", "css", "js", "py", "sql", "log"];
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast("Đã chép: " + t); }, function () { prompt("Chép đường dẫn:", t); });
    } else prompt("Chép đường dẫn:", t);
  }

  /** Lưu 1 file trong khung chat vào Thư viện file (nút dưới thẻ file). */
  function openLibSave(p, name) {
    var dlg = el("dialog", { style: "width:460px;padding:18px" });
    dlg.innerHTML = '<h3 style="margin:0 0 8px">📁 Lưu vào Thư viện file</h3>' +
      '<div class="muted" style="font-size:.85rem;margin-bottom:6px">File: <b>' + esc(name) + "</b></div>" +
      '<label>Thư viện</label><select id="lsScope" style="width:100%"></select>' +
      '<label style="margin-top:8px">Thư mục con (bỏ trống = thư mục gốc)</label><input id="lsDir" style="width:100%" placeholder="vd: mau-bao-gia">' +
      '<div class="row" style="margin-top:12px"><button id="lsOk">Lưu</button><button class="ghost" id="lsCancel">Hủy</button><span id="lsMsg" class="muted"></span></div>';
    document.body.appendChild(dlg); dlg.showModal();
    var sel = $("#lsScope", dlg);
    sel.appendChild(el("option", { value: "shared" }, "🏢 Chung cả bộ phận (mọi agent đọc được)"));
    var chatSel = $("#chatAgent"); var curKey = chatSel ? chatSel.value : "";
    state.agents.forEach(function (a) { var o = el("option", { value: a.id }, "🤖 " + esc(a.name)); if (a.key === curKey) o.selected = true; sel.appendChild(o); });
    $("#lsCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
    $("#lsOk", dlg).onclick = function () {
      $("#lsOk", dlg).disabled = true;
      api("/v1/library/import-chat", { method: "POST", body: { p: p, toScope: sel.value, toDir: $("#lsDir", dlg).value.trim() } })
        .then(function (j) { dlg.close(); dlg.remove(); toast("Đã lưu vào thư viện: " + j.path); })
        .catch(function (e) { $("#lsOk", dlg).disabled = false; $("#lsMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest(".lib-save") : null;
    if (!b) return;
    e.preventDefault();
    openLibSave(b.getAttribute("data-p"), b.getAttribute("data-name"));
  });

  PAGES.library = function () {
    var m = page("Thư viện file", "File mẫu, tài liệu tham khảo cho agent. Agent thấy thư viện của mình qua đường dẫn thu-vien/ (mặc định chỉ đọc), thư mục chung qua shared/. System prompt của agent tự hướng dẫn khi nào tra cứu.");
    var q = {};
    (state.routeQuery || "").split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    var grid = el("div", { "class": "lib-grid" }); m.appendChild(grid);
    var left = el("div", { "class": "card lib-side" }); grid.appendChild(left);
    var right = el("div", { "class": "card lib-main" }); grid.appendChild(right);
    var info = null;
    var cur = { scope: q.agent || "shared", path: "", view: "files" };
    var filterText = "";

    function scopeInfo(id) { if (!info) return null; for (var i = 0; i < info.scopes.length; i++) if (info.scopes[i].id === id) return info.scopes[i]; return null; }
    function loadScopes() {
      return api("/v1/library").then(function (j) { info = j; renderSide(); })
        .catch(function (e) { left.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; throw e; });
    }
    function renderSide() {
      left.innerHTML = '<div class="muted" style="font-size:.78rem;margin-bottom:6px">Đã dùng <b>' + fmtSize(info.usedBytes) + "</b> / " + fmtSize(info.quotaBytes) + " · tối đa " + fmtSize(info.maxFileBytes) + "/file</div>" +
        '<input id="libFind" placeholder="Tìm agent…" style="width:100%;margin-bottom:6px"><div id="libScopes"></div>';
      var inp = $("#libFind", left); inp.value = filterText;
      inp.oninput = function () { filterText = inp.value.trim().toLowerCase(); drawScopes(); };
      drawScopes();
    }
    function drawScopes() {
      var box = $("#libScopes", left); if (!box || !info) return; box.innerHTML = "";
      info.scopes.forEach(function (s) {
        if (filterText && (s.name + " " + (s.key || "")).toLowerCase().indexOf(filterText) < 0 && s.id !== cur.scope) return;
        var d = el("div", { "class": "lib-scope" + (s.id === cur.scope ? " active" : ""), title: s.kind === "shared" ? (s.note || "") : (s.key || "") });
        d.innerHTML = "<span>" + (s.kind === "shared" ? "🏢 " : "🤖 ") + esc(s.name) + "</span><span class='muted'>" + (s.files ? s.files + " file" : "trống") + (s.libraryWritable ? " · ✏️" : "") + "</span>";
        d.onclick = function () { cur.scope = s.id; cur.path = ""; cur.view = "files"; drawScopes(); loadDir(); };
        box.appendChild(d);
      });
    }
    function msg(t) { var e = $("#libMsg", right); if (e) e.textContent = t; }
    function loadDir() {
      if (cur.view === "trash") return loadTrash();
      right.innerHTML = '<span class="muted">đang tải…</span>';
      api(libApi(cur.scope, "/list?path=" + encodeURIComponent(cur.path)))
        .then(renderDir)
        .catch(function (e) { right.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    function header(s) {
      var h = el("div", { "class": "row", style: "justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap" });
      var t = el("div");
      t.innerHTML = '<h3 style="margin:0">' + (s.kind === "shared" ? "🏢 " : "🤖 ") + esc(s.name) + (s.key ? " <code>" + esc(s.key) + "</code>" : "") + "</h3>" +
        '<div class="muted" style="font-size:.8rem;margin-top:3px">' + (s.kind === "shared"
          ? "Mọi agent trong bộ phận đọc được qua <code>shared/</code> — chỉ để thứ thật sự dùng chung. Thư mục <code>skills/</code> do trang Skills quản lý."
          : "Agent thấy qua <code>thu-vien/</code> · trong lệnh exec: <code>" + esc(s.absRoot) + "/</code>") + "</div>";
      h.appendChild(t);
      if (s.kind === "agent") {
        var can = !!(info && info.canToggleWrite);
        var w = el("label", { style: "display:flex;align-items:center;gap:6px;font-size:.85rem;white-space:nowrap" });
        w.innerHTML = '<input type="checkbox" id="libW" style="flex:0"' + (s.libraryWritable ? " checked" : "") + (can ? "" : " disabled") + "> Cho agent ghi vào thư viện" + (can ? "" : ' <span class="muted">(chỉ quản trị bộ phận đổi được)</span>');
        h.appendChild(w);
        var cb = $("#libW", w);
        cb.onchange = function () {
          var v = cb.checked;
          if (v && !confirm("Cho agent ghi vào thư viện này? Agent sẽ tạo, sửa, ghi đè được file trong thư viện (kể cả khi người chat yêu cầu). File agent xóa vẫn vào thùng rác 30 ngày.")) { cb.checked = false; return; }
          api("/v1/agents/" + s.id, { method: "PATCH", body: { libraryWritable: v } })
            .then(function () { toast(v ? "Agent được ghi vào thư viện" : "Thư viện chỉ đọc với agent"); loadScopes().then(loadDir, function () {}); })
            .catch(function (e) { cb.checked = !v; toast(e.message, 1); });
        };
      }
      return h;
    }
    function renderDir(j) {
      var s = j.scope; cur.path = j.path;
      right.innerHTML = "";
      right.appendChild(header(s));
      var bc = el("div", { "class": "lib-bc" });
      var parts = j.path ? j.path.split("/") : [];
      var html = '<a data-p="">' + (s.kind === "shared" ? "shared" : "thu-vien") + "</a>", acc = "";
      parts.forEach(function (p) { acc = acc ? acc + "/" + p : p; html += ' / <a data-p="' + esc(acc) + '">' + esc(p) + "</a>"; });
      bc.innerHTML = "📂 " + html;
      bc.querySelectorAll("a").forEach(function (a) { a.onclick = function () { cur.path = a.getAttribute("data-p"); loadDir(); }; });
      right.appendChild(bc);
      var ro = j.readonly;
      var tb = el("div", { "class": "row", style: "margin:10px 0 8px;gap:6px;flex-wrap:wrap;align-items:center" });
      tb.innerHTML = (ro ? '<span class="pill">Chỉ xem — do hệ thống Skill quản lý</span>'
        : '<button id="libUp" class="sm">⬆ Tải file lên</button><button id="libMk" class="ghost sm">＋ Thư mục</button>') +
        '<button id="libTrash" class="ghost sm">🗑 Thùng rác</button><span id="libMsg" class="muted" style="font-size:.82rem"></span>';
      var fin = el("input", { type: "file", multiple: "multiple", style: "display:none" });
      tb.appendChild(fin);
      right.appendChild(tb);
      if (!ro) {
        $("#libUp", tb).onclick = function () { fin.click(); };
        fin.onchange = function () { uploadFiles(fin.files); fin.value = ""; };
        $("#libMk", tb).onclick = function () {
          var n = prompt("Tên thư mục mới (tự chuyển thành không dấu):"); if (!n || !n.trim()) return;
          api(libApi(cur.scope, "/mkdir"), { method: "POST", body: { path: cur.path, name: n.trim() } })
            .then(function () { loadDir(); }).catch(function (e) { toast(e.message, 1); });
        };
      }
      $("#libTrash", tb).onclick = function () { cur.view = "trash"; loadTrash(); };
      var zone = el("div", { "class": "lib-zone" });
      if (!j.entries.length) {
        zone.innerHTML = '<div class="muted" style="padding:26px;text-align:center">' + (ro ? "(trống)" : "Thư mục trống — bấm «Tải file lên» hoặc kéo-thả file vào đây") + "</div>";
      } else {
        zone.appendChild(table(["Tên", "Kích thước", "Cập nhật", ""], j.entries, function (e) { return entryRow(j, e); }));
      }
      if (!ro) {
        zone.addEventListener("dragover", function (ev) { ev.preventDefault(); zone.classList.add("drop"); });
        zone.addEventListener("dragleave", function () { zone.classList.remove("drop"); });
        zone.addEventListener("drop", function (ev) { ev.preventDefault(); zone.classList.remove("drop"); uploadFiles((ev.dataTransfer && ev.dataTransfer.files) || []); });
      }
      right.appendChild(zone);
      right.appendChild(el("div", { "class": "muted", style: "font-size:.76rem;margin-top:8px" },
        "Tên file/thư mục được chuyển thành dạng không dấu để agent gõ đường dẫn chính xác. Xóa hoặc ghi đè thì bản cũ vào thùng rác 30 ngày. Bấm 📋 để chép đường dẫn dán vào system prompt."));
    }
    function entryRow(j, e) {
      var rel = j.path ? j.path + "/" + e.name : e.name;
      var agentPath = (j.scope.kind === "shared" ? "shared/" : "thu-vien/") + rel;
      var tr = el("tr");
      var icon = e.type === "dir" ? "📁" : fileIcon(e.name);
      tr.innerHTML = '<td><div class="lib-name">' + icon + " " + esc(e.name) + (e.type === "dir" ? '<span class="muted"> (' + (e.items || 0) + " mục)</span>" : "") + '</div><div class="lib-path">' + esc(agentPath) + "</div></td>" +
        "<td>" + (e.type === "dir" ? "" : fmtSize(e.size)) + "</td>" +
        '<td class="muted" style="font-size:.8rem">' + esc(String(e.mtime || "").slice(0, 16).replace("T", " ")) + "</td>";
      var td = el("td", { "class": "lib-acts" });
      function btn(label, title, fn) { var b = el("button", { "class": "ghost sm", title: title }, label); b.onclick = fn; td.appendChild(b); }
      tr.querySelector(".lib-name").onclick = function () { if (e.type === "dir") { cur.path = rel; loadDir(); } else preview(j.scope, rel, e); };
      if (e.type === "file") btn("⬇", "Tải về", function () { window.open(libFileUrl(j.scope.id, rel, true), "_blank"); });
      btn("📋", "Chép đường dẫn cho agent", function () { copyText(agentPath); });
      if (!e.readonly && !j.readonly) {
        btn("✎", "Đổi tên / di chuyển", function () { renameEntry(rel, e); });
        btn("⧉", "Sao chép sang thư viện khác", function () { copyEntry(rel, e); });
        btn("🗑", "Xóa (vào thùng rác)", function () {
          if (!confirm("Xóa «" + e.name + "»" + (e.type === "dir" ? " cùng mọi file bên trong" : "") + "? Có thể khôi phục trong thùng rác 30 ngày.")) return;
          api(libApi(j.scope.id, "/entry?path=" + encodeURIComponent(rel)), { method: "DELETE" })
            .then(function () { toast("Đã chuyển vào thùng rác"); loadDir(); loadScopes(); }).catch(function (er) { toast(er.message, 1); });
        });
      }
      tr.appendChild(td); return tr;
    }
    function renameEntry(rel, e) {
      var n = prompt("Tên mới cho «" + e.name + "». Muốn chuyển sang thư mục khác thì gõ cả đường dẫn tính từ gốc thư viện, vd mau/ten-moi.docx", e.name);
      if (!n || !n.trim() || n.trim() === e.name) return;
      n = n.trim();
      var parent = rel.indexOf("/") >= 0 ? rel.slice(0, rel.lastIndexOf("/")) : "";
      var to = n.indexOf("/") >= 0 ? n : (parent ? parent + "/" + n : n);
      api(libApi(cur.scope, "/move"), { method: "POST", body: { from: rel, to: to } })
        .then(function () { loadDir(); }).catch(function (er) { toast(er.message, 1); });
    }
    function copyEntry(rel, e) {
      var dlg = el("dialog", { style: "width:440px;padding:18px" });
      dlg.innerHTML = '<h3 style="margin:0 0 8px">Sao chép «' + esc(e.name) + '»</h3><label>Tới thư viện</label><select id="lcTo" style="width:100%"></select>' +
        '<label style="margin-top:8px">Thư mục con (bỏ trống = gốc)</label><input id="lcDir" style="width:100%">' +
        '<div class="row" style="margin-top:12px"><button id="lcOk">Sao chép</button><button class="ghost" id="lcX">Hủy</button><span id="lcMsg" class="muted"></span></div>';
      document.body.appendChild(dlg); dlg.showModal();
      var sel = $("#lcTo", dlg);
      info.scopes.forEach(function (s) { if (s.id === cur.scope) return; sel.appendChild(el("option", { value: s.id }, (s.kind === "shared" ? "🏢 " : "🤖 ") + esc(s.name))); });
      $("#lcX", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#lcOk", dlg).onclick = function () {
        $("#lcOk", dlg).disabled = true;
        api("/v1/library/copy", { method: "POST", body: { fromScope: cur.scope, path: rel, toScope: sel.value, toDir: $("#lcDir", dlg).value.trim() } })
          .then(function (r) { dlg.close(); dlg.remove(); toast("Đã sao chép tới " + r.path); loadScopes(); })
          .catch(function (er) { $("#lcOk", dlg).disabled = false; $("#lcMsg", dlg).innerHTML = '<span class="err">' + esc(er.message) + "</span>"; });
      };
    }
    function preview(scope, rel, e) {
      var ext = extOf(e.name), url = libFileUrl(scope.id, rel, false);
      if (LIB_IMG.indexOf(ext) >= 0) {
        var d = el("dialog", { style: "padding:12px;max-width:92vw" });
        d.innerHTML = '<div class="row" style="justify-content:space-between;margin-bottom:8px"><b>' + esc(e.name) + '</b><button class="ghost sm" id="pvX">Đóng</button></div><img src="' + url + '" alt="" style="max-width:86vw;max-height:78vh;display:block;border-radius:8px">';
        document.body.appendChild(d); d.showModal(); $("#pvX", d).onclick = function () { d.close(); d.remove(); };
        return;
      }
      if (ext === "pdf") { window.open(url, "_blank"); return; }
      if (LIB_TEXT.indexOf(ext) >= 0 && e.size <= 300 * 1024) {
        fetch(libFileUrl(scope.id, rel, true)).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }).then(function (t) {
          var d2 = el("dialog", { style: "padding:12px;width:820px;max-width:92vw" });
          d2.innerHTML = '<div class="row" style="justify-content:space-between;margin-bottom:8px"><b>' + esc(e.name) + '</b><button class="ghost sm" id="pvX">Đóng</button></div><pre style="max-height:70vh;overflow:auto;white-space:pre-wrap;font-size:.8rem;margin:0"></pre>';
          d2.querySelector("pre").textContent = t;
          document.body.appendChild(d2); d2.showModal(); $("#pvX", d2).onclick = function () { d2.close(); d2.remove(); };
        }).catch(function (er) { toast(er.message, 1); });
        return;
      }
      window.open(libFileUrl(scope.id, rel, true), "_blank");
    }
    function uploadFiles(files) {
      var list = Array.prototype.slice.call(files || []); if (!list.length) return;
      var i = 0, ok = 0, scopeAtStart = cur.scope, pathAtStart = cur.path;
      function next(overwrite) {
        if (i >= list.length) {
          msg("Đã tải lên " + ok + "/" + list.length + " file");
          loadScopes().then(function () { if (cur.scope === scopeAtStart && cur.view === "files") loadDir(); }, function () {});
          return;
        }
        var f = list[i];
        if (info && f.size > info.maxFileBytes) { toast(f.name + ": vượt " + fmtSize(info.maxFileBytes) + "/file", 1); i++; return next(false); }
        msg("Đang tải " + (i + 1) + "/" + list.length + ": " + f.name + "…");
        var path = (pathAtStart ? pathAtStart + "/" : "") + f.name;
        fetch(libApi(scopeAtStart, "/file?path=" + encodeURIComponent(path) + (overwrite ? "&overwrite=1" : "")), { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: f })
          .then(function (r) { return r.text().then(function (t) { var jj = {}; try { jj = JSON.parse(t); } catch (e2) {} return { r: r, j: jj }; }); })
          .then(function (x) {
            if (x.r.status === 409 && x.j.exists && !overwrite) {
              if (confirm("«" + x.j.name + "» đã có trong thư mục này. Ghi đè bằng bản mới? (bản cũ vào thùng rác)")) return next(true);
              i++; return next(false);
            }
            if (!x.r.ok) toast(f.name + ": " + (x.j.error || ("HTTP " + x.r.status)), 1); else ok++;
            i++; next(false);
          })
          .catch(function (er) { toast(f.name + ": " + er.message, 1); i++; next(false); });
      }
      next(false);
    }
    function loadTrash() {
      var s = scopeInfo(cur.scope) || { id: cur.scope, name: "" };
      right.innerHTML = '<span class="muted">đang tải…</span>';
      api(libApi(cur.scope, "/trash")).then(function (j) {
        right.innerHTML = "";
        var h = el("div", { "class": "row", style: "justify-content:space-between;align-items:center" });
        h.innerHTML = '<h3 style="margin:0">🗑 Thùng rác — ' + esc(s.name) + '</h3><button class="ghost sm" id="trBack">← Về thư viện</button>';
        right.appendChild(h);
        $("#trBack", h).onclick = function () { cur.view = "files"; loadDir(); };
        right.appendChild(el("div", { "class": "muted", style: "font-size:.8rem;margin:6px 0 10px" }, "Mục đã xóa hoặc bị ghi đè được giữ " + j.keepDays + " ngày rồi tự xóa hẳn."));
        if (!j.items.length) { right.appendChild(el("div", { "class": "muted", style: "padding:20px;text-align:center" }, "(thùng rác trống)")); return; }
        right.appendChild(table(["Mục", "Kích thước", "Xóa lúc", "Lý do", ""], j.items, function (it) {
          var tr = el("tr");
          tr.innerHTML = "<td>" + (it.type === "dir" ? "📁 " : fileIcon(it.name) + " ") + esc(it.path) + "</td><td>" + fmtSize(it.size) + '</td><td class="muted" style="font-size:.8rem">' + esc(String(it.deletedAt).slice(0, 16).replace("T", " ")) + '</td><td class="muted" style="font-size:.8rem">' + esc(it.reason || "") + "</td>";
          var td = el("td", { "class": "lib-acts" });
          var rb = el("button", { "class": "ghost sm" }, "↩ Khôi phục");
          rb.onclick = function () { api(libApi(cur.scope, "/trash/" + it.id + "/restore"), { method: "POST" }).then(function (r) { toast("Đã khôi phục: " + r.path); loadTrash(); loadScopes(); }).catch(function (er) { toast(er.message, 1); }); };
          var xb = el("button", { "class": "ghost sm" }, "Xóa hẳn");
          xb.onclick = function () { if (!confirm("Xóa vĩnh viễn «" + it.path + "»? Không khôi phục được nữa.")) return; api(libApi(cur.scope, "/trash/" + it.id), { method: "DELETE" }).then(function () { loadTrash(); }).catch(function (er) { toast(er.message, 1); }); };
          td.appendChild(rb); td.appendChild(xb); tr.appendChild(td); return tr;
        }));
      }).catch(function (e) { right.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    loadScopes().then(function () { if (!scopeInfo(cur.scope)) cur.scope = "shared"; drawScopes(); loadDir(); }, function () {});
  };

  // ===== Inbox Zalo cá nhân (0031): nhiều người cùng trực, realtime qua SSE =====
  function ibxTime(iso) {
    if (!iso) return "";
    var d = new Date(iso), now = new Date();
    var hm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) + " " + hm;
  }
  function ibxNl(s) { return esc(s).split(String.fromCharCode(10)).join("<br>"); }
  function ibxInitial(name) { var n = String(name || "?").trim(); return esc((n.split(" ").pop() || "?").charAt(0).toUpperCase() || "?"); }
  var IBX_PLATFORM_ICON = { zalo_personal: "🟦 Zalo", whatsapp_personal: "🟩 WhatsApp" };
  var IBX_SRC = { agent: "🤖 AI", web: "👤 Nhân viên", app: "📱 Điện thoại", mcp: "🔌 Ứng dụng AI", api: "🔌 API" };
  var IBX_RX = [["heart", "/-heart", "❤️"], ["like", "/-strong", "👍"], ["haha", ":>", "😆"], ["wow", ":o", "😮"], ["cry", ":-((", "😢"], ["angry", ":-h", "😡"]];
  function ibxRxEmoji(icon) { for (var i = 0; i < IBX_RX.length; i++) if (IBX_RX[i][1] === icon) return IBX_RX[i][2]; return icon && icon.charCodeAt(0) > 127 ? icon : "💬"; }
  var IBX_RX_SRC = { web: "nhân viên", auto: "tự thả", mcp: "ứng dụng AI", app: "điện thoại", zalo: "", peer: "" };

  PAGES.inbox = function () {
    var m = page("Inbox", "Nhiều người cùng xem và trả lời khách trên Zalo cá nhân, WhatsApp cá nhân. Nhân viên trả lời thì AI tự tạm im trong hội thoại đó.");
    var S = { channels: [], canManage: false, ch: null, threads: [], cur: null, msgs: [], filter: "", kind: "", img: null, es: null };
    var top = el("div", { "class": "row", style: "margin-bottom:10px" });
    top.innerHTML = '<select id="ibxCh" style="max-width:260px"></select><span id="ibxSt" class="muted"></span><span style="flex:1"></span>' +
      '<button class="ghost sm" id="ibxNew">＋ Nhắn tin mới</button><button class="ghost sm" id="ibxSync" style="display:none">🔄 Đồng bộ danh bạ</button><button class="ghost sm" id="ibxSet" style="display:none">⚙️ Cài đặt</button>';
    m.appendChild(top);
    var wrap = el("div", { "class": "ibx" });
    wrap.innerHTML = '<div class="ibx-list"><div class="row" style="padding:8px"><input id="ibxQ" placeholder="Tìm tên, uid, SĐT…"><select id="ibxKind" style="flex:0 0 auto;min-width:0"><option value="">Tất cả</option><option value="direct">Cá nhân</option><option value="group">Nhóm</option><option value="unread">Chưa đọc</option></select></div><div id="ibxThreads" class="ibx-threads"></div></div>' +
      '<div class="ibx-chat"><div id="ibxHead" class="ibx-head muted">Chọn một hội thoại bên trái.</div><div id="ibxMsgs" class="ibx-msgs"></div>' +
      '<div class="ibx-compose" id="ibxCompose" style="display:none"><div id="ibxImg"></div><div class="row" style="align-items:flex-end"><textarea id="ibxText" rows="2" placeholder="Nhập tin nhắn… (Enter để gửi, Shift+Enter xuống dòng, dán ảnh trực tiếp)"></textarea><input type="file" id="ibxFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden><button class="ghost" id="ibxAttach" title="Gửi ảnh">🖼️</button><button id="ibxSend">Gửi</button></div></div></div>';
    m.appendChild(wrap);

    function stopEs() { if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; } }
    state.pageCleanup = stopEs;

    function chInfo() { for (var i = 0; i < S.channels.length; i++) if (S.channels[i].id === S.ch) return S.channels[i]; return null; }
    function renderStatus() {
      var c = chInfo(), st = $("#ibxSt");
      if (!c) { st.innerHTML = ""; return; }
      st.innerHTML = (c.connected ? '<span class="pill ok">đã kết nối</span> ' + esc(c.account ? c.account.name : "") : '<span class="pill err">chưa kết nối</span> <span class="muted">— quản trị vào Channels → Kết nối QR</span>') +
        (c.inbox ? "" : ' · <span class="err">đang TẮT lưu nội dung</span>') +
        (c.mcpReadMessages ? ' · <span class="pill" title="Ứng dụng AI bên ngoài (MCP) được đọc hội thoại của kênh này">🔓 AI ngoài đọc được tin</span>' : "") +
        (c.agentReply === false ? ' · <span class="pill" title="Channels → Sửa → Agent tự trả lời">🤖 AI đang tắt</span>' : "") +
        (c.autoReaction ? ' · <span class="pill" title="Tự thả cảm xúc khi khách nhắn">' + (c.autoReaction === "like" ? "👍" : "❤️") + " tự thả</span>" : "");
      $("#ibxSync").style.display = S.canManage ? "" : "none";
      $("#ibxSet").style.display = isAdmin() ? "" : "none";
    }
    function aiBadge(t) {
      if (t.aiMode === "off") return '<span title="Đã tắt AI cho hội thoại này">🚫</span>';
      if (t.pausedUntil && new Date(t.pausedUntil).getTime() > Date.now()) return '<span title="AI đang tạm dừng vì nhân viên vừa trả lời">⏸️</span>';
      return "";
    }
    function threadItem(t) {
      var a = el("div", { "class": "ibx-item" + (S.cur && S.cur.threadId === t.threadId ? " active" : "") });
      a.innerHTML = '<div class="ibx-av' + (t.kind === "group" ? " grp" : "") + '">' + (t.avatar ? '<img src="' + esc(t.avatar) + '" referrerpolicy="no-referrer" alt="">' : ibxInitial(t.name)) + '</div>' +
        '<div class="ibx-mid"><div class="ibx-nm">' + (t.kind === "group" ? "👥 " : "") + esc(t.name || t.threadId) + " " + aiBadge(t) + '</div><div class="ibx-last">' + esc(t.lastMessage || (t.isContact ? "(chưa có tin nhắn)" : "")) + "</div></div>" +
        '<div class="ibx-meta"><div>' + esc(ibxTime(t.lastMessageAt)) + "</div>" + (t.unreadCount ? '<span class="ibx-badge">' + t.unreadCount + "</span>" : "") + "</div>";
      a.onclick = function () { openThread(t); };
      return a;
    }
    function renderThreads() {
      var box = $("#ibxThreads"); box.innerHTML = "";
      if (!S.threads.length) { box.innerHTML = '<div class="muted" style="padding:12px">' + (S.filter ? "Không tìm thấy." : "Chưa có hội thoại nào. Tin nhắn mới tới tài khoản sẽ tự hiện ở đây.") + "</div>"; return; }
      S.threads.forEach(function (t) { box.appendChild(threadItem(t)); });
    }
    function loadThreads() {
      if (!S.ch) return;
      var k = S.kind, qs = "?limit=200" + (S.filter ? "&q=" + encodeURIComponent(S.filter) : "") + (k === "direct" || k === "group" ? "&kind=" + k : "") + (k === "unread" ? "&unread=1" : "");
      api("/v1/inbox/" + S.ch + "/threads" + qs).then(function (j) { S.threads = j.threads || []; renderThreads(); })
        .catch(function (e) { $("#ibxThreads").innerHTML = '<div class="err" style="padding:12px">' + esc(e.message) + "</div>"; });
    }
    function msgBody(x) {
      var md = x.media || {}, h = "";
      var src = md.file ? "/v1/inbox/" + S.ch + "/file?p=" + encodeURIComponent(md.file) : (md.url || "");
      if (x.contentType === "photo") h += src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer"><img class="ibx-photo" src="' + esc(src) + '" referrerpolicy="no-referrer" alt="ảnh" loading="lazy"></a>' : "[Hình ảnh]";
      else if (x.contentType === "sticker") h += md.url ? '<img class="ibx-sticker" src="' + esc(md.url) + '" referrerpolicy="no-referrer" alt="sticker">' : "[Sticker]";
      else if (x.contentType === "file") h += src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">📎 ' + esc(md.name || "Tệp") + "</a>" : "📎 " + esc(md.name || "Tệp");
      else if (x.contentType === "voice") h += md.url ? '<audio controls preload="none" src="' + esc(md.url) + '"></audio>' : md.file ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">🎤 Tin nhắn thoại (tải về)</a>' : "[Tin nhắn thoại]";
      else if (x.contentType === "video") h += (md.url || md.file) ? '<a href="' + esc(md.url || src) + '" target="_blank" rel="noopener noreferrer">🎬 Xem video</a>' : "[Video]";
      else if (x.contentType === "link" && md.url) h += '<a href="' + esc(md.url) + '" target="_blank" rel="noopener noreferrer">🔗 ' + esc(md.url) + "</a>";
      else if (x.contentType === "other" && !x.text) h += '<span class="muted">[Nội dung chưa hỗ trợ hiển thị]</span>';
      var text = x.contentType === "link" ? String(x.text || "").split(String.fromCharCode(10)).filter(function (l) { return l !== md.url; }).join(String.fromCharCode(10)) : x.text;
      if (text) h += (h ? '<div style="margin-top:4px">' : "<div>") + ibxNl(text) + "</div>";
      return h;
    }
    function msgEl(x) {
      var out = x.direction === "out";
      var who = out ? (x.source === "web" ? "👤 " + (x.webUserName || "Nhân viên") : (IBX_SRC[x.source] || "")) : (S.cur && S.cur.kind === "group" ? x.senderName : "");
      if (out && x.source === "mcp" && x.webUserName) who = "🔌 Ứng dụng AI (" + x.webUserName + ")";
      var q = x.meta && x.meta.quote && x.meta.quote.text ? '<div class="ibx-quote">↪ ' + esc(x.meta.quote.text) + "</div>" : "";
      var d = el("div", { "class": "ibx-msg " + (out ? "out" : "in"), "data-id": x.id });
      d.innerHTML = (who ? '<div class="ibx-who">' + esc(who) + "</div>" : "") + '<div class="ibx-bubble">' + q + msgBody(x) + "</div>" + rxHtml(x) + '<div class="ibx-time">' + esc(ibxTime(x.sentAt)) + "</div>";
      if (x.canReact && !out) {
        var mine = myReaction(x);
        var bar = el("div", { "class": "ibx-react" });
        IBX_RX.forEach(function (r) {
          var b = el("button", { type: "button", title: r[0], "class": mine === r[1] ? "mine" : "" }, r[2]);
          b.onclick = function (e) { e.stopPropagation(); react(x, mine === r[1] ? "none" : r[0]); };
          bar.appendChild(b);
        });
        d.appendChild(bar);
      }
      return d;
    }
    function myId() { var c = chInfo(); return c && c.account ? String(c.account.id) : ""; }
    function myReaction(x) { var me = myId(), r = (x.reactions || []).filter(function (y) { return y.reactorId === me; })[0]; return r ? r.icon : ""; }
    function rxHtml(x) {
      var list = x.reactions || [];
      if (!list.length) return "";
      return '<div class="ibx-rx">' + list.map(function (r) {
        var who = r.reactorName || r.reactorId, src = IBX_RX_SRC[r.source] || "";
        if (r.webUserName && (r.source === "web" || r.source === "mcp")) src += " " + r.webUserName;
        return '<span title="' + esc(who + (src ? " (" + src.trim() + ")" : "")) + '">' + ibxRxEmoji(r.icon) + "</span>";
      }).join("") + "</div>";
    }
    function react(x, key) {
      api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(S.cur.threadId) + "/messages/" + x.id + "/react", { method: "POST", body: { reaction: key } })
        .catch(function (e) { toast(e.message, true); });
    }
    function replaceMsg(x) {
      var node = document.querySelector('.ibx-msg[data-id="' + x.id + '"]');
      if (node) node.parentNode.replaceChild(msgEl(x), node);
    }
    function renderHead() {
      var t = S.cur, h = $("#ibxHead");
      if (!t) { h.innerHTML = "Chọn một hội thoại bên trái."; return; }
      var paused = t.pausedUntil && new Date(t.pausedUntil).getTime() > Date.now();
      h.className = "ibx-head";
      h.innerHTML = '<div><b>' + (t.kind === "group" ? "👥 " : "👤 ") + esc(t.name || t.threadId) + '</b> <span class="muted">' + (t.kind === "group" ? "nhóm" : "cá nhân") + " · uid <code>" + esc(t.threadId) + "</code>" + (t.phone ? " · " + esc(t.phone) : "") + "</span></div>" +
        '<div class="row" style="gap:6px"><span class="muted">AI trả lời:</span><select id="ibxAi" style="padding:3px 6px"><option value="auto">Theo cấu hình kênh</option><option value="off">Tắt cho hội thoại này</option></select>' +
        (paused ? '<span class="pill">⏸️ tạm dừng tới ' + esc(ibxTime(t.pausedUntil)) + '</span><button class="ghost sm" id="ibxResume">Cho AI trả lời lại</button>' : "") + "</div>";
      $("#ibxAi").value = t.aiMode || "auto";
      $("#ibxAi").onchange = function () { setAi({ mode: this.value }); };
      var r = $("#ibxResume"); if (r) r.onclick = function () { setAi({ resume: true }); };
    }
    function setAi(body) {
      api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(S.cur.threadId) + "/ai", { method: "PUT", body: body })
        .then(function (j) { if (j.thread) { S.cur = j.thread; mergeThread(j.thread); renderHead(); } toast("Đã cập nhật"); })
        .catch(function (e) { toast(e.message, true); });
    }
    function renderMsgs(keepScroll) {
      var box = $("#ibxMsgs"), old = box.scrollHeight - box.scrollTop;
      box.innerHTML = "";
      if (S.msgs.length >= 50) { var more = el("button", { "class": "ghost sm", style: "display:block;margin:6px auto" }, "Tải tin cũ hơn"); more.onclick = loadOlder; box.appendChild(more); }
      if (!S.msgs.length) box.appendChild(el("div", { "class": "muted", style: "padding:16px;text-align:center" }, "Chưa có tin nhắn được lưu (hệ thống chỉ lưu từ lúc kết nối). Gửi tin đầu tiên ở ô bên dưới."));
      S.msgs.forEach(function (x) { box.appendChild(msgEl(x)); });
      box.scrollTop = keepScroll ? box.scrollHeight - old : box.scrollHeight;
    }
    function loadOlder() {
      if (!S.msgs.length) return;
      api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(S.cur.threadId) + "/messages?limit=50&before=" + S.msgs[0].id).then(function (j) {
        S.msgs = (j.messages || []).concat(S.msgs); renderMsgs(true);
      }).catch(function (e) { toast(e.message, true); });
    }
    function openThread(t) {
      S.cur = t; S.img = null; renderImg();
      Array.prototype.forEach.call(document.querySelectorAll(".ibx-item"), function (n) { n.classList.remove("active"); });
      renderThreads(); renderHead();
      $("#ibxCompose").style.display = "";
      $("#ibxMsgs").innerHTML = '<div class="muted" style="padding:16px">Đang tải…</div>';
      api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(t.threadId) + "/messages?limit=50").then(function (j) {
        if (!S.cur || S.cur.threadId !== t.threadId) return;
        if (j.thread) { S.cur = j.thread; renderHead(); }
        S.msgs = j.messages || []; renderMsgs(false);
      }).catch(function (e) { $("#ibxMsgs").innerHTML = '<div class="err" style="padding:16px">' + esc(e.message) + "</div>"; });
      if (t.unreadCount) {
        api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(t.threadId) + "/read", { method: "POST", body: {} }).catch(function () {});
        t.unreadCount = 0; renderThreads();
      }
      $("#ibxText").focus();
    }
    function mergeThread(t) {
      var i; for (i = 0; i < S.threads.length; i++) if (S.threads[i].threadId === t.threadId) break;
      if (i < S.threads.length) S.threads.splice(i, 1);
      if (S.kind === "unread" && !t.unreadCount) { renderThreads(); return; }
      if ((S.kind === "direct" || S.kind === "group") && t.kind !== S.kind) { renderThreads(); return; }
      S.threads.unshift(t); renderThreads();
    }
    function renderImg() {
      var b = $("#ibxImg");
      if (!S.img) { b.innerHTML = ""; return; }
      b.innerHTML = '<div class="row" style="margin-bottom:6px"><img src="' + S.img + '" style="max-height:90px;border-radius:8px"><button class="ghost sm" id="ibxImgX">Bỏ ảnh</button></div>';
      $("#ibxImgX").onclick = function () { S.img = null; renderImg(); };
    }
    function takeFile(f) {
      if (!f) return;
      if (!/^image[/](png|jpeg|gif|webp)$/.test(f.type)) { toast("Chỉ gửi ảnh PNG/JPEG/GIF/WEBP", true); return; }
      if (f.size > 10 * 1024 * 1024) { toast("Ảnh vượt 10 MB", true); return; }
      var r = new FileReader(); r.onload = function () { S.img = r.result; renderImg(); }; r.readAsDataURL(f);
    }
    $("#ibxAttach").onclick = function () { $("#ibxFile").click(); };
    $("#ibxFile").onchange = function () { takeFile(this.files[0]); this.value = ""; };
    $("#ibxText").addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === "file" && items[i].type.indexOf("image/") === 0) { takeFile(items[i].getAsFile()); e.preventDefault(); return; }
    });
    $("#ibxText").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    $("#ibxSend").onclick = send;
    function send() {
      if (!S.cur) return;
      var text = $("#ibxText").value, body = {};
      if (text.trim()) body.text = text;
      if (S.img) body.image = S.img;
      if (!body.text && !body.image) return;
      var btn = $("#ibxSend"); btn.disabled = true;
      var tid = S.cur.threadId;
      api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(tid) + "/send", { method: "POST", body: body }).then(function () {
        $("#ibxText").value = ""; S.img = null; renderImg();
        // Tin mới tự về qua realtime; phòng khi mất kết nối realtime thì tải lại sau 2 giây
        setTimeout(function () { if (S.cur && S.cur.threadId === tid) api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(tid) + "/messages?limit=50").then(function (j) { if (S.cur && S.cur.threadId === tid && (j.messages || []).length !== S.msgs.length) { S.msgs = j.messages; renderMsgs(false); } }).catch(function () {}); }, 2000);
      }).catch(function (e) { toast(e.message, true); }).then(function () { btn.disabled = false; $("#ibxText").focus(); });
    }
    function connectEs() {
      stopEs();
      if (!window.EventSource) return;
      var es = new EventSource("/v1/inbox/events"); S.es = es;
      es.addEventListener("message", function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.channelId !== S.ch) return;
        var isCur = S.cur && S.cur.threadId === d.thread.threadId;
        if (isCur) {
          if (!S.msgs.some(function (x) { return x.id === d.message.id; })) {
            S.msgs.push(d.message);
            var box = $("#ibxMsgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
            box.appendChild(msgEl(d.message)); if (atBottom || d.message.direction === "out") box.scrollTop = box.scrollHeight;
          }
          if (d.message.direction === "in" && document.visibilityState === "visible") { api("/v1/inbox/" + S.ch + "/threads/" + encodeURIComponent(d.thread.threadId) + "/read", { method: "POST", body: {} }).catch(function () {}); d.thread.unreadCount = 0; }
          S.cur = d.thread; renderHead();
        }
        if (!S.filter) mergeThread(d.thread);
      });
      es.addEventListener("thread", function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.channelId !== S.ch) return;
        for (var i = 0; i < S.threads.length; i++) if (S.threads[i].threadId === d.thread.threadId) { S.threads[i] = d.thread; }
        renderThreads();
        if (S.cur && S.cur.threadId === d.thread.threadId) { S.cur = d.thread; renderHead(); }
      });
      es.addEventListener("message_update", function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.channelId !== S.ch || !S.cur || S.cur.threadId !== d.threadId) return;
        S.msgs.forEach(function (x) { if (x.id === d.message.id) { x.canReact = d.message.canReact; x.meta = d.message.meta; } });
      });
      es.addEventListener("reaction", function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.channelId !== S.ch || !S.cur || S.cur.threadId !== d.threadId) return;
        S.msgs.forEach(function (x) { if (x.msgId === d.msgId) { x.reactions = d.reactions; replaceMsg(x); } });
      });
      es.addEventListener("contacts", function (ev) { var d; try { d = JSON.parse(ev.data); } catch (e) { return; } if (d.channelId === S.ch) toast("Đã đồng bộ " + d.count + " liên hệ/nhóm"); });
    }
    var qTimer = null;
    $("#ibxQ").oninput = function () { var v = this.value.trim(); clearTimeout(qTimer); qTimer = setTimeout(function () { S.filter = v; loadThreads(); }, 300); };
    $("#ibxKind").onchange = function () { S.kind = this.value; loadThreads(); };
    $("#ibxCh").onchange = function () { S.ch = this.value; S.cur = null; S.msgs = []; renderStatus(); renderHead(); $("#ibxMsgs").innerHTML = ""; $("#ibxCompose").style.display = "none"; loadThreads(); };
    $("#ibxSync").onclick = function () {
      var b = this; b.disabled = true;
      api("/v1/inbox/" + S.ch + "/sync-contacts", { method: "POST", body: {} })
        .then(function (j) { toast("Đã đồng bộ " + j.friends + " bạn bè, " + j.groups + " nhóm"); setTimeout(loadThreads, 1500); })
        .catch(function (e) { toast(e.message, true); }).then(function () { b.disabled = false; });
    };
    $("#ibxSet").onclick = function () {
      var c = chInfo(); if (!c) return;
      var dlg = el("dialog", { style: "width:460px;padding:20px" });
      dlg.innerHTML = "<h3 style='margin:0 0 8px'>Cài đặt Inbox — " + esc(c.name) + "</h3>" +
        '<label style="display:flex;gap:8px;align-items:center;opacity:1;font-size:.9rem"><input type="checkbox" id="isOn" style="width:auto"> Lưu nội dung tin nhắn (bật Inbox)</label>' +
        '<div class="muted" style="margin:4px 0 10px">Tắt thì tin mới không được lưu/hiện trong Inbox (tin cũ giữ nguyên). Lưu ý: bật là lưu cả tin riêng tư của tài khoản Zalo này.</div>' +
        '<label>AI tạm im bao nhiêu phút sau khi nhân viên trả lời (0 = không tạm dừng)</label><input id="isPause" type="number" min="0" max="1440" style="width:120px">' +
        '<label style="margin-top:14px">Tự thả cảm xúc khi khách nhắn (cá nhân + nhóm)</label><select id="isAutoRx" style="width:200px"><option value="off">Tắt</option><option value="heart">❤️ Thả tim</option><option value="like">👍 Thích</option></select>' +
        '<div class="muted" style="margin:4px 0 0">Thả vào tin cuối mỗi đợt khách nhắn, sau 1–4 giây. Nhóm đông người nhắn nhiều thì tài khoản thả rất nhiều — nền tảng có thể giới hạn tài khoản.</div>' +
        '<label style="display:flex;gap:8px;align-items:center;opacity:1;font-size:.9rem;margin-top:14px"><input type="checkbox" id="isMcpRead" style="width:auto"> Cho ứng dụng AI bên ngoài (MCP) đọc hội thoại và nội dung tin nhắn</label>' +
        '<div class="muted" style="margin:4px 0 0">Mặc định TẮT. Bật thì Claude/ChatGPT… đã kết nối (và được cấp quyền đọc tin nhắn) xem được danh sách hội thoại, toàn bộ lịch sử tin nhắn cá nhân + nhóm của kênh này, tìm kiếm trong tin nhắn để làm báo cáo và trả lời vào hội thoại.</div>' +
        '<div class="dialog-actions"><button class="ghost" id="isX">Hủy</button><button id="isOk">Lưu</button></div>';
      document.body.appendChild(dlg);
      $("#isOn", dlg).checked = !!c.inbox; $("#isPause", dlg).value = c.pauseMinutes; $("#isMcpRead", dlg).checked = !!c.mcpReadMessages; $("#isAutoRx", dlg).value = c.autoReaction || "off";
      $("#isX", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#isOk", dlg).onclick = function () {
        api("/v1/inbox/" + c.id + "/settings", { method: "PUT", body: { enabled: $("#isOn", dlg).checked, pauseMinutes: Number($("#isPause", dlg).value) || 0, mcpReadMessages: $("#isMcpRead", dlg).checked, autoReaction: $("#isAutoRx", dlg).value } })
          .then(function (j) { c.inbox = j.enabled; c.pauseMinutes = j.pauseMinutes; c.mcpReadMessages = j.mcpReadMessages; c.autoReaction = j.autoReaction; renderStatus(); dlg.close(); dlg.remove(); toast("Đã lưu"); })
          .catch(function (e) { toast(e.message, true); });
      };
      dlg.showModal();
    };
    $("#ibxNew").onclick = function () {
      var dlg = el("dialog", { style: "width:480px;padding:20px" });
      dlg.innerHTML = "<h3 style='margin:0 0 8px'>Nhắn tin mới</h3>" +
        '<label>Gửi tới</label><select id="nwBy" style="width:100%"><option value="phone">Số điện thoại</option><option value="uid">uid cá nhân (mã hội thoại)</option><option value="group">ID nhóm</option></select>' +
        '<label id="nwLbl">Số điện thoại</label><input id="nwTo" style="width:100%" placeholder="0912345678">' +
        '<label>Nội dung</label><textarea id="nwText" rows="4" style="width:100%"></textarea>' +
        '<label>Ảnh (không bắt buộc)</label><input id="nwFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp">' +
        '<div id="nwMsg" style="margin-top:8px"></div><div class="dialog-actions"><button class="ghost" id="nwX">Hủy</button><button id="nwOk">Gửi</button></div>';
      document.body.appendChild(dlg);
      var img = null;
      $("#nwBy", dlg).onchange = function () { $("#nwLbl", dlg).textContent = this.value === "phone" ? "Số điện thoại" : this.value === "uid" ? "uid cá nhân" : "ID nhóm"; };
      $("#nwFile", dlg).onchange = function () { var f = this.files[0]; if (!f) { img = null; return; } var r = new FileReader(); r.onload = function () { img = r.result; }; r.readAsDataURL(f); };
      $("#nwX", dlg).onclick = function () { dlg.close(); dlg.remove(); };
      $("#nwOk", dlg).onclick = function () {
        var by = $("#nwBy", dlg).value, to = $("#nwTo", dlg).value.trim(), body = {};
        if (by === "phone" || to.indexOf("@") < 0) to = to.replace(/[ .-]/g, "");
        if (by === "phone") body.phone = to; else { body.to = to; body.peerKind = by === "group" ? "group" : "direct"; }
        if ($("#nwText", dlg).value.trim()) body.text = $("#nwText", dlg).value;
        if (img) body.image = img;
        $("#nwOk", dlg).disabled = true;
        api("/v1/inbox/" + S.ch + "/new", { method: "POST", body: body }).then(function (j) {
          dlg.close(); dlg.remove(); toast("Đã gửi");
          setTimeout(function () { api("/v1/inbox/" + S.ch + "/threads?limit=200").then(function (r) { S.threads = r.threads || []; renderThreads(); var t = S.threads.filter(function (x) { return x.threadId === j.threadId; })[0]; if (t) openThread(t); }); }, 1200);
        }).catch(function (e) { $("#nwOk", dlg).disabled = false; $("#nwMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
      };
      dlg.showModal();
    };

    api("/v1/inbox/channels").then(function (j) {
      S.channels = j.channels || []; S.canManage = !!j.canManage; state.inboxChannels = S.channels;
      var sel = $("#ibxCh");
      if (!S.channels.length) {
        wrap.innerHTML = '<div class="card">' + (isMember() ? "Bạn chưa được gán trực kênh nào — nhờ quản trị vào Người dùng → Sửa → tick kênh." : 'Chưa có kênh Zalo cá nhân / WhatsApp cá nhân. Vào <a href="#/channels">Channels</a> → ＋ Thêm kênh → chọn <b>zalo_personal</b> hoặc <b>whatsapp_personal</b> → Kết nối QR.') + "</div>";
        top.style.display = "none"; return;
      }
      sel.innerHTML = S.channels.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + " · " + esc(c.platform || "Zalo") + "</option>"; }).join("");
      var saved = null; try { saved = localStorage.getItem("penai_ibx_ch"); } catch (e) {}
      S.ch = S.channels.some(function (c) { return c.id === saved; }) ? saved : S.channels[0].id;
      sel.value = S.ch;
      sel.addEventListener("change", function () { try { localStorage.setItem("penai_ibx_ch", S.ch); } catch (e) {} });
      renderStatus(); loadThreads(); connectEs();
    }).catch(function (e) { wrap.innerHTML = '<div class="card err">' + esc(e.message) + "</div>"; });
  };

  // ===== Kết nối AI bên ngoài: PenAI MCP server (Claude, ChatGPT… gọi vào) =====
  PAGES.mcpserver = function () {
    var m = page("Kết nối AI bên ngoài (MCP)", "Cho Claude, ChatGPT, Cursor… (hoặc chính " + BRAND.name + ") gửi tin nhắn/ảnh Zalo cá nhân, WhatsApp cá nhân và tra danh bạ qua giao thức MCP");
    var c1 = card(m, "Địa chỉ MCP"), c2 = card(m, "Các kết nối đã cấp quyền"), c3 = card(m, "Lượt gửi gần đây qua MCP");
    function load() {
      api("/v1/mcp-server").then(function (j) {
        if (!j.enabled) { c1.innerHTML = '<h3>Địa chỉ MCP</h3><span class="err">Chưa bật: máy chủ thiếu PENAI_PUBLIC_URL trong penai.env.</span>'; }
        else {
          c1.innerHTML = '<h3>Địa chỉ MCP</h3><div class="row"><code id="msUrl" style="font-size:.95rem;padding:6px 10px">' + esc(j.url) + '</code><button class="ghost sm" id="msCopy">Sao chép</button></div>' +
            '<ol class="muted" style="margin:10px 0 0;padding-left:18px;line-height:1.7">' +
            "<li><b>Claude</b> (claude.ai / Claude Desktop): Settings → Connectors → Add custom connector → dán địa chỉ trên → Connect.</li>" +
            "<li><b>ChatGPT</b>: Settings → Apps &amp; Connectors → Advanced → bật Developer mode → Create → dán địa chỉ, chọn OAuth.</li>" +
            "<li><b>" + esc(BRAND.name) + "</b> (cho agent dùng): trang <a href='#/mcp'>MCP</a> → Thêm → transport http, URL là địa chỉ trên → Đăng nhập OAuth.</li>" +
            "<li>Trình duyệt mở trang cấp quyền của " + esc(BRAND.name) + ": đăng nhập bằng tài khoản Dashboard, chọn quyền (xem danh bạ / gửi tin) → Cấp quyền.</li></ol>" +
            '<div class="muted" style="margin-top:8px">Công cụ: zalo_list_channels, zalo_list_contacts, zalo_list_groups, zalo_find_user_by_phone, zalo_send_message (theo uid, kèm ảnh — cũng để trả lời vào hội thoại), zalo_send_message_by_phone, zalo_react_latest / zalo_react_message (thả cảm xúc). Kênh WhatsApp cá nhân có bộ công cụ tương ứng tên whatsapp_… (kết nối tạo trước bản 1.9.0 cần kết nối lại để được cấp quyền WhatsApp). Quyền theo tài khoản: Vận hành trở lên dùng mọi kênh; Thành viên chỉ kênh được gán.</div>' +
            '<div style="margin-top:10px"><b>Đọc hội thoại + nội dung tin nhắn</b> (zalo_list_conversations, zalo_get_messages, zalo_search_messages): mặc định TẮT, quản trị bật riêng từng kênh ở Inbox → ⚙️ Cài đặt; kết nối phải được cấp quyền <code>zalo:messages</code> (kết nối cũ cần kết nối lại).<div style="margin-top:4px">' +
            (j.channels || []).map(function (c) { return '<span class="pill' + (c.mcpReadMessages ? " ok" : "") + '" style="margin-right:4px">' + esc(c.name) + ": " + (c.mcpReadMessages ? "đang BẬT" : "tắt") + "</span>"; }).join("") + "</div></div>";
          $("#msCopy").onclick = function () { try { navigator.clipboard.writeText(j.url); toast("Đã sao chép"); } catch (e) {} };
        }
        c2.innerHTML = "<h3>Các kết nối đã cấp quyền</h3>";
        c2.appendChild(table(["Ứng dụng", "Người cấp", "Quyền", "Cấp lúc", "Dùng gần nhất", ""], j.connections, function (g) {
          var tr = el("tr");
          tr.innerHTML = "<td>" + esc(g.clientName) + '<div class="muted" style="font-size:.75rem">' + esc(g.redirectOrigins.join(", ")) + "</div></td><td>" + esc(g.userName || g.userEmail) + "</td><td>" + g.scopes.map(function (s) { return '<span class="pill">' + esc(s) + "</span>"; }).join(" ") +
            "</td><td class='muted'>" + esc(ibxTime(g.createdAt)) + "</td><td class='muted'>" + esc(g.lastUsedAt ? ibxTime(g.lastUsedAt) : "chưa") + "</td>";
          var td = el("td");
          if (g.revokedAt) td.innerHTML = '<span class="muted">đã thu hồi</span>';
          else { var b = el("button", { "class": "ghost sm" }, "Thu hồi"); b.onclick = function () { if (confirm("Thu hồi kết nối " + g.clientName + "?")) api("/v1/mcp-server/connections/" + g.id, { method: "DELETE" }).then(function () { toast("Đã thu hồi"); load(); }).catch(function (e) { toast(e.message, true); }); }; td.appendChild(b); }
          tr.appendChild(td); return tr;
        }));
        c3.innerHTML = "<h3>Lượt gửi gần đây qua MCP</h3>";
        c3.appendChild(table(["Lúc", "Ứng dụng", "Công cụ", "Người nhận", "Kết quả"], j.activity, function (a) {
          var tr = el("tr");
          tr.innerHTML = "<td class='muted'>" + esc(ibxTime(a.createdAt)) + "</td><td>" + esc(a.clientName) + "</td><td><code>" + esc(a.tool) + "</code></td><td><code>" + esc(a.recipient) + "</code></td><td>" + (a.status === "sent" ? '<span class="ok">đã gửi</span>' : a.status === "failed" ? '<span class="err">lỗi</span>' : '<span class="pill">' + esc(a.status) + "</span>") + "</td>";
          return tr;
        }));
      }).catch(function (e) { c1.innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    }
    load();
  };

  // ===== Router =====
  function refreshAgents() { return api("/v1/agents").then(function (j) { state.agents = j.agents; }).catch(function () {}); }
  function route() {
    if (!state.me) { showLogin(); return; }
    if (state.pageCleanup) { try { state.pageCleanup(); } catch (e) {} state.pageCleanup = null; }
    renderNav();
    var id = location.hash.replace("#/", "") || (isMember() ? "chat" : "overview");
    var qi = id.indexOf("?"); state.routeQuery = qi >= 0 ? id.slice(qi + 1) : ""; if (qi >= 0) id = id.slice(0, qi);
    if (isMember() && !(id === "inbox" && (state.inboxChannels || []).length)) id = "chat";
    var n = null; for (var i = 0; i < NAV.length; i++) if (NAV[i].id === id) n = NAV[i];
    if (n && n.admin && !isAdmin()) id = "overview";
    var fn = PAGES[id] || PAGES.overview;
    try { fn(); } catch (e) { $("#main").innerHTML = '<div class="card err">Lỗi render: ' + esc(e.message) + "</div>"; }
  }
  window.addEventListener("hashchange", route);

  // ===== Đăng nhập / phiên (0024) =====
  function showLogin(msg) {
    state.me = null; state.agents = []; state.sessionId = null;
    document.body.classList.remove("authed");
    var v = $("#loginView"); v.hidden = false;
    var err = $("#loginErr"); if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
    setTimeout(function () { ($("#loginEmail").value ? $("#loginPass") : $("#loginEmail")).focus(); }, 50);
  }
  function renderUser() {
    var me = state.me; if (!me) return;
    var nm = (me.user && me.user.name) || (me.user && me.user.email) || "?";
    var ini = nm.trim().split(/\\s+/).slice(-1)[0].charAt(0).toUpperCase() || "?";
    $("#userBadge").innerHTML = '<span class="avatar">' + esc(ini) + '</span><span><div class="nm">' + esc(nm) + '</div><div><span class="role-pill">' + esc(me.roleLabel || me.role) + "</span></div></span>";
    $("#wsinfo").textContent = me.workspace && me.workspace.name ? "Workspace: " + me.workspace.name : "";
    $("#btnPass").style.display = me.authKind === "web" ? "" : "none";
  }
  function enterApp(me) {
    state.me = me;
    document.body.classList.add("authed");
    $("#loginView").hidden = true;
    renderUser();
    if (me.mustChangePassword) { openChangePassword(true); }
    var inboxLoad = api("/v1/inbox/channels").then(function (j) { state.inboxChannels = j.channels || []; }).catch(function () { state.inboxChannels = []; });
    return Promise.all([refreshAgents(), inboxLoad]).then(function () { route(); });
  }
  function openChangePassword(forced) {
    var dlg = el("dialog", { style: "width:420px;padding:20px" });
    dlg.innerHTML = "<h3 style='margin:0 0 6px'>Đổi mật khẩu</h3>" +
      (forced ? '<div class="muted" style="margin-bottom:6px">Bạn cần đặt mật khẩu mới trước khi sử dụng.</div>' : "") +
      '<label>Mật khẩu hiện tại</label><input id="cpCur" type="password" style="width:100%" autocomplete="current-password">' +
      '<label>Mật khẩu mới (≥ 8 ký tự)</label><input id="cpNew" type="password" style="width:100%" autocomplete="new-password">' +
      '<label>Nhập lại mật khẩu mới</label><input id="cpNew2" type="password" style="width:100%" autocomplete="new-password">' +
      '<div class="dialog-actions">' + (forced ? '<button class="ghost" id="cpLogout">Đăng xuất</button>' : '<button class="ghost" id="cpCancel">Hủy</button>') + '<button id="cpSave">Đổi mật khẩu</button></div><div id="cpMsg" style="margin-top:8px"></div>';
    document.body.appendChild(dlg);
    if (forced) { dlg.addEventListener("cancel", function (e) { e.preventDefault(); }); $("#cpLogout", dlg).onclick = function () { dlg.close(); dlg.remove(); doLogout(); }; }
    else $("#cpCancel", dlg).onclick = function () { dlg.close(); dlg.remove(); };
    $("#cpSave", dlg).onclick = function () {
      var cur = $("#cpCur", dlg).value, nw = $("#cpNew", dlg).value, nw2 = $("#cpNew2", dlg).value;
      if (nw.length < 8) { $("#cpMsg", dlg).innerHTML = '<span class="err">Mật khẩu mới tối thiểu 8 ký tự</span>'; return; }
      if (nw !== nw2) { $("#cpMsg", dlg).innerHTML = '<span class="err">Hai mật khẩu mới không khớp</span>'; return; }
      $("#cpSave", dlg).disabled = true;
      api("/auth/change-password", { method: "POST", body: { currentPassword: cur, newPassword: nw } })
        .then(function () { dlg.close(); dlg.remove(); toast("Đã đổi mật khẩu"); if (state.me) { state.me.mustChangePassword = false; route(); } })
        .catch(function (e) { $("#cpSave", dlg).disabled = false; $("#cpMsg", dlg).innerHTML = '<span class="err">' + esc(e.message) + "</span>"; });
    };
    dlg.showModal();
  }
  function doLogout() {
    api("/auth/logout", { method: "POST" }).catch(function () {}).then(function () { location.hash = ""; showLogin(); });
  }

  $("#loginForm").onsubmit = function (e) {
    e.preventDefault();
    var btn = $("#loginBtn"); btn.disabled = true; btn.textContent = "Đang đăng nhập…"; $("#loginErr").hidden = true;
    api("/auth/login", { method: "POST", body: { email: $("#loginEmail").value.trim(), password: $("#loginPass").value } })
      .then(function (me) { $("#loginPass").value = ""; me.authKind = "web"; return enterApp(me); })
      .catch(function (err) { var box = $("#loginErr"); box.textContent = err.message; box.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = "Đăng nhập"; });
  };
  $("#loginEye").onclick = function () { var i = $("#loginPass"); i.type = i.type === "password" ? "text" : "password"; };
  $("#btnLogout").onclick = doLogout;
  $("#btnPass").onclick = function () { openChangePassword(false); };

  // init: hỏi server "tôi là ai" bằng cookie; 401 → màn hình đăng nhập
  api("/auth/me").then(function (me) { return enterApp(me); }).catch(function () { showLogin(); });
})();
</script>
</body>
</html>
`;
