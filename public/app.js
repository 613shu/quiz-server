/* דשבורד ניהול פניות – צד לקוח */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const STATUS = { new: 'חדשה', in_progress: 'בטיפול', handled: 'טופלה', escalated: 'הועברה למנהל', ignored: 'הוסתרה' };
const STATUS_COLOR = { new: 'var(--blue)', in_progress: 'var(--amber)', handled: 'var(--green)', escalated: 'var(--violet)', ignored: '#b5bad0' };
const TABS = [['open', 'פתוחות'], ['mine', 'שלי'], ['handled', 'טופלו'], ['escalated', 'הועברו למנהל'], ['ignored', 'הוסתרו']];
const TEAM_COLORS = ['#e8488a', '#0f9f8f', '#f08c1a', '#7c4dff', '#3b6cf6', '#16a36a'];
const CUST_COLORS = ['#3b6cf6', '#7c4dff', '#0f9f8f', '#e8488a', '#f08c1a', '#0ea5e9', '#16a36a', '#c2410c'];
const EVENT_ICON = { take: '🙋', release: '↩️', handled: '✅', reopen: '🔄', escalate: '↗️', categories: '🏷️', ignore: '🙈', reply: '✉️' };

const S = {
  cfg: null, me: null, view: 'open', category: null, q: '',
  items: [], counts: {}, status: {}, selId: null, detail: null, files: [], drafts: {},
  seen: ls.get('koh.seen', {}),
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  const headers = {};
  if (opts.json) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: opts.body, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error(data.error || 'יש להתחבר'); }
  if (!res.ok) throw new Error(data.error || 'שגיאה בתקשורת עם השרת');
  return data;
}

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3000);
}

const initials = n => { const w = String(n || '?').replace(/["'<>]/g, '').trim().split(/\s+/); return (w[0]?.[0] || '?') + (w[1]?.[0] || ''); };
const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const custColor = key => CUST_COLORS[hash(key) % CUST_COLORS.length];
const teamColor = key => { const i = (S.cfg?.team || []).findIndex(u => u.key === key); return TEAM_COLORS[(i < 0 ? 0 : i) % TEAM_COLORS.length]; };
const avatar = (name, color, cls = '') => `<span class="avatar ${cls}" style="--c:${color}">${esc(initials(name))}</span>`;
const catOf = k => S.cfg.categories.find(c => c.key === k) || { key: k, name: k, color: '#64748b' };
const catPill = k => { const c = catOf(k); return `<span class="cat" style="--c:${c.color}">${esc(c.name)}</span>`; };

function fmtTime(iso) {
  const d = new Date(iso), now = new Date();
  const hm = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const diff = dayDiff(d, now);
  if (diff === 0) return hm;
  if (diff === 1) return 'אתמול';
  if (diff < 7) return d.toLocaleDateString('he-IL', { weekday: 'long' });
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
}
const dayDiff = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
function dayLabel(iso) {
  const d = new Date(iso), diff = dayDiff(d, new Date());
  if (diff === 0) return 'היום';
  if (diff === 1) return 'אתמול';
  return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}
const hm = iso => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'עכשיו';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  return `לפני ${Math.round(s / 3600)} שע׳`;
}

// ---------- login ----------
function showLogin(team) {
  $('#app').hidden = true; $('#login').hidden = false;
  const render = t => {
    $('#login-empty').hidden = t.length > 0;
    $('#login-users').innerHTML = t.map((u, i) => `<button class="login-user" data-key="${esc(u.key)}" data-name="${esc(u.name)}" style="--c:${TEAM_COLORS[i % TEAM_COLORS.length]}">
      ${avatar(u.name, TEAM_COLORS[i % TEAM_COLORS.length], 'team')} ${esc(u.name)}</button>`).join('');
  };
  if (team) render(team); else fetch('/api/public').then(r => r.json()).then(d => render(d.team));
}

function bindLogin() {
  let chosen = null;
  $('#login-users').addEventListener('click', e => {
    const b = e.target.closest('[data-key]'); if (!b) return;
    chosen = b.dataset.key;
    $('#login-who').innerHTML = b.innerHTML;
    $('#login-step1').hidden = true; $('#login-step2').hidden = false;
    $('#login-err').textContent = ''; $('#login-pass').value = ''; $('#login-pass').focus();
  });
  $('#login-back').addEventListener('click', () => { $('#login-step1').hidden = false; $('#login-step2').hidden = true; });
  $('#login-step2').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', json: { key: chosen, password: $('#login-pass').value } });
      $('#login').hidden = true;
      $('#login-step1').hidden = false; $('#login-step2').hidden = true;
      startApp();
    } catch (err) { $('#login-err').textContent = err.message; }
  });
}

