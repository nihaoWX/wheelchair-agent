/**
 * The standalone panel's page, kept as one self-contained document: no build chain, no React, no
 * `@deepseek-ai/*`. It renders the same three JSON endpoints the dsh plugin serves (inbox, settings,
 * hooks) and posts the same request bodies, so the two hosts share their whole interface.
 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wheelchair-agent</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --card:#fff; --fg:#1c1c1e; --dim:#6b6b70; --line:#e3e3e6; --accent:#3b5bdb; --bad:#c92a2a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161618; --card:#1e1e21; --fg:#ececf1; --dim:#9a9aa2; --line:#333338; --accent:#7c9cff; --bad:#ff8787; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:18px 22px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:17px; margin:0; }
  header .dim { color:var(--dim); font-size:12px; }
  nav { display:flex; gap:8px; padding:12px 22px; }
  nav button { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px; padding:6px 12px; cursor:pointer; }
  nav button.active { border-color:var(--accent); color:var(--accent); }
  main { padding:0 22px 40px; max-width:1100px; }
  section { display:none; }
  section.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1 1 240px; }
  .dim { color:var(--dim); }
  .bad { color:var(--bad); }
  textarea, input, select { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  textarea { width:100%; min-height:64px; }
  button.primary { background:var(--accent); border:1px solid var(--accent); color:#fff; border-radius:6px; padding:5px 12px; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:5px 12px; cursor:pointer; }
  button:disabled { opacity:.55; cursor:default; }
  .grid { display:grid; grid-template-columns:minmax(180px,240px) 1fr; gap:8px 14px; align-items:center; }
  .tag { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:1px 8px; color:var(--dim); }
  pre { white-space:pre-wrap; word-break:break-word; margin:0; }
  .hooks-event { margin:14px 0; }
</style>
</head>
<body>
<header>
  <h1>wheelchair-agent</h1>
  <span class="dim">独立面板 · 只读展示与人工操作；轮询、合并、提醒仍在部署实例里</span>
  <span id="status" class="dim grow" style="text-align:right"></span>
</header>
<nav>
  <button data-tab="inbox" class="active">收件箱</button>
  <button data-tab="settings">设置</button>
  <button data-tab="hooks">插口</button>
</nav>
<main>
  <section id="inbox" class="active">
    <div class="row"><strong>收件箱</strong><span class="dim grow" id="inboxMeta"></span>
      <button class="ghost" data-refresh="items">刷新</button></div>
    <div id="items"></div>
  </section>
  <section id="settings">
    <div class="row"><strong>设置</strong><span class="dim grow" id="settingsMeta"></span>
      <button class="ghost" data-refresh="settings">刷新</button></div>
    <div id="settingsForm" class="card"><span class="dim">正在加载…</span></div>
  </section>
  <section id="hooks">
    <div class="row"><strong>插口</strong><span class="dim grow" id="hooksMeta"></span>
      <button class="ghost" data-refresh="hooks">刷新</button></div>
    <div id="hooksView"></div>
  </section>
</main>
<script>
const ITEMS_URL = '/wheelchair-inbox/items'
const REVIEW_URL = '/wheelchair-inbox/review'
const SETTINGS_URL = '/wheelchair-settings'
const $ = selector => document.querySelector(selector)
const statusLine = text => { $('#status').textContent = text }
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]))
let snapshot = null

document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(other => other.classList.toggle('active', other === button))
  document.querySelectorAll('main section').forEach(section => section.classList.toggle('active', section.id === button.dataset.tab))
  if (button.dataset.tab === 'hooks') loadHooks()
}))
document.querySelectorAll('[data-refresh]').forEach(button => button.addEventListener('click', () => {
  const what = button.dataset.refresh
  if (what === 'items') loadItems()
  if (what === 'settings') loadSettings()
  if (what === 'hooks') loadHooks()
}))
async function api(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) throw new Error(payload.message || ('HTTP ' + response.status))
  return payload
}
function itemCard(item) {
  const kind = item.kind === 'pr' ? 'PR' : 'SPV 决策'
  const title = item.kind === 'pr'
    ? escapeHtml(item.repo || '') + ' #' + escapeHtml(item.pr ?? '')
    : escapeHtml(item.title || item.id)
  const meta = item.kind === 'pr' ? escapeHtml(item.state || '') : escapeHtml(item.thread || 'main')
  const body = escapeHtml(item.body || '')
  return '<div class="card" data-id="' + escapeHtml(item.id) + '">' +
    '<div class="row"><span class="tag">' + kind + '</span><strong>' + title + '</strong>' +
    '<span class="dim grow">' + meta + '</span></div>' +
    (body ? '<pre class="dim" style="margin:8px 0">' + body.slice(0, 1200) + '</pre>' : '') +
    '<div class="row" style="margin-top:8px"><textarea placeholder="通过理由（可空）；有问题时必填" data-comment></textarea></div>' +
    '<div class="row" style="margin-top:6px"><button class="primary" data-review="approve">通过</button>' +
    '<button class="ghost" data-review="issue">有问题</button><span class="dim" data-result></span></div></div>'
}
async function loadItems() {
  try {
    const payload = await api(ITEMS_URL)
    const items = Array.isArray(payload.items) ? payload.items : []
    $('#inboxMeta').textContent = items.length + ' 封信'
    $('#items').innerHTML = items.length === 0 ? '<div class="card dim">收件箱是空的。</div>' : items.map(itemCard).join('')
    document.querySelectorAll('#items .card').forEach(card => {
      card.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', async () => {
        const comment = card.querySelector('[data-comment]').value.trim()
        const result = card.querySelector('[data-result]')
        button.disabled = true
        result.textContent = ''
        try {
          await api(REVIEW_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: card.dataset.id, kind: button.dataset.review, text: comment }) })
          result.textContent = button.dataset.review === 'approve' ? '已通过' : '已记录问题'
          setTimeout(loadItems, 500)
        } catch (error) {
          result.textContent = String(error.message || error)
          result.classList.add('bad')
          button.disabled = false
        }
      }))
    })
  } catch (error) {
    $('#items').innerHTML = '<div class="card bad">加载收件箱失败：' + escapeHtml(error.message) + '</div>'
  }
}
function fieldFor(key, value) {
  const id = 'value-' + key.replace(/[^A-Za-z0-9._-]/g, '_')
  if (typeof value === 'boolean') return '<label><input type="checkbox" id="' + id + '" data-key="' + escapeHtml(key) + '" data-kind="boolean"' + (value ? ' checked' : '') + '> 开启</label>'
  if (typeof value === 'number') return '<input type="number" id="' + id + '" data-key="' + escapeHtml(key) + '" data-kind="number" value="' + escapeHtml(value) + '">'
  if (key === 'webui.style') return '<select id="' + id + '" data-key="' + escapeHtml(key) + '" data-kind="text"><option value="fluid"' + (value === 'fluid' ? ' selected' : '') + '>fluid</option><option value="minimal"' + (value === 'minimal' ? ' selected' : '') + '>minimal</option></select>'
  return '<input type="text" id="' + id + '" data-key="' + escapeHtml(key) + '" data-kind="text" value="' + escapeHtml(value) + '">'
}
function renderSettings(payload) {
  snapshot = payload
  // values carries only explicit overrides; the form must show every key, so read the resolved
  // rows (effective value + source) and fall back to effective for an older host.
  const effective = payload.effective || payload.values || {}
  const keys = Array.isArray(payload.rows)
    ? payload.rows.map(row => row.key).sort()
    : Object.keys(effective).sort()
  $('#settingsMeta').textContent = 'revision ' + payload.revision
  const rows = keys.map(key => {
    const row = Array.isArray(payload.rows) ? payload.rows.find(item => item.key === key) : undefined
    const label = '<span class="dim" title="' + escapeHtml(key) + '">' + escapeHtml(key) +
      (row?.source && row.source !== 'default' ? ' <small>(' + escapeHtml(row.source) + ')</small>' : '') + '</span>'
    return label + fieldFor(key, row?.value ?? effective[key])
  }).join('')
  $('#settingsForm').innerHTML = '<div class="grid">' + rows + '</div>' +
    '<div class="row" style="margin-top:12px"><button class="primary" id="saveSettings">保存设置</button><span class="dim" id="settingsResult"></span></div>'
  $('#saveSettings').addEventListener('click', async () => {
    const values = {}
    document.querySelectorAll('#settingsForm [data-key]').forEach(input => {
      let value = input.dataset.kind === 'boolean' ? input.checked : input.value
      if (input.dataset.kind === 'number') value = Number(value)
      values[input.dataset.key] = value
    })
    const button = $('#saveSettings')
    button.disabled = true
    $('#settingsResult').textContent = ''
    try {
      const payload = await api(SETTINGS_URL, { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ revision: snapshot.revision, values }) })
      renderSettings(payload)
      $('#settingsResult').textContent = '已保存，revision ' + payload.revision
    } catch (error) {
      $('#settingsResult').textContent = String(error.message || error)
      $('#settingsResult').classList.add('bad')
      button.disabled = false
    }
  })
}
async function loadSettings() {
  try { renderSettings(await api(SETTINGS_URL)) } catch (error) { $('#settingsForm').innerHTML = '<div class="card bad">加载设置失败：' + escapeHtml(error.message) + '</div>' }
}
async function loadHooks() {
  try {
    const payload = await api(SETTINGS_URL)
    snapshot = payload
    const view = payload.hookView
    if (view === null || view === undefined) {
      $('#hooksView').innerHTML = '<div class="card bad">' + escapeHtml(payload.hookViewError || '当前 host 没有返回插口视图。') + '</div>'
      return
    }
    const events = Array.isArray(view.events) ? view.events : []
    const rows = [
      ...(Array.isArray(view.items) ? view.items : []),
      ...(Array.isArray(view.builtin) ? view.builtin : []),
    ]
    $('#hooksMeta').textContent = (view.summary ? JSON.stringify(view.summary) : '') + ' revision ' + payload.revision
    $('#hooksView').innerHTML = events.map(event => {
      const own = rows.filter(row => Array.isArray(row.events) && row.events.includes(event.id))
      const rowHtml = own.map(row => '<div class="card"><div class="row"><span class="tag">' + escapeHtml(row.kind || row.layer || 'row') + '</span><strong>' + escapeHtml(row.label || row.id) + '</strong><span class="dim grow">' + escapeHtml(row.id) + '</span></div>' +
        (row.description ? '<p class="dim">' + escapeHtml(row.description) + '</p>' : '') +
        '<div class="row"><input data-hook-label="' + escapeHtml(row.id) + '" placeholder="显示名称" value="' + escapeHtml(row.customLabel || '') + '"><button class="ghost" data-hook-save="' + escapeHtml(row.id) + '">保存名称</button><span class="dim" data-hook-result></span></div></div>').join('')
      return '<div class="hooks-event"><h3 style="font-size:15px">' + escapeHtml(event.title || event.id) + ' <span class="dim">' + escapeHtml(event.id) + '</span></h3>' +
        (event.description ? '<p class="dim">' + escapeHtml(event.description) + '</p>' : '') + (rowHtml || '<div class="card dim">这个事件没有行。</div>') + '</div>'
    }).join('')
    document.querySelectorAll('[data-hook-save]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.hookSave
      const input = document.querySelector('[data-hook-label="' + CSS.escape(id) + '"]')
      const result = button.parentElement.querySelector('[data-hook-result]')
      button.disabled = true
      try {
        const payload = await api(SETTINGS_URL, { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ revision: snapshot.revision, hooks: { labels: { [id]: input.value } } }) })
        snapshot = payload
        result.textContent = '已保存'
      } catch (error) {
        result.textContent = String(error.message || error)
        result.classList.add('bad')
      } finally { button.disabled = false }
    }))
  } catch (error) {
    $('#hooksView').innerHTML = '<div class="card bad">加载插口失败：' + escapeHtml(error.message) + '</div>'
  }
}
loadItems()
loadSettings()
</script>
</body>
</html>`
