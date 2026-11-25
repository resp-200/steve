/**
 * Steve 管理后台单页（steve-serve 的 /admin 视图，由后端原样返回本字符串）。
 *
 * 约束：
 * - 无任何外部资源：纯 HTML + CSS + 原生 JS，图标用 emoji / 内联样式。
 * - 整个页面是 TS 模板字符串常量，因此内部 JS 不使用反引号与美元花括号插值，
 *   字符串拼接一律用双引号加号拼接；CSS 中同样不出现反引号。
 * - 后端不会做占位符替换，所有数据都通过 /admin/api/* 动态获取。
 */
export const ADMIN_PAGE: string = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Steve 管理后台</title>
<script>
(function () {
  try {
    var stored = localStorage.getItem("steve-admin-theme");
    if (stored !== "light" && stored !== "dark") {
      stored = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.dataset.theme = stored;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
</script>
<style>
:root {
  color-scheme: light;
  --bg: #f4f6f9;
  --bg-elevated: #ffffff;
  --bg-subtle: #f0f3f7;
  --bg-sidebar: #fbfcfd;
  --bg-hover: #eef2f7;
  --text: #18202b;
  --text-muted: #5b6878;
  --text-faint: #8b97a6;
  --border: #e3e8ef;
  --border-strong: #ccd5df;
  --primary: #2f6feb;
  --primary-hover: #255cc7;
  --primary-soft: #e8f0fe;
  --danger: #d64040;
  --danger-hover: #b83434;
  --danger-soft: #fdecec;
  --success: #178a57;
  --success-soft: #e5f6ee;
  --warning: #a86a12;
  --warning-soft: #fdf3e1;
  --shadow: 0 1px 2px rgba(20, 31, 45, 0.05), 0 6px 20px rgba(20, 31, 45, 0.06);
  --shadow-lg: 0 12px 40px rgba(20, 31, 45, 0.18);
  --radius: 10px;
  --radius-sm: 8px;
  --topbar-h: 56px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0d1117;
  --bg-elevated: #151b23;
  --bg-subtle: #1a2230;
  --bg-sidebar: #11161d;
  --bg-hover: #1e2735;
  --text: #e6edf5;
  --text-muted: #9dabb9;
  --text-faint: #6f7d8c;
  --border: #232d3a;
  --border-strong: #344153;
  --primary: #5a9bff;
  --primary-hover: #7fb2ff;
  --primary-soft: #182a45;
  --danger: #f47373;
  --danger-hover: #ff8d8d;
  --danger-soft: #351b1f;
  --success: #57c98d;
  --success-soft: #122b1f;
  --warning: #e2b04a;
  --warning-soft: #2f2611;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 8px 28px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.55);
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
[hidden] { display: none !important; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3, p { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
::selection { background: var(--primary-soft); color: var(--text); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

/* ---------- 顶栏 ---------- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--topbar-h);
  padding: 0 18px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--primary), #7b5cff);
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.brand-name { font-size: 15px; font-weight: 650; letter-spacing: 0.01em; white-space: nowrap; }
.brand-ver {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
}
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); padding: 0 4px; white-space: nowrap; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); transition: background 0.2s, box-shadow 0.2s; }
.conn[data-state="ok"] .conn-dot { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.conn[data-state="bad"] .conn-dot { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.icon-btn {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border-strong); }
.nav-toggle { display: none; }

/* ---------- 错误条 ---------- */
.error-bar {
  position: sticky;
  top: var(--topbar-h);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px;
  background: var(--danger-soft);
  color: var(--danger);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.error-bar .msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.error-bar button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 6px;
}
.error-bar button:hover { background: rgba(128, 128, 128, 0.15); }

/* ---------- 布局 ---------- */
.shell { display: flex; align-items: flex-start; min-height: calc(100vh - var(--topbar-h)); }
.sidebar {
  position: sticky;
  top: var(--topbar-h);
  flex: 0 0 214px;
  width: 214px;
  height: calc(100vh - var(--topbar-h));
  overflow-y: auto;
  padding: 16px 10px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
.nav-group-label { font-size: 11px; color: var(--text-faint); letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 12px 8px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13.5px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; }
.nav-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.nav-icon { width: 18px; text-align: center; font-size: 15px; }
.nav-foot { margin-top: 18px; padding: 10px 12px; font-size: 11px; color: var(--text-faint); border-top: 1px solid var(--border); line-height: 1.6; }
.main { flex: 1 1 auto; min-width: 0; width: 100%; max-width: 1240px; margin: 0 auto; padding: 24px 28px 64px; }
.scrim { display: none; }

/* ---------- 页面与卡片 ---------- */
.view { animation: viewIn 0.18s ease-out; }
@keyframes viewIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.page-title { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
.page-desc { margin-top: 4px; color: var(--text-muted); font-size: 13px; max-width: 760px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.card-pad { padding: 18px 20px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.card-title { font-size: 14.5px; font-weight: 650; }
.card-sub { font-size: 12.5px; color: var(--text-muted); margin-top: 3px; }
.mt { margin-top: 16px; }
.stack { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.small { font-size: 12px; }
.mono { font-family: var(--mono); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 12px; }
.stat { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px; min-width: 0; }
.stat-label { font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-faint); }
.stat-value { margin-top: 6px; font-size: 16px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.stat-value.mono { font-family: var(--mono); font-size: 14px; font-weight: 500; }
.stat-value.small { font-size: 13px; font-weight: 500; }
.stat-hint { margin-top: 4px; font-size: 11.5px; color: var(--text-faint); overflow-wrap: anywhere; }
.stat-wide { grid-column: span 2; }
@media (max-width: 560px) { .stat-wide { grid-column: auto; } }

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 16px;
  padding: 11px 14px;
  border-radius: var(--radius);
  background: var(--primary-soft);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 13px;
}
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 11px 14px;
  margin-bottom: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  font-size: 13px;
}
.banner.warn { background: var(--warning-soft); color: var(--warning); }
.banner .spacer { flex: 1; }

/* ---------- 徽标 ---------- */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.7;
  white-space: nowrap;
}
.badge.ok { background: var(--success-soft); color: var(--success); }
.badge.warn { background: var(--warning-soft); color: var(--warning); }
.badge.danger { background: var(--danger-soft); color: var(--danger); }
.badge.info { background: var(--primary-soft); color: var(--primary); }
.badge.muted { background: var(--bg-subtle); color: var(--text-muted); }

/* ---------- 按钮 ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s;
}
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn.primary { background: var(--primary); color: #ffffff; }
.btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn.secondary { background: var(--bg-elevated); border-color: var(--border-strong); color: var(--text); }
.btn.secondary:hover:not(:disabled) { background: var(--bg-hover); }
.btn.danger { background: var(--danger); color: #ffffff; }
.btn.danger:hover:not(:disabled) { background: var(--danger-hover); }
.btn.ghost { color: var(--text-muted); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.btn.small { height: 28px; padding: 0 10px; font-size: 12px; }

/* ---------- 表格 ---------- */
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); box-shadow: var(--shadow); }
table.data { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 680px; }
table.data th {
  text-align: left;
  padding: 10px 14px;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
  font-weight: 600;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
table.data td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.data tbody tr:nth-child(even) { background: var(--bg-subtle); }
table.data tbody tr:hover { background: var(--bg-hover); }
table.data tbody tr:last-child td { border-bottom: 0; }
.cell-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.cell-strong { font-weight: 600; }
.cell-mono { font-family: var(--mono); font-size: 12px; }
.empty, .loading { padding: 28px 16px; text-align: center; color: var(--text-faint); font-size: 13px; }
.hint-line { margin-top: 8px; font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); }

/* ---------- 表单 ---------- */
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
.radio-row { display: flex; flex-wrap: wrap; gap: 10px 22px; padding-top: 4px; }
.radio { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; color: var(--text); cursor: pointer; }
.radio input { accent-color: var(--accent); width: 15px; height: 15px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field.full { grid-column: 1 / -1; }
.field label { font-size: 12px; font-weight: 600; color: var(--text-muted); }
.field .hint { font-size: 11.5px; color: var(--text-faint); }
input[type="text"], input[type="password"], input[type="url"], select, textarea {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 8px 11px;
  font-size: 13px;
  color: var(--text);
  min-height: 36px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
textarea { min-height: 96px; resize: vertical; line-height: 1.55; }
textarea.mono, input.mono, select.mono { font-family: var(--mono); font-size: 12.5px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--text); cursor: pointer; }
.check input { width: 16px; height: 16px; min-height: 0; accent-color: var(--primary); flex: 0 0 auto; }
.check-inline { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.check-inline input { width: 15px; height: 15px; accent-color: var(--primary); }
.form-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
@media (max-width: 720px) { .form-grid { grid-template-columns: 1fr; } }

/* ---------- 详情键值 ---------- */
.kv-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 24px; }
.kv { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.kv-key { color: var(--text-muted); flex: 0 0 auto; }
.kv-val { text-align: right; overflow-wrap: anywhere; font-weight: 550; }

/* ---------- 网关计划卡片 ---------- */
.planned-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
.planned { border: 1px dashed var(--border-strong); border-radius: var(--radius); padding: 16px; background: var(--bg-subtle); opacity: 0.75; }
.planned h3 { font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.planned p { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.danger-zone { border-style: dashed; }

/* ---------- 代码预览 ---------- */
pre.code {
  margin: 0;
  padding: 14px 16px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  max-height: 440px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* ---------- 登录 ---------- */
.login-wrap {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(9, 13, 19, 0.55);
}
.login-card {
  width: 100%;
  max-width: 380px;
  padding: 26px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
}
.login-icon { font-size: 26px; }
.login-card h2 { font-size: 17px; font-weight: 650; margin: 10px 0 4px; }
.login-card p { font-size: 12.5px; color: var(--text-muted); margin-bottom: 16px; }
.login-card .btn { width: 100%; margin-top: 12px; }

/* ---------- Toast ---------- */
.toasts {
  position: fixed;
  top: calc(var(--topbar-h) + 12px);
  right: 16px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
  color: var(--text);
  overflow-wrap: anywhere;
  animation: toastIn 0.18s ease-out;
}
.toast.ok { border-left-color: var(--success); }
.toast.err { border-left-color: var(--danger); }
.toast.out { opacity: 0; transform: translateX(8px); transition: opacity 0.2s, transform 0.2s; }
@keyframes toastIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.spin { display: inline-block; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- 移动端 ---------- */
@media (max-width: 880px) {
  .nav-toggle { display: inline-grid; }
  .brand-ver { display: none; }
  .sidebar {
    position: fixed;
    left: 0;
    top: var(--topbar-h);
    bottom: 0;
    height: auto;
    z-index: 35;
    transform: translateX(-102%);
    transition: transform 0.2s ease;
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open { transform: translateX(0); }
  .scrim {
    display: block;
    position: fixed;
    left: 0;
    right: 0;
    top: var(--topbar-h);
    bottom: 0;
    z-index: 34;
    background: rgba(8, 12, 18, 0.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .scrim.open { opacity: 1; pointer-events: auto; }
  .main { padding: 18px 16px 56px; }
  .conn-text { display: none; }
  .topbar { padding: 0 12px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">
      <button type="button" class="icon-btn nav-toggle" id="navToggle" aria-label="展开或收起导航" aria-expanded="false">☰</button>
      <span class="brand-mark" aria-hidden="true">S</span>
      <span class="brand-name">Steve 管理后台</span>
      <span class="brand-ver" id="brandVersion" title="当前服务版本">v—</span>
    </div>
    <div class="topbar-actions">
      <span class="conn" id="connStatus" data-state="idle"><span class="conn-dot" aria-hidden="true"></span><span class="conn-text" id="connText">连接中…</span></span>
      <button type="button" class="icon-btn" id="themeToggle" title="切换主题" aria-label="切换主题">🌙</button>
      <button type="button" class="icon-btn" id="refreshBtn" title="刷新当前页面" aria-label="刷新当前页面"><span id="refreshGlyph">⟳</span></button>
    </div>
  </header>

  <div class="error-bar" id="errorBar" hidden role="alert">
    <span aria-hidden="true">⚠️</span>
    <span class="msg" id="errorText"></span>
    <button type="button" id="errorClose" aria-label="关闭错误提示">✕</button>
  </div>

  <div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="主导航">
      <div class="nav-group-label">管理</div>
      <nav class="nav">
        <a class="nav-item" href="#overview" data-view="overview"><span class="nav-icon" aria-hidden="true">📊</span><span>概览</span></a>
        <a class="nav-item" href="#providers" data-view="providers"><span class="nav-icon" aria-hidden="true">🧠</span><span>模型供应商</span></a>
        <a class="nav-item" href="#gateways" data-view="gateways"><span class="nav-icon" aria-hidden="true">🌉</span><span>网关</span></a>
        <a class="nav-item" href="#schedules" data-view="schedules"><span class="nav-icon" aria-hidden="true">⏰</span><span>定时任务</span></a>
        <a class="nav-item" href="#system" data-view="system"><span class="nav-icon" aria-hidden="true">⚙️</span><span>系统</span></a>
      </nav>
      <div class="nav-foot">Steve 管理后台<br>本地运维控制面 · Token 保护</div>
    </aside>
    <div class="scrim" id="scrim"></div>
    <main class="main" id="main">
      <div class="banner warn" id="restartBanner" hidden>
        <span aria-hidden="true">⚠️</span>
        <span>配置已修改，需重启服务生效。</span>
        <span class="spacer"></span>
        <button type="button" class="btn secondary small" id="restartBannerBtn">立即重启</button>
      </div>

      <!-- 概览 -->
      <section class="view" id="view-overview">
        <div class="page-head">
          <div>
            <h1 class="page-title">概览</h1>
            <p class="page-desc">服务运行状态与关键配置一览，每 5 秒自动刷新。</p>
          </div>
        </div>
        <div class="card-grid" id="overviewGrid">
          <div class="stat"><div class="stat-label">加载中</div><div class="stat-value small">正在读取 overview…</div></div>
        </div>
        <div class="notice">
          <span aria-hidden="true">📡</span>
          <span>最近事件流：前往 <a href="/streams" target="_blank" rel="noopener">/streams</a> 查看（JSON）。</span>
        </div>
      </section>

      <!-- 模型供应商 -->
      <section class="view" id="view-providers" hidden>
        <div class="page-head">
          <div>
            <h1 class="page-title">模型供应商</h1>
            <p class="page-desc">管理模型接入端点。保存、删除或切换激活供应商后，需要重启 Steve 服务才会生效。</p>
          </div>
          <div class="page-actions">
            <button type="button" class="btn primary" id="providerNewBtn">＋ 新增供应商</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>默认模型</th>
                <th>可用模型</th>
                <th>思考</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="providerRows">
              <tr><td colspan="7"><div class="loading">加载中…</div></td></tr>
            </tbody>
          </table>
        </div>
        <div class="hint-line" id="providerSummary">加载中…</div>

        <div class="card card-pad mt" id="providerFormCard" hidden>
          <form id="providerForm" novalidate>
            <div class="card-head">
              <div>
                <div class="card-title" id="providerFormTitle">新增供应商</div>
                <div class="card-sub">API Key 仅保存在服务端配置中，不会回显。</div>
              </div>
              <button type="button" class="btn ghost small" id="providerCancelBtn">取消</button>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="pv-name">名称</label>
                <input id="pv-name" type="text" placeholder="例如 openai" autocomplete="off">
              </div>
              <div class="field">
                <label for="pv-baseUrl">Base URL</label>
                <input id="pv-baseUrl" type="text" placeholder="https://api.openai.com/v1" autocomplete="off">
              </div>
              <div class="field">
                <label for="pv-apiKey">API Key</label>
                <input id="pv-apiKey" type="password" placeholder="输入 API Key（可留空）" autocomplete="new-password">
              </div>
              <div class="field">
                <label for="pv-defaultModel">默认模型</label>
                <input id="pv-defaultModel" type="text" placeholder="例如 gpt-4.1" autocomplete="off">
              </div>
              <div class="field full">
                <label for="pv-models">可用模型</label>
                <textarea id="pv-models" class="mono" placeholder="逗号或换行分隔，例如 gpt-4.1, gpt-4.1-mini"></textarea>
                <span class="hint">逗号或换行分隔，保存时自动去重。</span>
              </div>
              <div class="field full">
                <label class="check"><input type="checkbox" id="pv-reasoning"> 开启思考（reasoning）</label>
              </div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn primary" id="providerSaveBtn">保存供应商</button>
              <span class="muted small">保存后需重启服务生效。</span>
            </div>
          </form>
        </div>
      </section>

      <!-- 网关 -->
      <section class="view" id="view-gateways" hidden>
        <div class="page-head">
          <div>
            <h1 class="page-title">网关</h1>
            <p class="page-desc">把事件流接入聊天网关。飞书机器人默认使用<b>长连接</b>接收事件，不需要公网回调地址；也可以切换为 HTTP 回调（<span class="mono">/feishu/events</span>，需要公网可访问地址）。</p>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-head">
            <div>
              <div class="card-title">飞书机器人 <span id="feishuStatus"></span></div>
              <div class="card-sub">配置变更保存后需重启服务生效；留空的字段表示保持不变。</div>
            </div>
          </div>
          <div class="kv-list" id="feishuDetails">
            <div class="loading">加载中…</div>
          </div>
          <form id="gatewayForm" novalidate>
            <div class="form-grid mt">
              <div class="field full">
                <label>事件接收方式</label>
                <div class="radio-row">
                  <label class="radio"><input type="radio" name="gw-mode" value="ws" checked> 长连接（推荐，无需公网地址）</label>
                  <label class="radio"><input type="radio" name="gw-mode" value="http"> HTTP 回调（需公网地址与 Verification Token）</label>
                </div>
              </div>
              <div class="field">
                <label for="gw-appId">App ID</label>
                <input id="gw-appId" type="text" placeholder="留空保持不变" autocomplete="off">
              </div>
              <div class="field">
                <label for="gw-appSecret">App Secret</label>
                <input id="gw-appSecret" type="password" placeholder="留空保持不变" autocomplete="new-password">
              </div>
              <div class="field">
                <label for="gw-verificationToken">Verification Token</label>
                <input id="gw-verificationToken" type="password" placeholder="留空保持不变" autocomplete="new-password">
              </div>
              <div class="field">
                <label for="gw-encryptKey">Encrypt Key（可选）</label>
                <input id="gw-encryptKey" type="password" placeholder="留空保持不变" autocomplete="new-password">
              </div>
              <div class="field full">
                <label for="gw-apiBase">API Base（可选，默认 https://open.feishu.cn）</label>
                <input id="gw-apiBase" type="text" class="mono" placeholder="https://open.feishu.cn">
              </div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn primary" id="gatewaySaveBtn">保存网关配置</button>
              <button type="button" class="btn secondary" id="gatewayClearBtn">清空该网关配置</button>
              <span class="muted small">保存后需重启服务生效。</span>
            </div>
          </form>
        </div>
        <div class="planned-grid">
          <div class="planned">
            <h3>💬 企业微信</h3>
            <p>规划中：企业微信机器人 / 应用消息接入。</p>
          </div>
          <div class="planned">
            <h3>🐧 QQ</h3>
            <p>规划中：QQ 机器人接入。</p>
          </div>
        </div>
      </section>

      <!-- 定时任务 -->
      <section class="view" id="view-schedules" hidden>
        <div class="page-head">
          <div>
            <h1 class="page-title">定时任务</h1>
            <p class="page-desc">定时任务 = cron 触发器 → 向目标流投递一条提示词 → 后台 run 执行；结果写入该流的事件日志，可在 <a href="/streams" target="_blank" rel="noopener">/streams</a> 查看或由网关转发。</p>
          </div>
          <div class="page-actions">
            <button type="button" class="btn primary" id="scheduleNewBtn">＋ 新增定时任务</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>名称</th>
                <th>cron</th>
                <th>时区</th>
                <th>目标流</th>
                <th>模式</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="scheduleRows">
              <tr><td colspan="6"><div class="loading">加载中…</div></td></tr>
            </tbody>
          </table>
        </div>
        <div class="hint-line" id="scheduleFile">配置文件：.steve/watch.json</div>

        <div class="card card-pad mt" id="scheduleFormCard" hidden>
          <form id="scheduleForm" novalidate>
            <div class="card-head">
              <div>
                <div class="card-title" id="scheduleFormTitle">新增定时任务</div>
                <div class="card-sub">cron 使用 5 段：分 时 日 月 周，例如 0 9 * * 1（每周一 09:00）。</div>
              </div>
              <button type="button" class="btn ghost small" id="scheduleCancelBtn">取消</button>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="sc-name">名称</label>
                <input id="sc-name" type="text" placeholder="例如 morning-brief" autocomplete="off">
                <span class="hint" id="scheduleNameHint">名称用于标识任务，保存后不可修改。</span>
              </div>
              <div class="field">
                <label for="sc-cron">cron（5 段）</label>
                <input id="sc-cron" type="text" class="mono" placeholder="0 9 * * 1" autocomplete="off">
                <span class="hint">分 时 日 月 周，例如 0 9 * * 1 表示每周一 09:00。</span>
              </div>
              <div class="field">
                <label for="sc-timezone">时区（可选）</label>
                <input id="sc-timezone" type="text" class="mono" placeholder="Asia/Shanghai" autocomplete="off">
              </div>
              <div class="field">
                <label for="sc-target">目标流（必填）</label>
                <input id="sc-target" type="text" class="mono" placeholder="12 位流 id 或自定义 token" autocomplete="off">
              </div>
              <div class="field">
                <label for="sc-mode">模式</label>
                <select id="sc-mode">
                  <option value="background">background（后台，默认）</option>
                  <option value="foreground">foreground（前台）</option>
                </select>
              </div>
              <div class="field full">
                <label for="sc-prompt">提示词</label>
                <textarea id="sc-prompt" placeholder="例如：总结今天的工作进展，并给出明天的建议。"></textarea>
              </div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn primary" id="scheduleSaveBtn">保存定时任务</button>
              <span class="muted small">保存后需重启服务生效。</span>
            </div>
          </form>
        </div>
      </section>

      <!-- 系统 -->
      <section class="view" id="view-system" hidden>
        <div class="page-head">
          <div>
            <h1 class="page-title">系统</h1>
            <p class="page-desc">运行时信息、日志设置与配置文件查看。</p>
          </div>
        </div>
        <div class="card-grid" id="systemGrid">
          <div class="stat"><div class="stat-label">加载中</div><div class="stat-value small">正在读取 system…</div></div>
        </div>
        <div class="stack">
          <div class="card card-pad">
            <div class="card-head">
              <div>
                <div class="card-title">日志设置</div>
                <div class="card-sub">控制日志级别与日志文件；日志文件留空表示只输出到 stderr。</div>
              </div>
            </div>
            <form id="logForm" novalidate>
              <div class="form-grid">
                <div class="field">
                  <label for="logLevel">日志级别</label>
                  <select id="logLevel">
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                  </select>
                </div>
                <div class="field">
                  <label for="logFile">日志文件路径</label>
                  <input id="logFile" type="text" class="mono" placeholder="留空表示只输出到 stderr">
                </div>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn primary" id="logSaveBtn">保存日志设置</button>
              </div>
            </form>
          </div>

          <div class="card card-pad">
            <div class="card-head">
              <div>
                <div class="card-title">原始配置文件</div>
                <div class="card-sub" id="fileMeta">选择文件查看内容，默认掩码敏感值。</div>
              </div>
              <label class="check-inline"><input type="checkbox" id="fileReveal"> 显示敏感值</label>
            </div>
            <div class="row">
              <select id="fileSelect" class="mono" aria-label="选择配置文件">
                <option value=".steve/.env">.steve/.env</option>
                <option value=".steve/admin.json">.steve/admin.json</option>
                <option value=".steve/watch.json">.steve/watch.json</option>
                <option value=".steve/mcp.json">.steve/mcp.json</option>
              </select>
              <span id="fileMaskBadge" class="badge muted">掩码</span>
              <button type="button" class="btn secondary small" id="fileReloadBtn">重新读取</button>
            </div>
            <pre class="code mt" id="fileContent">加载中…</pre>
          </div>

          <div class="card card-pad danger-zone">
            <div class="card-head">
              <div>
                <div class="card-title">危险区</div>
                <div class="card-sub">重启由 supervisor 接管，进行中的请求可能中断。</div>
              </div>
            </div>
            <div class="page-actions">
              <button type="button" class="btn danger" id="restartDangerBtn">重启服务</button>
              <button type="button" class="btn secondary" id="clearTokenBtn">清除本地 Token</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div class="login-wrap" id="loginWrap" hidden>
    <form class="login-card" id="loginForm">
      <div class="login-icon" aria-hidden="true">🔐</div>
      <h2>需要访问令牌</h2>
      <p id="loginHint">请输入管理后台 Token。令牌只保存在当前浏览器的 localStorage 中。</p>
      <label class="sr-only" for="loginToken">Token</label>
      <input id="loginToken" type="password" placeholder="粘贴访问 Token" autocomplete="current-password">
      <button type="submit" class="btn primary">保存并登录</button>
    </form>
  </div>
  <div class="toasts" id="toasts" aria-live="polite"></div>
</div>
<script>
(function () {
  "use strict";

  var VIEWS = ["overview", "providers", "gateways", "schedules", "system"];
  var TOKEN_KEY = "steve-admin-token";
  var THEME_KEY = "steve-admin-theme";
  var NEWLINE = String.fromCharCode(10);
  var TAB = String.fromCharCode(9);
  var CR = String.fromCharCode(13);

  var state = {
    token: "",
    overview: null,
    overviewBase: null,
    providers: [],
    activeProviderId: "",
    editingProviderId: "",
    gateways: null,
    schedules: [],
    watchFile: "",
    editingScheduleName: "",
    system: null,
    sysFiles: [],
    filePath: ".steve/.env",
    fileReveal: false,
    current: "overview",
    errorTimer: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function valueOf(id) {
    var element = byId(id);
    return element && typeof element.value === "string" ? element.value : "";
  }

  function escapeHtml(value) {
    var text = value === undefined || value === null ? "" : String(value);
    var out = "";
    for (var index = 0; index < text.length; index++) {
      var character = text.charAt(index);
      if (character === "&") out += "&amp;";
      else if (character === "<") out += "&lt;";
      else if (character === ">") out += "&gt;";
      else if (character === '"') out += "&quot;";
      else if (character === "'") out += "&#39;";
      else out += character;
    }
    return out;
  }

  function display(value) {
    if (value === undefined || value === null || value === "") return "—";
    return String(value);
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function formatDuration(ms) {
    var totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var text = "";
    if (days > 0) text += days + " 天 ";
    text += pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
    return text;
  }

  function formatBytes(bytes) {
    var size = Number(bytes);
    if (!size || size < 0) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size = size / 1024;
      index++;
    }
    return (index === 0 ? String(Math.round(size)) : size.toFixed(1)) + " " + units[index];
  }

  function formatTime(value) {
    var date;
    if (typeof value === "number") {
      date = new Date(value < 100000000000 ? value * 1000 : value);
    } else if (typeof value === "string" && value) {
      date = new Date(value);
    } else {
      return "—";
    }
    if (!date || isNaN(date.getTime())) return "—";
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function splitWords(value) {
    var text = String(value || "");
    var words = [];
    var current = "";
    for (var index = 0; index < text.length; index++) {
      var character = text.charAt(index);
      if (character === " " || character === NEWLINE || character === TAB || character === CR) {
        if (current) {
          words.push(current);
          current = "";
        }
      } else {
        current += character;
      }
    }
    if (current) words.push(current);
    return words;
  }

  function parseList(raw) {
    var text = String(raw || "").split(NEWLINE).join(",");
    var parts = text.split(",");
    var out = [];
    for (var index = 0; index < parts.length; index++) {
      var item = parts[index].trim();
      if (item && out.indexOf(item) < 0) out.push(item);
    }
    return out;
  }

  function badge(text, kind) {
    return '<span class="badge ' + escapeHtml(kind || "muted") + '">' + escapeHtml(text) + "</span>";
  }

  function kvRow(label, valueHtml) {
    return '<div class="kv"><span class="kv-key">' + escapeHtml(label) + '</span><span class="kv-val">' + valueHtml + "</span></div>";
  }

  function statCard(label, valueHtml, options) {
    options = options || {};
    var classes = "stat";
    var valueClasses = "stat-value";
    if (options.wide) classes += " stat-wide";
    if (options.mono) valueClasses += " mono";
    if (options.small) valueClasses += " small";
    var hint = options.hint ? '<div class="stat-hint">' + options.hint + "</div>" : "";
    return '<div class="' + classes + '"><div class="stat-label">' + escapeHtml(label) + '</div><div class="' + valueClasses + '">' + valueHtml + "</div>" + hint + "</div>";
  }

  function closestButton(target) {
    var node = target;
    while (node && node !== document) {
      if (node.nodeType === 1 && node.tagName === "BUTTON") return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ---------- 主题、提示与连接状态 ---------- */

  function applyTheme(theme, persist) {
    var next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    var button = byId("themeToggle");
    if (button) {
      button.textContent = next === "dark" ? "☀️" : "🌙";
      button.title = next === "dark" ? "切换到浅色主题" : "切换到深色主题";
    }
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        /* localStorage 不可用时忽略 */
      }
    }
  }

  function toast(message, kind) {
    var wrap = byId("toasts");
    if (!wrap) return;
    var element = document.createElement("div");
    element.className = "toast" + (kind === "success" ? " ok" : kind === "error" ? " err" : "");
    element.textContent = String(message);
    wrap.appendChild(element);
    setTimeout(function () {
      element.classList.add("out");
      setTimeout(function () {
        if (element.parentNode) element.parentNode.removeChild(element);
      }, 220);
    }, 3000);
  }

  function showError(message) {
    var bar = byId("errorBar");
    var text = byId("errorText");
    if (!bar || !text) return;
    text.textContent = message ? String(message) : "请求失败";
    bar.hidden = false;
    clearTimeout(state.errorTimer);
    state.errorTimer = setTimeout(function () {
      bar.hidden = true;
    }, 8000);
  }

  function hideError() {
    var bar = byId("errorBar");
    if (bar) bar.hidden = true;
    clearTimeout(state.errorTimer);
  }

  function setConn(stateName, label) {
    var conn = byId("connStatus");
    var text = byId("connText");
    if (conn) conn.setAttribute("data-state", stateName);
    if (text) text.textContent = label;
  }

  function fail(error) {
    if (error && error.auth) return;
    showError(error && error.message ? error.message : "请求失败");
  }

  /* ---------- 请求与登录 ---------- */

  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    var init = { method: options.method || "GET", headers: headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (parseError) {
            data = null;
          }
        }
        if (response.status === 401) {
          showLogin("登录状态已失效，请重新输入 Token。");
          setConn("bad", "未登录");
          var authError = new Error("unauthorized");
          authError.auth = true;
          throw authError;
        }
        if (!response.ok) {
          var message = data && data.error ? String(data.error) : "请求失败（HTTP " + response.status + "）";
          throw new Error(message);
        }
        setConn("ok", "已连接");
        return data;
      });
    }, function (networkError) {
      setConn("bad", "连接失败");
      var message = networkError && networkError.message ? networkError.message : "无法连接服务";
      throw new Error("网络错误：" + message);
    });
  }

  function showLogin(message) {
    var wrap = byId("loginWrap");
    if (!wrap) return;
    var hint = byId("loginHint");
    if (hint && message) hint.textContent = message;
    var wasHidden = wrap.hidden;
    wrap.hidden = false;
    if (!wasHidden) return;
    var input = byId("loginToken");
    if (input) {
      input.value = "";
      setTimeout(function () {
        try {
          input.focus();
        } catch (focusError) {
          /* 忽略 */
        }
      }, 30);
    }
  }

  function hideLogin() {
    var wrap = byId("loginWrap");
    if (wrap) wrap.hidden = true;
  }

  function clearToken() {
    if (!window.confirm("清除本地 Token 并重新登录？")) return;
    state.token = "";
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      /* 忽略 */
    }
    showLogin("已清除本地 Token，请重新输入。");
  }

  /* ---------- 路由 ---------- */

  function parseHash() {
    var raw = String(location.hash || "").replace("#", "");
    return VIEWS.indexOf(raw) >= 0 ? raw : "overview";
  }

  function closeSidebar() {
    var sidebar = byId("sidebar");
    var scrim = byId("scrim");
    var toggle = byId("navToggle");
    if (sidebar) sidebar.classList.remove("open");
    if (scrim) scrim.classList.remove("open");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function toggleSidebar() {
    var sidebar = byId("sidebar");
    if (!sidebar) return;
    var scrim = byId("scrim");
    var toggle = byId("navToggle");
    var open = !sidebar.classList.contains("open");
    if (open) sidebar.classList.add("open");
    else sidebar.classList.remove("open");
    if (scrim) {
      if (open) scrim.classList.add("open");
      else scrim.classList.remove("open");
    }
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function applyRoute() {
    var name = parseHash();
    state.current = name;
    if (location.hash && String(location.hash).replace("#", "") !== name) {
      try {
        history.replaceState(null, "", "#" + name);
      } catch (error) {
        /* 忽略 */
      }
    }
    for (var index = 0; index < VIEWS.length; index++) {
      var view = VIEWS[index];
      var section = byId("view-" + view);
      if (section) section.hidden = view !== name;
      var link = document.querySelector('.nav-item[data-view="' + view + '"]');
      if (link) {
        if (view === name) link.classList.add("active");
        else link.classList.remove("active");
      }
    }
    closeSidebar();
    if (!state.token) {
      showLogin();
      return;
    }
    loadCurrent();
  }

  function loadCurrent() {
    if (!state.token) {
      showLogin();
      return;
    }
    if (state.current === "providers") loadProviders();
    else if (state.current === "gateways") loadGateways();
    else if (state.current === "schedules") loadSchedules();
    else if (state.current === "system") loadSystem();
    else loadOverview();
  }

  /* ---------- 概览 ---------- */

  function updateVersionChip(version) {
    var chip = byId("brandVersion");
    if (!chip) return;
    if (!version) {
      chip.textContent = "v—";
      return;
    }
    var text = String(version);
    chip.textContent = text.charAt(0) === "v" ? text : "v" + text;
  }

  function loadOverview() {
    return api("/admin/api/overview").then(function (data) {
      state.overview = data || {};
      state.overviewBase = {
        uptimeMs: Number(data && data.uptimeMs) || 0,
        at: Date.now()
      };
      updateVersionChip(data && data.version);
      renderOverview();
    }).catch(fail);
  }

  function tickUptime() {
    var base = state.overviewBase;
    if (!base) return;
    var element = byId("uptimeValue");
    if (!element) return;
    element.textContent = formatDuration(base.uptimeMs + (Date.now() - base.at));
  }

  function pollOverview() {
    if (!state.token) return;
    if (typeof document.visibilityState === "string" && document.visibilityState === "hidden") return;
    api("/admin/api/overview").then(function (data) {
      state.overview = data || {};
      state.overviewBase = {
        uptimeMs: Number(data && data.uptimeMs) || 0,
        at: Date.now()
      };
      updateVersionChip(data && data.version);
      if (state.current === "overview") renderOverview();
    }).catch(function (error) {
      if (!error || !error.auth) setConn("bad", "连接失败");
    });
  }

  function renderOverview() {
    var overview = state.overview;
    var grid = byId("overviewGrid");
    if (!overview || !grid) return;
    var feishu = overview.feishu || {};
    var feishuBadge = feishu.configured === true ? badge("已配置", "ok") : badge("未配置", "muted");
    var watchBadge = overview.watchEnabled ? badge("on", "ok") : badge("off", "muted");
    var providerCount = Number(overview.providerCount) || 0;
    var versionText = overview.version ? String(overview.version) : "—";
    if (versionText !== "—" && versionText.charAt(0) !== "v") versionText = "v" + versionText;
    var base = state.overviewBase;
    var uptime = formatDuration(base ? base.uptimeMs + (Date.now() - base.at) : 0);
    var html = "";
    html += statCard("版本", escapeHtml(versionText));
    html += statCard("Node 版本", escapeHtml(display(overview.node)), { mono: true });
    html += statCard("运行时长", '<span id="uptimeValue">' + escapeHtml(uptime) + "</span>", { mono: true, hint: "实时计时，每 5 秒与服务端校准" });
    html += statCard("PID", escapeHtml(display(overview.pid)), { mono: true });
    html += statCard("当前激活供应商", escapeHtml(display(overview.activeProvider)), { small: true });
    html += statCard("供应商数量", escapeHtml(String(providerCount)), { small: true, hint: "已配置的模型供应商" });
    html += statCard("飞书网关", feishuBadge, { small: true });
    html += statCard("Watch", watchBadge, { small: true, hint: "watch.json 触发器" });
    html += statCard("日志级别", badge(display(overview.logLevel), "info"), { small: true });
    html += statCard("工作目录", escapeHtml(display(overview.cwd)), { mono: true, small: true, wide: true });
    html += statCard("streams 目录", escapeHtml(display(overview.streamsDir)), { mono: true, small: true, wide: true });
    html += statCard("日志文件", escapeHtml(display(overview.logFile)), { mono: true, small: true, wide: true });
    grid.innerHTML = html;
  }

  /* ---------- 模型供应商 ---------- */

  function loadProviders() {
    return api("/admin/api/providers").then(function (data) {
      state.providers = data && Array.isArray(data.providers) ? data.providers : [];
      state.activeProviderId = data && data.activeProviderId ? String(data.activeProviderId) : "";
      renderProviders();
    }).catch(fail);
  }

  function findProvider(id) {
    for (var index = 0; index < state.providers.length; index++) {
      var provider = state.providers[index];
      if (provider && provider.id !== undefined && provider.id !== null && String(provider.id) === String(id)) return provider;
    }
    return null;
  }

  function renderProviders() {
    var rows = byId("providerRows");
    var summary = byId("providerSummary");
    if (summary) {
      summary.textContent = state.providers.length
        ? "共 " + state.providers.length + " 个供应商" + (state.activeProviderId ? " · 激活 ID：" + state.activeProviderId : "")
        : "尚未配置供应商";
    }
    if (!rows) return;
    if (!state.providers.length) {
      rows.innerHTML = '<tr><td colspan="7"><div class="empty">还没有配置模型供应商，点击右上角「新增供应商」开始。</div></td></tr>';
      return;
    }
    var html = "";
    for (var index = 0; index < state.providers.length; index++) {
      var provider = state.providers[index];
      var id = provider.id === undefined || provider.id === null ? "" : String(provider.id);
      var isActive = provider.active === true || (!!state.activeProviderId && !!id && state.activeProviderId === id);
      var models = Array.isArray(provider.models) ? provider.models : [];
      var modelTitle = models.length ? models.join(", ") : "无";
      var actions = "";
      actions += '<button type="button" class="btn secondary small" data-act="edit" data-id="' + escapeHtml(id) + '">编辑</button>';
      if (!isActive) actions += '<button type="button" class="btn primary small" data-act="activate" data-id="' + escapeHtml(id) + '">激活</button>';
      actions += '<button type="button" class="btn danger small" data-act="delete" data-id="' + escapeHtml(id) + '">删除</button>';
      html += "<tr>";
      html += '<td class="cell-strong">' + escapeHtml(display(provider.name)) + "</td>";
      html += '<td class="cell-mono">' + escapeHtml(display(provider.baseUrl)) + "</td>";
      html += '<td class="cell-mono">' + escapeHtml(display(provider.defaultModel)) + "</td>";
      html += '<td><span title="' + escapeHtml(modelTitle) + '">' + escapeHtml(String(models.length)) + " 个</span></td>";
      html += "<td>" + (provider.reasoning === true ? badge("开启", "ok") : badge("关闭", "muted")) + "</td>";
      html += "<td>" + (isActive ? badge("激活中", "info") : badge("未激活", "muted")) + "</td>";
      html += '<td><div class="cell-actions">' + actions + "</div></td>";
      html += "</tr>";
    }
    rows.innerHTML = html;
  }

  function onProviderRowClick(event) {
    var button = closestButton(event.target);
    if (!button) return;
    var action = button.getAttribute("data-act");
    var id = button.getAttribute("data-id") || "";
    if (action === "edit") {
      var provider = findProvider(id);
      if (provider) openProviderForm(provider);
    } else if (action === "delete") {
      deleteProvider(id);
    } else if (action === "activate") {
      activateProvider(id);
    }
  }

  function openProviderForm(provider) {
    state.editingProviderId = provider && provider.id !== undefined && provider.id !== null ? String(provider.id) : "";
    var card = byId("providerFormCard");
    if (!card) return;
    card.hidden = false;
    var title = byId("providerFormTitle");
    if (title) title.textContent = state.editingProviderId ? "编辑供应商" : "新增供应商";
    var nameInput = byId("pv-name");
    if (nameInput) nameInput.value = provider ? String(provider.name || "") : "";
    var baseInput = byId("pv-baseUrl");
    if (baseInput) baseInput.value = provider ? String(provider.baseUrl || "") : "";
    var keyInput = byId("pv-apiKey");
    if (keyInput) {
      keyInput.value = "";
      keyInput.placeholder = state.editingProviderId ? "留空保持不变" : "输入 API Key（可留空）";
    }
    var modelInput = byId("pv-defaultModel");
    if (modelInput) modelInput.value = provider ? String(provider.defaultModel || "") : "";
    var modelsInput = byId("pv-models");
    if (modelsInput) modelsInput.value = provider && Array.isArray(provider.models) ? provider.models.join(NEWLINE) : "";
    var reasoningInput = byId("pv-reasoning");
    if (reasoningInput) reasoningInput.checked = !!(provider && provider.reasoning);
    try {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (scrollError) {
      /* 忽略 */
    }
    if (nameInput) nameInput.focus();
  }

  function closeProviderForm() {
    state.editingProviderId = "";
    var card = byId("providerFormCard");
    if (card) card.hidden = true;
    var keyInput = byId("pv-apiKey");
    if (keyInput) keyInput.value = "";
  }

  function saveProvider() {
    var name = valueOf("pv-name").trim();
    if (!name) {
      toast("请填写供应商名称", "error");
      var nameInput = byId("pv-name");
      if (nameInput) nameInput.focus();
      return;
    }
    var provider = {
      name: name,
      baseUrl: valueOf("pv-baseUrl").trim(),
      defaultModel: valueOf("pv-defaultModel").trim(),
      models: parseList(valueOf("pv-models")),
      reasoning: !!(byId("pv-reasoning") && byId("pv-reasoning").checked)
    };
    if (state.editingProviderId) provider.id = state.editingProviderId;
    var apiKey = valueOf("pv-apiKey").trim();
    if (apiKey) provider.apiKey = apiKey;
    var button = byId("providerSaveBtn");
    setBusy(button, true, "保存中…");
    api("/admin/api/providers/save", { method: "POST", body: { provider: provider } }).then(function (data) {
      setBusy(button, false);
      closeProviderForm();
      if (data && data.restartRequired === false) {
        toast("供应商已保存", "success");
      } else {
        toast("供应商已保存，需重启服务生效", "success");
        showRestartBanner();
      }
      return loadProviders();
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  function deleteProvider(id) {
    var provider = findProvider(id);
    var name = provider ? String(provider.name || "") : String(id);
    if (!window.confirm("确定删除供应商「" + name + "」吗？删除后需重启服务生效。")) return;
    api("/admin/api/providers/delete", { method: "POST", body: { id: provider ? provider.id : id } }).then(function (data) {
      if (data && data.restartRequired === false) {
        toast("供应商已删除", "success");
      } else {
        toast("供应商已删除，需重启服务生效", "success");
        showRestartBanner();
      }
      return loadProviders();
    }).catch(fail);
  }

  function activateProvider(id) {
    var provider = findProvider(id);
    api("/admin/api/providers/activate", { method: "POST", body: { id: provider ? provider.id : id } }).then(function (data) {
      if (data && data.restartRequired === false) {
        toast("已切换激活供应商", "success");
      } else {
        toast("已切换激活供应商，需重启服务生效", "success");
        showRestartBanner();
      }
      return loadProviders();
    }).catch(fail);
  }

  /* ---------- 网关 ---------- */

  function loadGateways() {
    return api("/admin/api/gateways").then(function (data) {
      state.gateways = data || {};
      renderGateways();
    }).catch(fail);
  }

  function renderGateways() {
    var data = state.gateways || {};
    var feishu = data.feishu || {};
    var hasAny = !!(feishu.appIdMasked || feishu.hasSecret || feishu.hasVerificationToken || feishu.hasEncryptKey);
    var statusElement = byId("feishuStatus");
    if (statusElement) {
      if (feishu.configured === true) statusElement.innerHTML = badge("已配置", "ok");
      else if (hasAny) statusElement.innerHTML = badge("部分配置", "warn");
      else statusElement.innerHTML = badge("未配置", "muted");
    }
    var mode = feishu.mode === "http" ? "http" : "ws";
    (document.querySelectorAll('input[name="gw-mode"]') || []).forEach(function (input) {
      input.checked = input.value === mode;
    });
    var connection = feishu.connection || {};
    var details = byId("feishuDetails");
    if (details) {
      var rows = "";
      rows += kvRow("事件接收方式", mode === "ws" ? badge("长连接", "ok") : badge("HTTP 回调", "warn"));
      if (mode === "ws") {
        var link = connection.connected ? badge("已连接", "ok") : badge("连接中" + (connection.attempts ? "（第 " + connection.attempts + " 次）" : ""), "warn");
        rows += kvRow("连接状态", link + (connection.lastError ? ' <span class="muted small">' + escapeHtml(String(connection.lastError)) + "</span>" : ""));
      }
      rows += kvRow("API Base", '<span class="mono">' + escapeHtml(display(feishu.apiBase)) + "</span>");
      rows += kvRow("App ID", '<span class="mono">' + escapeHtml(display(feishu.appIdMasked)) + "</span>");
      rows += kvRow("App Secret", feishu.hasSecret ? badge("已设置", "ok") : badge("未设置", "muted"));
      rows += kvRow("Verification Token", mode === "ws" ? badge("长连接不需要", "muted") : feishu.hasVerificationToken ? badge("已设置", "ok") : badge("未设置", "muted"));
      rows += kvRow("Encrypt Key", feishu.hasEncryptKey ? badge("已设置", "ok") : badge("未设置（可选）", "muted"));
      details.innerHTML = rows;
    }
    var apiBaseInput = byId("gw-apiBase");
    if (apiBaseInput) apiBaseInput.value = feishu.apiBase || "";
  }

  function saveGateway() {
    var feishu = {};
    var currentGateway = (state.gateways && state.gateways.feishu) || {};
    var modeInput = document.querySelector('input[name="gw-mode"]:checked');
    var mode = modeInput ? modeInput.value : "ws";
    if (mode !== (currentGateway.mode === "http" ? "http" : "ws")) feishu.mode = mode;
    var appId = valueOf("gw-appId").trim();
    var appSecret = valueOf("gw-appSecret").trim();
    var verificationToken = valueOf("gw-verificationToken").trim();
    var encryptKey = valueOf("gw-encryptKey").trim();
    var apiBase = valueOf("gw-apiBase").trim();
    if (appId) feishu.appId = appId;
    if (appSecret) feishu.appSecret = appSecret;
    if (verificationToken) feishu.verificationToken = verificationToken;
    if (encryptKey) feishu.encryptKey = encryptKey;
    if (apiBase) feishu.apiBase = apiBase;
    if (Object.keys(feishu).length === 0) {
      toast("没有需要保存的改动：留空字段表示保持不变", "error");
      return;
    }
    var button = byId("gatewaySaveBtn");
    setBusy(button, true, "保存中…");
    api("/admin/api/gateways/save", { method: "POST", body: { feishu: feishu } }).then(function (data) {
      setBusy(button, false);
      ["gw-appId", "gw-appSecret", "gw-verificationToken", "gw-encryptKey"].forEach(function (field) {
        var input = byId(field);
        if (input) input.value = "";
      });
      toast("网关配置已保存，需重启服务生效", "success");
      if (!data || data.restartRequired !== false) showRestartBanner();
      return loadGateways();
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  function clearGateway() {
    if (!window.confirm("确定清空飞书网关的全部配置（App ID、App Secret、Verification Token、Encrypt Key、API Base）吗？")) return;
    var button = byId("gatewayClearBtn");
    setBusy(button, true, "提交中…");
    var body = {
      feishu: {
        appId: "",
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
        apiBase: ""
      }
    };
    api("/admin/api/gateways/save", { method: "POST", body: body }).then(function (data) {
      setBusy(button, false);
      toast("已清空飞书网关配置，需重启服务生效", "success");
      if (!data || data.restartRequired !== false) showRestartBanner();
      return loadGateways();
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  /* ---------- 定时任务 ---------- */

  function loadSchedules() {
    return api("/admin/api/schedules").then(function (data) {
      state.schedules = data && Array.isArray(data.schedules) ? data.schedules : [];
      state.watchFile = data && data.watchFile ? String(data.watchFile) : "";
      renderSchedules();
    }).catch(fail);
  }

  function findSchedule(name) {
    for (var index = 0; index < state.schedules.length; index++) {
      var schedule = state.schedules[index];
      if (schedule && String(schedule.name) === String(name)) return schedule;
    }
    return null;
  }

  function renderSchedules() {
    var fileLine = byId("scheduleFile");
    if (fileLine) fileLine.textContent = "配置文件：" + (state.watchFile || ".steve/watch.json");
    var rows = byId("scheduleRows");
    if (!rows) return;
    if (!state.schedules.length) {
      rows.innerHTML = '<tr><td colspan="6"><div class="empty">还没有定时任务，点击右上角「新增定时任务」创建。</div></td></tr>';
      return;
    }
    var html = "";
    for (var index = 0; index < state.schedules.length; index++) {
      var schedule = state.schedules[index];
      var name = schedule.name === undefined || schedule.name === null ? "" : String(schedule.name);
      var mode = schedule.mode === "foreground" ? "foreground" : "background";
      var actions = "";
      actions += '<button type="button" class="btn primary small" data-act="run" data-name="' + escapeHtml(name) + '">立即运行</button>';
      actions += '<button type="button" class="btn secondary small" data-act="edit" data-name="' + escapeHtml(name) + '">编辑</button>';
      actions += '<button type="button" class="btn danger small" data-act="delete" data-name="' + escapeHtml(name) + '">删除</button>';
      html += "<tr>";
      html += '<td class="cell-strong">' + escapeHtml(display(name)) + "</td>";
      html += '<td class="cell-mono">' + escapeHtml(display(schedule.cron)) + "</td>";
      html += '<td class="cell-mono">' + escapeHtml(display(schedule.timezone)) + "</td>";
      html += '<td class="cell-mono">' + escapeHtml(display(schedule.targetStream)) + "</td>";
      html += "<td>" + badge(mode, mode === "foreground" ? "warn" : "info") + "</td>";
      html += '<td><div class="cell-actions">' + actions + "</div></td>";
      html += "</tr>";
    }
    rows.innerHTML = html;
  }

  function onScheduleRowClick(event) {
    var button = closestButton(event.target);
    if (!button) return;
    var action = button.getAttribute("data-act");
    var name = button.getAttribute("data-name") || "";
    if (action === "edit") {
      var schedule = findSchedule(name);
      if (schedule) openScheduleForm(schedule);
    } else if (action === "delete") {
      deleteSchedule(name);
    } else if (action === "run") {
      runSchedule(name, button);
    }
  }

  function openScheduleForm(schedule) {
    state.editingScheduleName = schedule && schedule.name !== undefined && schedule.name !== null ? String(schedule.name) : "";
    var card = byId("scheduleFormCard");
    if (!card) return;
    card.hidden = false;
    var title = byId("scheduleFormTitle");
    if (title) title.textContent = state.editingScheduleName ? "编辑定时任务" : "新增定时任务";
    var nameInput = byId("sc-name");
    if (nameInput) {
      nameInput.value = schedule ? String(schedule.name || "") : "";
      nameInput.disabled = !!state.editingScheduleName;
    }
    var nameHint = byId("scheduleNameHint");
    if (nameHint) nameHint.textContent = state.editingScheduleName ? "编辑时名称不可修改。" : "名称用于标识任务，保存后不可修改。";
    var cronInput = byId("sc-cron");
    if (cronInput) cronInput.value = schedule ? String(schedule.cron || "") : "";
    var timezoneInput = byId("sc-timezone");
    if (timezoneInput) timezoneInput.value = schedule ? String(schedule.timezone || "") : "";
    var targetInput = byId("sc-target");
    if (targetInput) targetInput.value = schedule ? String(schedule.targetStream || "") : "";
    var modeInput = byId("sc-mode");
    if (modeInput) modeInput.value = schedule && schedule.mode === "foreground" ? "foreground" : "background";
    var promptInput = byId("sc-prompt");
    if (promptInput) promptInput.value = schedule ? String(schedule.prompt || "") : "";
    try {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (scrollError) {
      /* 忽略 */
    }
    if (nameInput && !nameInput.disabled) nameInput.focus();
  }

  function closeScheduleForm() {
    state.editingScheduleName = "";
    var card = byId("scheduleFormCard");
    if (card) card.hidden = true;
  }

  function saveSchedule() {
    var name = valueOf("sc-name").trim();
    if (!name) {
      toast("请填写任务名称", "error");
      return;
    }
    var cron = valueOf("sc-cron").trim();
    if (splitWords(cron).length !== 5) {
      toast("cron 需要 5 段：分 时 日 月 周", "error");
      return;
    }
    var targetStream = valueOf("sc-target").trim();
    if (!targetStream) {
      toast("请填写目标流（12 位 id 或自定义 token）", "error");
      return;
    }
    var prompt = valueOf("sc-prompt").trim();
    if (!prompt) {
      toast("请填写提示词", "error");
      return;
    }
    var mode = valueOf("sc-mode") || "background";
    var body = {
      name: name,
      cron: cron,
      prompt: prompt,
      targetStream: targetStream,
      mode: mode
    };
    var timezone = valueOf("sc-timezone").trim();
    if (timezone) body.timezone = timezone;
    var button = byId("scheduleSaveBtn");
    setBusy(button, true, "保存中…");
    api("/admin/api/schedules/save", { method: "POST", body: body }).then(function (data) {
      setBusy(button, false);
      closeScheduleForm();
      if (data && data.restartRequired === false) {
        toast("定时任务已保存", "success");
      } else {
        toast("定时任务已保存，需重启服务生效", "success");
        showRestartBanner();
      }
      return loadSchedules();
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  function deleteSchedule(name) {
    if (!name) return;
    if (!window.confirm("确定删除定时任务「" + name + "」吗？")) return;
    api("/admin/api/schedules/delete", { method: "POST", body: { name: name } }).then(function (data) {
      if (data && data.restartRequired === false) {
        toast("定时任务已删除", "success");
      } else {
        toast("定时任务已删除，需重启服务生效", "success");
        showRestartBanner();
      }
      return loadSchedules();
    }).catch(fail);
  }

  function runSchedule(name, button) {
    if (!name) return;
    setBusy(button, true, "提交中…");
    api("/admin/api/schedules/run", { method: "POST", body: { name: name } }).then(function (data) {
      setBusy(button, false);
      var runId = data && data.runId !== undefined && data.runId !== null ? String(data.runId) : "—";
      toast("已提交，runId=" + runId, "success");
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  /* ---------- 系统 ---------- */

  function loadSystem() {
    return api("/admin/api/system").then(function (data) {
      state.system = data || {};
      state.sysFiles = Array.isArray(data && data.files) ? data.files : [];
      renderSystem();
      return loadSelectedFile();
    }).catch(fail);
  }

  function renderSystem() {
    var system = state.system || {};
    var grid = byId("systemGrid");
    if (grid) {
      var versionText = system.version ? String(system.version) : "—";
      if (versionText !== "—" && versionText.charAt(0) !== "v") versionText = "v" + versionText;
      var html = "";
      html += statCard("版本", escapeHtml(versionText));
      html += statCard("Node 版本", escapeHtml(display(system.node)), { mono: true });
      html += statCard("PID", escapeHtml(display(system.pid)), { mono: true });
      html += statCard("工作目录", escapeHtml(display(system.cwd)), { mono: true, small: true, wide: true });
      html += statCard("streams 目录", escapeHtml(display(system.streamsDir)), { mono: true, small: true, wide: true });
      grid.innerHTML = html;
    }
    var levelInput = byId("logLevel");
    if (levelInput) levelInput.value = system.logLevel || "info";
    var logFileInput = byId("logFile");
    if (logFileInput) logFileInput.value = system.logFile || "";
  }

  function findSysFile(path) {
    for (var index = 0; index < state.sysFiles.length; index++) {
      var item = state.sysFiles[index];
      if (!item || !item.path) continue;
      var itemPath = String(item.path);
      if (itemPath === path || (itemPath.length > path.length && itemPath.slice(-path.length) === path)) return item;
    }
    return null;
  }

  function loadSelectedFile() {
    var pre = byId("fileContent");
    if (!pre) return Promise.resolve();
    pre.textContent = "加载中…";
    var path = state.filePath;
    var reveal = state.fileReveal ? "1" : "0";
    var badgeElement = byId("fileMaskBadge");
    var meta = byId("fileMeta");
    var url = "/admin/api/files?path=" + encodeURIComponent(path) + "&reveal=" + reveal;
    return api(url).then(function (data) {
      var masked = data && data.masked === true;
      if (badgeElement) badgeElement.innerHTML = masked ? badge("敏感值已掩码", "warn") : badge("未掩码", "muted");
      var content = data && typeof data.content === "string" ? data.content : "";
      pre.textContent = content ? content : "(文件为空)";
      if (meta) {
        var fileInfo = findSysFile(path);
        var metaText = "配置文件：" + path;
        if (fileInfo) {
          metaText += " · " + formatBytes(fileInfo.size) + " · 更新于 " + formatTime(fileInfo.mtime);
        }
        if (masked) metaText += " · 敏感值已掩码";
        meta.textContent = metaText;
      }
    }).catch(function (error) {
      pre.textContent = "无法读取文件：" + (error && error.message ? error.message : "未知错误");
      if (badgeElement) badgeElement.innerHTML = badge("读取失败", "danger");
      fail(error);
    });
  }

  function saveSystem() {
    var level = valueOf("logLevel") || "info";
    var logFile = valueOf("logFile").trim();
    var button = byId("logSaveBtn");
    setBusy(button, true, "保存中…");
    api("/admin/api/system/save", { method: "POST", body: { logLevel: level, logFile: logFile } }).then(function () {
      setBusy(button, false);
      toast("日志设置已保存", "success");
      return loadSystem();
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  /* ---------- 重启与通用 ---------- */

  function showRestartBanner() {
    var banner = byId("restartBanner");
    if (banner) banner.hidden = false;
  }

  function hideRestartBanner() {
    var banner = byId("restartBanner");
    if (banner) banner.hidden = true;
  }

  function restartService(button) {
    if (!window.confirm("确定要重启 Steve 服务吗？重启由 supervisor 接管，进行中的请求可能中断。")) return;
    setBusy(button, true, "提交中…");
    api("/admin/api/system/restart", { method: "POST", body: {} }).then(function () {
      setBusy(button, false);
      hideRestartBanner();
      setConn("idle", "重启中…");
      toast("重启指令已提交，服务将由 supervisor 接管", "success");
    }).catch(function (error) {
      setBusy(button, false);
      fail(error);
    });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (button.getAttribute("data-idle-label") === null) {
        button.setAttribute("data-idle-label", button.textContent || "");
      }
      button.disabled = true;
      if (label) button.textContent = label;
    } else {
      button.disabled = false;
      var idle = button.getAttribute("data-idle-label");
      if (idle !== null) button.textContent = idle;
    }
  }

  /* ---------- 事件绑定与启动 ---------- */

  function wireEvents() {
    var loginForm = byId("loginForm");
    if (loginForm) loginForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var input = byId("loginToken");
      var token = input ? String(input.value || "").trim() : "";
      if (!token) {
        var hint = byId("loginHint");
        if (hint) hint.textContent = "请输入 Token 后再登录。";
        return;
      }
      state.token = token;
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch (error) {
        /* 忽略 */
      }
      hideLogin();
      toast("登录成功", "success");
      applyRoute();
    });

    var themeToggle = byId("themeToggle");
    if (themeToggle) themeToggle.addEventListener("click", function () {
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next, true);
    });

    var navToggle = byId("navToggle");
    if (navToggle) navToggle.addEventListener("click", toggleSidebar);
    var scrim = byId("scrim");
    if (scrim) scrim.addEventListener("click", closeSidebar);

    var navItems = document.querySelectorAll(".nav-item");
    for (var navIndex = 0; navIndex < navItems.length; navIndex++) {
      navItems[navIndex].addEventListener("click", closeSidebar);
    }

    var errorClose = byId("errorClose");
    if (errorClose) errorClose.addEventListener("click", hideError);

    var refreshBtn = byId("refreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      var glyph = byId("refreshGlyph");
      if (glyph) {
        glyph.classList.add("spin");
        setTimeout(function () {
          glyph.classList.remove("spin");
        }, 700);
      }
      if (!state.token) {
        showLogin();
        return;
      }
      loadCurrent();
    });

    var providerNewBtn = byId("providerNewBtn");
    if (providerNewBtn) providerNewBtn.addEventListener("click", function () {
      openProviderForm(null);
    });
    var providerCancelBtn = byId("providerCancelBtn");
    if (providerCancelBtn) providerCancelBtn.addEventListener("click", closeProviderForm);
    var providerForm = byId("providerForm");
    if (providerForm) providerForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveProvider();
    });
    var providerRows = byId("providerRows");
    if (providerRows) providerRows.addEventListener("click", onProviderRowClick);

    var gatewayForm = byId("gatewayForm");
    if (gatewayForm) gatewayForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveGateway();
    });
    var gatewayClearBtn = byId("gatewayClearBtn");
    if (gatewayClearBtn) gatewayClearBtn.addEventListener("click", clearGateway);

    var scheduleNewBtn = byId("scheduleNewBtn");
    if (scheduleNewBtn) scheduleNewBtn.addEventListener("click", function () {
      openScheduleForm(null);
    });
    var scheduleCancelBtn = byId("scheduleCancelBtn");
    if (scheduleCancelBtn) scheduleCancelBtn.addEventListener("click", closeScheduleForm);
    var scheduleForm = byId("scheduleForm");
    if (scheduleForm) scheduleForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveSchedule();
    });
    var scheduleRows = byId("scheduleRows");
    if (scheduleRows) scheduleRows.addEventListener("click", onScheduleRowClick);

    var logForm = byId("logForm");
    if (logForm) logForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveSystem();
    });

    var fileSelect = byId("fileSelect");
    if (fileSelect) fileSelect.addEventListener("change", function () {
      state.filePath = fileSelect.value || ".steve/.env";
      loadSelectedFile();
    });
    var fileReveal = byId("fileReveal");
    if (fileReveal) fileReveal.addEventListener("change", function () {
      state.fileReveal = !!fileReveal.checked;
      loadSelectedFile();
    });
    var fileReloadBtn = byId("fileReloadBtn");
    if (fileReloadBtn) fileReloadBtn.addEventListener("click", loadSelectedFile);

    var restartBannerBtn = byId("restartBannerBtn");
    if (restartBannerBtn) restartBannerBtn.addEventListener("click", function () {
      restartService(this);
    });
    var restartDangerBtn = byId("restartDangerBtn");
    if (restartDangerBtn) restartDangerBtn.addEventListener("click", function () {
      restartService(this);
    });
    var clearTokenBtn = byId("clearTokenBtn");
    if (clearTokenBtn) clearTokenBtn.addEventListener("click", clearToken);

    window.addEventListener("hashchange", applyRoute);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.token) pollOverview();
    });
  }

  function boot() {
    try {
      state.token = localStorage.getItem(TOKEN_KEY) || "";
    } catch (error) {
      state.token = "";
    }
    var fileSelect = byId("fileSelect");
    if (fileSelect) state.filePath = fileSelect.value || state.filePath;
    applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
    wireEvents();
    if (!location.hash) {
      try {
        history.replaceState(null, "", "#overview");
      } catch (error) {
        location.hash = "#overview";
      }
    }
    if (!state.token) {
      applyRoute();
      showLogin("请输入管理后台 Token 以开始。");
    } else {
      applyRoute();
    }
    setInterval(tickUptime, 1000);
    setInterval(pollOverview, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
</script>
</body>
</html>
`;