// ---------- rendering ----------
function renderTop() {
  const st = S.status || {};
  let dot = 'dot', txt;
  if (st.error && !st.connected) { dot = 'dot bad'; txt = 'לא מחובר לתיבת המייל'; }
  else if (!st.ready) { dot = 'dot wait'; txt = 'טוען מיילים מהתיבה…'; }
  else { txt = `מחובר ל-${S.cfg.inbox} · עודכן ${st.lastSync ? ago(st.lastSync) : ''}`; }
  $('#sync').innerHTML = `<span class="${dot}"></span><span>${esc(txt)}</span>`;
  const b = $('#banner');
  if (st.error) { b.hidden = false; b.className = 'banner'; b.textContent = '⚠️ ' + st.error; }
  else if (!st.ready) { b.hidden = false; b.className = 'banner info'; b.textContent = '⏳ המערכת טוענת את כל המיילים מהתיבה. זה לוקח רגע בהפעלה הראשונה.'; }
  else b.hidden = true;
}

function renderStats() {
  const c = S.counts;
  const cards = [
    ['open', '📥', c.new || 0, 'חדשות – מחכות לטיפול', 'var(--blue)'],
    ['open', '⏳', c.in_progress || 0, 'בטיפול כרגע', 'var(--amber)'],
    ['mine', '🙋', c.mine || 0, 'בטיפול שלי', 'var(--pink)'],
    ['handled', '✅', c.handled || 0, 'טופלו', 'var(--green)'],
  ];
  $('#stats').innerHTML = cards.map(([v, ic, n, l, col], i) =>
    `<div class="stat ${S.view === v && (i !== 1) ? 'on' : ''}" data-view="${v}" style="--c:${col}">
      <div class="stat-ic">${ic}</div><div><div class="num">${n}</div><div class="lbl">${l}</div></div></div>`).join('');
}

function renderTabs() {
  const c = S.counts;
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab ${S.view === k ? 'active' : ''}" data-view="${k}">${l}<span class="cnt">${k === 'open' ? c.open : k === 'mine' ? c.mine : c[k] || 0}</span></button>`).join('');
}

function renderChips() {
  const by = S.counts.byCategory || {};
  $('#chips').innerHTML = `<button class="chip ${!S.category ? 'active' : ''}" data-cat="" style="--c:var(--ink-2)">הכל</button>` +
    S.cfg.categories.map(c => `<button class="chip ${S.category === c.key ? 'active' : ''}" data-cat="${c.key}" style="--c:${c.color}">${esc(c.name)}${by[c.key] ? `<span class="n">${by[c.key]}</span>` : ''}</button>`).join('');
}

const isUnread = it => it.status === 'new' && S.seen[it.id] !== it.lastIncoming;

function renderList() {
  const el = $('#list');
  if (!S.items.length) {
    const empty = S.view === 'open' && !S.q && !S.category;
    el.innerHTML = `<li class="empty-list"><div class="big">${empty ? '🎉' : '🔍'}</div>${empty ? 'אין פניות פתוחות – כל הכבוד!' : 'לא נמצאו פניות'}</li>`;
    return;
  }
  el.innerHTML = S.items.map(it => `
    <li class="inq ${it.id === S.selId ? 'sel' : ''}" data-id="${esc(it.id)}" style="--s:${STATUS_COLOR[it.status]}">
      ${avatar(it.fromName, custColor(it.fromEmail))}
      <div class="inq-main">
        <div class="inq-row"><span class="inq-from">${isUnread(it) ? '<span class="unread-dot"></span>' : ''}${esc(it.fromName)}</span><span class="inq-time">${fmtTime(it.lastIncoming)}</span></div>
        <div class="inq-subj">${esc(it.subject)}</div>
        <div class="inq-snip">${esc(it.snippet)}</div>
        <div class="inq-meta">
          <span class="pill ${it.status}">${STATUS[it.status]}${it.status === 'in_progress' ? ' · ' + esc(it.assigneeName) : ''}</span>
          ${it.returned ? '<span class="pill returned">↩ הלקוח חזר</span>' : ''}
          ${it.categories.map(catPill).join('')}
          ${it.hasAttachments ? '<span class="mini">📎</span>' : ''}
          ${it.messageCount > 1 ? `<span class="mini">💬 ${it.messageCount}</span>` : ''}
        </div>
      </div>
    </li>`).join('');
}

function bubble(m) {
  const out = m.direction === 'out';
  const color = out ? (m.authorKey ? teamColor(m.authorKey) : '#3b6cf6') : custColor(S.detail.fromEmail);
  const who = out ? (m.author || 'הצוות') : m.name;
  const role = out ? (m.author ? 'מהצוות' : 'נשלח ישירות מהתיבה') : (m.email || '');
  return `
    <div class="row ${m.direction}">
      ${avatar(who, color, out ? 'sm team' : 'sm')}
      <div class="bubble" style="--c:${color}">
        <div class="b-head"><span class="b-who">${esc(who)}<span class="b-role">${esc(role)}</span></span><span class="b-time">${hm(m.date)}</span></div>
        <div class="b-body">${esc(m.body)}</div>
        ${m.quoted ? `<button class="q-toggle" data-q="${m.id}">··· הצג את ההודעה המצוטטת</button><div class="quoted" id="q-${m.id}" hidden>${esc(m.quoted)}</div>` : ''}
        ${m.attachments.length ? `<div class="atts">${m.attachments.map(a => a.id
          ? `<a class="att" href="/api/attachments/${encodeURIComponent(a.id)}">📎 ${esc(a.name)} <span class="sz">${fmtSize(a.size)}</span></a>`
          : `<span class="att">📎 ${esc(a.name)}</span>`).join('')}</div>` : ''}
        ${String(m.id).startsWith('pending') ? '<div class="sending">✓ נשלח</div>' : ''}
      </div>
    </div>`;
}

function timeline(d) {
  const items = [
    ...d.messages.map(m => ({ at: m.date, html: bubble(m) })),
    ...d.events.filter(e => e.action !== 'reply').map(e => {
      const c = e.userKey ? teamColor(e.userKey) : '#8a90ab';
      return { at: e.at, html: `<div class="event" style="--c:${c}">${EVENT_ICON[e.action] || '•'} <b>${esc(e.user || '')}</b> ${esc(e.text)} · ${hm(e.at)}</div>` };
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let lastDay = null, html = '';
  for (const it of items) {
    const day = dayLabel(it.at);
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
    html += it.html;
  }
  return html;
}

function renderDetail() {
  const d = S.detail, el = $('#detail');
  if (!d) { el.innerHTML = `<div class="empty-detail"><div class="big">💬</div><div>בחרו פניה מהרשימה כדי לראות את כל השיחה</div></div>`; return; }
  const me = S.me.key;
  const mine = d.status === 'in_progress' && d.assignee === me;
  const other = d.status === 'in_progress' && d.assignee !== me;

  let actions = '';
  if (d.status === 'new') actions = `
    <button class="btn primary" data-act="take">🙋 אני מטפל/ת בזה</button>
    <button class="btn green" data-act="handled">✓ סמן כטופל</button>
    <button class="btn violet" data-act="escalate">↗ העבר למנהל</button>
    <button class="btn ghost sm" data-act="ignore" title="למשל: פרסומת או הודעת מערכת">🙈 לא פניה</button>`;
  else if (mine) actions = `
    <button class="btn green" data-act="handled">✓ סמן כטופל</button>
    <button class="btn violet" data-act="escalate">↗ העבר למנהל</button>
    <button class="btn ghost sm" data-act="release">↩ שחרר</button>`;
  else if (['handled', 'escalated', 'ignored'].includes(d.status)) actions = `<button class="btn amber" data-act="reopen">🔄 החזר לפתוחות</button>`;

  let owner = '';
  if (d.status === 'in_progress') owner = `<span class="owner">${avatar(d.assigneeName, teamColor(d.assignee), 'sm team')} ${mine ? 'בטיפול שלך' : `בטיפול של <b>${esc(d.assigneeName)}</b>`}</span>`;

  let composer;
  if (mine) composer = `
    <form class="composer" id="composer">
      <div class="c-head">✉️ תשובה אל <b>${esc(d.fromName)}</b> · תישלח במייל באותה שרשרת</div>
      <div class="c-box">
        <textarea id="reply-body" placeholder="כתבו כאן את התשובה…">${esc(S.drafts[d.id] || '')}</textarea>
        <div class="c-foot">
          <div class="files" id="files"></div>
          <div style="display:flex;gap:8px">
            <label class="btn ghost sm" style="cursor:pointer">📎 צירוף קובץ<input type="file" id="file-input" multiple hidden></label>
            <button class="btn primary" type="submit" id="send-btn">שליחה ➤</button>
          </div>
        </div>
      </div>
    </form>`;
  else if (d.status === 'new') composer = `<div class="locked">כדי לענות, לחצו <b>"אני מטפל/ת בזה"</b>. כך אף אחד אחר לא יענה במקביל.</div>`;
  else if (other) composer = `<div class="locked">🔒 <b>${esc(d.assigneeName)}</b> מטפל/ת בפניה הזו. אפשר לקרוא, אבל לא לענות.</div>`;
  else composer = '';

  el.innerHTML = `
    <div class="d-head">
      <button class="btn ghost sm back-btn" data-act="back">→ חזרה לרשימה</button>
      <div class="d-top">
        ${avatar(d.fromName, custColor(d.fromEmail), 'lg')}
        <div class="d-who">
          <div class="d-name">${esc(d.fromName)}</div>
          <div class="d-email"><a href="mailto:${esc(d.fromEmail)}">${esc(d.fromEmail)}</a></div>
        </div>
      </div>
      <div class="d-subj">${esc(d.subject)}</div>
      <div class="d-state">
        <span class="pill ${d.status}">${STATUS[d.status]}</span>
        ${d.returned ? '<span class="pill returned">↩ הלקוח כתב שוב אחרי שענינו</span>' : ''}
        ${owner}
      </div>
      ${actions ? `<div class="d-actions">${actions}</div>` : ''}
      <div class="d-cats"><span class="lbl">🏷️ קטגוריה:</span>${S.cfg.categories.map(c =>
        `<button class="cat-toggle ${d.categories.includes(c.key) ? 'on' : ''}" data-cat="${c.key}" style="--c:${c.color}">${esc(c.name)}</button>`).join('')}</div>
    </div>
    <div class="convo" id="convo">${timeline(d)}</div>
    ${composer}`;
  S.files = [];
  renderFiles();
  const cv = $("#convo"); requestAnimationFrame(() => { cv.scrollTop = cv.scrollHeight; });
}

function renderFiles() {
  const fl = $('#files'); if (!fl) return;
  fl.innerHTML = S.files.map((f, i) => `<span class="file">📎 ${esc(f.name)}<button type="button" data-rm="${i}" title="הסרה">✕</button></span>`).join('');
}

// ---------- data ----------
async function loadList() {
  const p = new URLSearchParams({ view: S.view });
  if (S.category) p.set('category', S.category);
  if (S.q) p.set('q', S.q);
  const { items, counts, status } = await api('/inquiries?' + p);
  S.items = items; S.counts = counts; S.status = status;
  renderTop(); renderStats(); renderTabs(); renderChips(); renderList();
}

async function openInquiry(id) {
  S.selId = id;
  S.detail = await api('/inquiries/' + encodeURIComponent(id));
  const it = S.items.find(x => x.id === id);
  if (it) { S.seen[id] = it.lastIncoming; ls.set('koh.seen', S.seen); }
  renderList(); renderDetail();
  $('#layout').classList.add('show-detail');
}

async function act(action) {
  const d = S.detail;
  if (action === 'back') { $('#layout').classList.remove('show-detail'); return; }
  if (action === 'escalate') { $('#esc-note').value = ''; $('#dlg-escalate').returnValue = ''; $('#dlg-escalate').showModal(); return; }
  const msgs = { take: 'הפניה אצלך – אפשר לענות', release: 'הפניה שוחררה', handled: 'סומן כטופל ✓', reopen: 'הפניה חזרה לפתוחות', ignore: 'הוסתר – לא פניה' };
  document.querySelectorAll('[data-act]').forEach(b => (b.disabled = true));
  try {
    S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/${action}`, { method: 'POST' });
    toast(msgs[action] || 'עודכן', 'ok');
    await loadList(); renderDetail();
    if (action === 'take') $('#reply-body')?.focus();
  } catch (e) { toast(e.message, 'err'); await refresh(); }
}

async function refresh() {
  await loadList();
  if (S.selId) { S.detail = await api('/inquiries/' + encodeURIComponent(S.selId)).catch(() => null); renderDetail(); }
}

// ---------- events ----------
function bindApp() {
  const setView = v => { S.view = v; loadList(); };
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#stats').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#chips').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { S.category = b.dataset.cat || null; loadList(); } });
  let t; $('#search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; loadList(); }, 250); });
  $('#list').addEventListener('click', e => { const li = e.target.closest('[data-id]'); if (li) openInquiry(li.dataset.id).catch(err => toast(err.message, 'err')); });

  const det = $('#detail');
  det.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]'); if (a) return act(a.dataset.act);
    const q = e.target.closest('[data-q]');
    if (q) { const box = $('#q-' + q.dataset.q); box.hidden = !box.hidden; q.textContent = box.hidden ? '··· הצג את ההודעה המצוטטת' : '··· הסתר'; return; }
    const rm = e.target.closest('[data-rm]'); if (rm) { S.files.splice(+rm.dataset.rm, 1); renderFiles(); return; }
    const c = e.target.closest('.cat-toggle');
    if (c) {
      const d = S.detail, k = c.dataset.cat;
      const cats = d.categories.includes(k) ? d.categories.filter(x => x !== k) : [...d.categories.filter(x => x !== 'general'), k];
      try { S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/categories`, { method: 'POST', json: { categories: cats } }); renderDetail(); loadList(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });
  det.addEventListener('change', e => { if (e.target.id === 'file-input') { S.files.push(...e.target.files); e.target.value = ''; renderFiles(); } });
  det.addEventListener('input', e => { if (e.target.id === 'reply-body') S.drafts[S.detail.id] = e.target.value; });
  det.addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('#reply-body').value.trim();
    if (!body) return toast('כתבו תשובה לפני השליחה', 'err');
    const fd = new FormData(); fd.append('body', body); S.files.forEach(f => fd.append('files', f));
    const btn = $('#send-btn'); btn.disabled = true; btn.textContent = 'שולח…';
    try {
      S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/reply`, { method: 'POST', body: fd });
      delete S.drafts[S.detail.id];
      toast('התשובה נשלחה ללקוח ✓', 'ok');
      await loadList(); renderDetail();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'שליחה ➤'; }
  });

  $('#dlg-escalate').addEventListener('close', async () => {
    if ($('#dlg-escalate').returnValue !== 'ok') return;
    toast('מעביר למנהל…');
    try {
      S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/escalate`, { method: 'POST', json: { note: $('#esc-note').value } });
      toast('הפניה הועברה למנהל ✓', 'ok'); await loadList(); renderDetail();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
}

let started = false;
async function startApp() {
  S.cfg = await api('/config');
  S.me = S.cfg.me;
  $('#login').hidden = true; $('#app').hidden = false;
  $('#me-name').textContent = S.me.name;
  $('#me-avatar').outerHTML = avatar(S.me.name, teamColor(S.me.key), 'sm team').replace('<span', '<span id="me-avatar"');
  $('#mgr-addr').textContent = S.cfg.manager;
  if (!started) { bindApp(); started = true; }
  renderDetail();
  await loadList();
  setInterval(async () => {
    if (document.hidden || document.querySelector('dialog[open]') || $('#app').hidden) return;
    await loadList().catch(() => {});
    const busy = document.activeElement?.id === 'reply-body' || S.files.length;
    if (S.selId && !busy) {
      const fresh = await api('/inquiries/' + encodeURIComponent(S.selId)).catch(() => null);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(S.detail)) { S.detail = fresh; renderDetail(); }
    }
  }, 20000);
}

(async function boot() {
  bindLogin();
  const pub = await fetch('/api/public').then(r => r.json()).catch(() => ({ team: [] }));
  if (pub.me) startApp(); else showLogin(pub.team);
})();
