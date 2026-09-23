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
  items: [], counts: {}, status: {}, selId: null, detail: null, filesBy: {}, drafts: {}, sending: null, sendErr: {}, sentOk: {},
  seen: ls.get('koh.seen', {}),
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  const headers = {};
  if (opts.json) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  let res;
  try { res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: opts.body, credentials: 'same-origin' }); }
  catch { throw new Error('אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'); }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error((data && data.error) || 'יש להתחבר מחדש'); }
  if (!res.ok) throw new Error(httpError(res.status, data));
  return data || {};
}

function httpError(status, data) {
  if (data && data.error) return data.error;
  if (status === 413) return 'הקבצים גדולים מדי לשליחה.';
  if (status >= 502 && status <= 504) return 'השרת לא הגיב בזמן (ייתכן שהוא מתעורר משינה). נסו שוב בעוד דקה.';
  return `שגיאה בתקשורת עם השרת (${status}).`;
}

// הודעות קופצות: הצלחה נעלמת מהר, שגיאה נשארת עד שסוגרים (או 10 שניות)
const TOAST_ICON = { ok: '✓', err: '!', info: 'i', wait: '' };
function toast(msg, kind = 'info', ms) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = `<span class="t-ic">${kind === 'wait' ? '<span class="spin"></span>' : TOAST_ICON[kind] || 'i'}</span><span class="t-msg">${esc(msg)}</span><button class="t-x" title="סגירה">✕</button>`;
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.querySelector('.t-x').onclick = close;
  box.appendChild(t);
  const life = ms ?? (kind === 'err' ? 10000 : kind === 'wait' ? 0 : 3500);
  if (life) setTimeout(close, life);
  return { close, set(m, k) { t.className = 'toast ' + k; t.querySelector('.t-msg').textContent = m; t.querySelector('.t-ic').innerHTML = TOAST_ICON[k] || 'i'; setTimeout(close, k === 'err' ? 10000 : 3500); } };
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
const MB = 1048576, MAX_FILE = 20 * MB, MAX_TOTAL = 24 * MB, MAX_FILES = 10;
function fileIcon(name, type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return '🖼️';
  if (ext === 'pdf') return '📕';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}
const filesOf = id => (S.filesBy[id] ||= []);
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
  else if (st.loading && st.loading.total) { dot = 'dot wait'; txt = `טוען מיילים: ${st.loading.done} מתוך ${st.loading.total}…`; }
  else if (!st.ready) { dot = 'dot wait'; txt = 'טוען מיילים מהתיבה…'; }
  else { txt = `מחובר ל-${S.cfg.inbox} · עודכן ${st.lastSync ? ago(st.lastSync) : ''}`; }
  $('#sync').innerHTML = `<span class="${dot}"></span><span>${esc(txt)}</span>`;
  const b = $('#banner');
  if (st.error) { b.hidden = false; b.className = 'banner'; b.textContent = '⚠️ ' + st.error; }
  else if (st.send && st.send.ok === false) { b.hidden = false; b.className = 'banner'; b.textContent = '⚠️ שליחת מיילים לא זמינה כרגע – אפשר לקרוא פניות, אבל תשובות לא יישלחו. ' + (st.send.error || ''); }
  else if (st.loading && st.loading.total) { b.hidden = false; b.className = 'banner info'; b.textContent = `⏳ טוען מיילים מהתיבה: ${st.loading.done} מתוך ${st.loading.total}…`; }
  else if (!st.ready) { b.hidden = false; b.className = 'banner info'; b.textContent = '⏳ המערכת טוענת את כל המיילים מהתיבה. זה לוקח רגע בהפעלה הראשונה.'; }
  else if (recentImports(st).length) {
    const list = recentImports(st);
    b.hidden = false; b.className = 'banner ' + (list.some(r => r.error) ? '' : 'ok');
    b.innerHTML = list.map(importLine).join('<br>');
  }
  else b.hidden = true;
}

// ייבוא הודעות מאאוטלוק – סיכום של מה שיובא ב-30 הדקות האחרונות
const recentImports = st => (st.imports || []).filter(r => Date.now() - Date.parse(r.at) < 30 * 60e3).slice(0, 4);
function importLine(r) {
  const what = r.labels && r.labels.length ? ` (${esc(r.labels.join(', '))})` : '';
  if (r.error) return `⚠️ ייבוא "${esc(r.subject)}" לא בוצע: ${esc(r.error)}`;
  let t = `📥 יובאו <b>${r.added}</b> הודעות${what}`;
  if (r.dup) t += ` · ${r.dup} כבר היו במערכת ודולגו`;
  if (r.failed) t += ` · ${r.failed} לא נקראו`;
  if (r.unknown && r.unknown.length) t += ` · לא זוהה בנושא: "${esc(r.unknown.join('", "'))}" (יובאו בלי הסיווג הזה)`;
  return t + ` · ${ago(r.at)}`;
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
        ${String(m.id).startsWith('pending') ? '<div class="sending">✓ נשלח ללקוח</div>' : ''}
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
  else if (d.status === 'handled') actions = `
    <button class="btn primary" data-act="take" title="למשל: נזכרתם להוסיף משהו ללקוח">🙋 אני מטפל/ת בזה (תגובה נוספת)</button>
    <button class="btn amber" data-act="reopen">🔄 החזר לפתוחות</button>`;
  else if (['escalated', 'ignored'].includes(d.status)) actions = `<button class="btn amber" data-act="reopen">🔄 החזר לפתוחות</button>`;

  let owner = '';
  if (d.status === 'in_progress') owner = `<span class="owner">${avatar(d.assigneeName, teamColor(d.assignee), 'sm team')} ${mine ? 'בטיפול שלך' : `בטיפול של <b>${esc(d.assigneeName)}</b>`}</span>`;

  let composer;
  if (mine) composer = composerHtml(d);
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
  renderFiles();
  renderSendState();
  const cv = $("#convo"); requestAnimationFrame(() => { cv.scrollTop = cv.scrollHeight; });
}

function composerHtml(d) {
  const blocked = S.status.send && S.status.send.ok === false;
  return `
    <form class="composer" id="composer" novalidate>
      <div class="c-head">✉️ תשובה אל <b>${esc(d.fromName)}</b> <span class="c-addr">${esc(d.fromEmail)}</span> · תישלח במייל באותה שרשרת</div>
      ${blocked ? `<div class="c-warn">⚠️ שליחת מיילים לא זמינה כרגע בשרת, ולכן התשובה כנראה לא תישלח. אפשר לכתוב – הטיוטה נשמרת.</div>` : ''}
      <div class="c-box" id="c-box">
        <textarea id="reply-body" placeholder="כתבו כאן את התשובה…">${esc(S.drafts[d.id] || '')}</textarea>
        <div class="files" id="files"></div>
        <div class="c-foot">
          <span class="c-hint">אפשר לגרור קבצים לכאן · Ctrl+Enter לשליחה</span>
          <div class="c-btns">
            <label class="btn ghost sm file-btn">📎 צירוף קובץ<input type="file" id="file-input" multiple hidden></label>
            <button class="btn primary" type="submit" id="send-btn">שליחה ➤</button>
          </div>
        </div>
        <div class="drop-hint">📎 שחררו כאן כדי לצרף</div>
      </div>
      <div id="send-state"></div>
    </form>`;
}

function renderFiles() {
  const fl = $('#files'); if (!fl || !S.detail) return;
  const files = filesOf(S.detail.id);
  const total = files.reduce((a, f) => a + f.size, 0);
  const locked = S.sending === S.detail.id;
  fl.hidden = !files.length;
  fl.innerHTML = files.map((f, i) => `
    <span class="file">
      <span class="f-ic">${fileIcon(f.name, f.type)}</span>
      <span class="f-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="f-sz">${fmtSize(f.size)}</span>
      ${locked ? '' : `<button type="button" data-rm="${i}" title="הסרת הקובץ">✕</button>`}
    </span>`).join('') +
    (files.length ? `<span class="f-total ${total > MAX_TOTAL ? 'bad' : ''}">${files.length} ${files.length === 1 ? 'קובץ' : 'קבצים'} · ${fmtSize(total)}${total > MAX_TOTAL ? ' – מעל 24MB, הסירו קבצים' : ''}</span>` : '');
}

function addFiles(list) {
  if (!S.detail || S.sending === S.detail.id) return;
  const files = filesOf(S.detail.id), problems = [];
  for (const f of list) {
    if (!f.size) { problems.push(`"${f.name}" ריק או שאינו קובץ`); continue; }
    if (f.size > MAX_FILE) { problems.push(`"${f.name}" גדול מדי (${fmtSize(f.size)}). המקסימום לקובץ הוא 20MB`); continue; }
    if (files.length >= MAX_FILES) { problems.push(`אפשר לצרף עד ${MAX_FILES} קבצים`); break; }
    if (files.some(x => x.name === f.name && x.size === f.size)) continue;
    files.push(f);
  }
  renderFiles();
  if (problems.length) toast(problems.join(' · '), 'err');
}

// מצב השליחה בתוך אזור הכתיבה: התקדמות, הצלחה או שגיאה עם "נסו שוב"
function renderSendState(p) {
  const el = $('#send-state'); if (!el || !S.detail) return;
  const id = S.detail.id;
  const box = $('#c-box'), btn = $('#send-btn'), ta = $('#reply-body'), fb = $('.file-btn');
  const busy = S.sending === id;
  if (box) box.classList.toggle('busy', busy);
  if (ta) ta.readOnly = busy;
  if (btn) { btn.disabled = busy; btn.innerHTML = busy ? '<span class="spin"></span> שולח…' : 'שליחה ➤'; }
  if (fb) fb.classList.toggle('disabled', busy);
  if (busy) {
    p = p || S.sendProgress || { stage: 'send' };
    const hasFiles = p.total > 0;
    const pct = hasFiles ? Math.round((p.loaded / p.total) * 100) : 0;
    const step = (n, label, state, extra = '') => `<div class="st ${state}"><span class="st-dot">${state === 'done' ? '✓' : n}</span><span>${label}${extra}</span></div>`;
    const same = el.firstElementChild && el.firstElementChild.classList.contains('progress');
    el.innerHTML = `<div class="send-box progress${same ? ' still' : ''}">
      ${hasFiles ? step(1, 'מעלה את הקבצים לשרת', p.stage === 'upload' ? 'now' : 'done', p.stage === 'upload' ? ` · ${pct}% (${fmtSize(p.loaded)} מתוך ${fmtSize(p.total)})` : '') : ''}
      ${step(hasFiles ? 2 : 1, 'שולח את המייל ללקוח', p.stage === 'send' ? 'now' : '', p.stage === 'send' ? ' – זה יכול לקחת כמה שניות' : '')}
      <div class="bar ${p.stage === 'send' ? 'indet' : ''}"><span style="width:${p.stage === 'upload' ? pct : 100}%"></span></div>
    </div>`;
  } else if (S.sendErr[id]) {
    el.innerHTML = `<div class="send-box err" role="alert">
      <div class="se-title">✕ התשובה לא נשלחה</div>
      <div class="se-msg">${esc(S.sendErr[id])}</div>
      <div class="se-foot">הטקסט והקבצים נשמרו – לא צריך לכתוב מחדש.
        <button type="button" class="btn sm red" id="retry-btn">↻ נסו לשלוח שוב</button>
        <button type="button" class="btn ghost sm" id="err-x">סגירה</button></div>
    </div>`;
  } else if (S.sentOk[id]) {
    el.innerHTML = `<div class="send-box ok" role="status">✓ התשובה נשלחה בהצלחה ל-<b>${esc(S.sentOk[id])}</b>.</div>`;
  } else el.innerHTML = '';
}

// שליחה עם מעקב התקדמות (XHR – כדי לראות את העלאת הקבצים)
function postWithProgress(url, fd, onUp) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api' + url);
    x.timeout = 180000;
    x.upload.onprogress = e => e.lengthComputable && onUp(e.loaded, e.total);
    x.upload.onload = () => onUp(-1, -1);
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch {}
      if (x.status === 401) { showLogin(); return reject(new Error('פג תוקף הכניסה – התחברו שוב ונסו לשלוח.')); }
      if (x.status >= 200 && x.status < 300 && data) resolve(data); else reject(new Error(httpError(x.status, data)));
    };
    x.onerror = () => reject(new Error('אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'));
    x.ontimeout = () => reject(new Error('השליחה לקחה יותר מדי זמן ונעצרה. ייתכן שהמייל לא נשלח – רעננו את הפניה ובדקו לפני שליחה חוזרת.'));
    x.send(fd);
  });
}

async function sendReply() {
  const d = S.detail; if (!d || S.sending) return;
  const id = d.id;
  const body = ($('#reply-body').value || '').trim();
  if (!body) { $('#reply-body').focus(); $('#c-box').classList.add('shake'); setTimeout(() => $('#c-box')?.classList.remove('shake'), 500); return toast('כתבו תשובה לפני השליחה', 'err', 4000); }
  const files = filesOf(id);
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL) return toast('הקבצים גדולים מדי יחד (מעל 24MB). הסירו חלק מהם ונסו שוב.', 'err');
  const fd = new FormData(); fd.append('body', body); files.forEach(f => fd.append('files', f));

  S.sending = id; delete S.sendErr[id]; delete S.sentOk[id];
  S.sendProgress = files.length ? { stage: 'upload', loaded: 0, total } : { stage: 'send' };
  renderFiles(); renderSendState();
  try {
    const res = await postWithProgress(`/inquiries/${encodeURIComponent(id)}/reply`, fd, (loaded, tot) => {
      S.sendProgress = loaded < 0 || loaded >= tot ? { stage: 'send', loaded: total, total } : { stage: 'upload', loaded, total: tot };
      if (S.detail && S.detail.id === id) renderSendState();
    });
    S.sending = null; S.sendProgress = null;
    delete S.drafts[id]; S.filesBy[id] = []; S.sentOk[id] = d.fromEmail;
    toast(`התשובה נשלחה ל-${d.fromName} ✓`, 'ok');
    if (S.detail && S.detail.id === id) { S.detail = res; renderDetail(); }
    loadList().catch(() => {});
  } catch (err) {
    S.sending = null; S.sendProgress = null; S.sendErr[id] = err.message;
    if (S.detail && S.detail.id === id) { renderFiles(); renderSendState(); $('#send-state')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    else toast(err.message, 'err');
  }
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
  if (action === 'release' && ($('#reply-body')?.value.trim() || filesOf(d.id).length) && !confirm('יש טיוטה שלא נשלחה. לשחרר את הפניה בכל זאת? (הטיוטה תישמר)')) return;
  const clicked = document.querySelector(`[data-act="${action}"]`);
  document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = true));
  if (clicked) clicked.innerHTML = '<span class="spin"></span> ' + clicked.textContent.replace(/^\S+\s/, '');
  try {
    S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/${action}`, { method: 'POST' });
    delete S.sentOk[d.id];
    toast(msgs[action] || 'עודכן', 'ok');
    await loadList(); renderDetail();
    if (action === 'take') $('#reply-body')?.focus();
  } catch (e) { toast(e.message, 'err'); await refresh().catch(() => {}); }
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
    const rm = e.target.closest('[data-rm]'); if (rm) { filesOf(S.detail.id).splice(+rm.dataset.rm, 1); renderFiles(); return; }
    if (e.target.closest('#retry-btn')) return sendReply();
    if (e.target.closest('#err-x')) { delete S.sendErr[S.detail.id]; renderSendState(); return; }
    const c = e.target.closest('.cat-toggle');
    if (c) {
      const d = S.detail, k = c.dataset.cat;
      const cats = d.categories.includes(k) ? d.categories.filter(x => x !== k) : [...d.categories.filter(x => x !== 'general'), k];
      try { S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/categories`, { method: 'POST', json: { categories: cats } }); renderDetail(); loadList(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });
  det.addEventListener('change', e => { if (e.target.id === 'file-input') { addFiles([...e.target.files]); e.target.value = ''; } });
  // גרירת קבצים והדבקת תמונות
  let dragN = 0;
  det.addEventListener('dragenter', e => { if (!$('#c-box') || !e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); dragN++; $('#c-box').classList.add('drag'); });
  det.addEventListener('dragover', e => { if ($('#c-box') && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  det.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#c-box')?.classList.remove('drag'); } });
  det.addEventListener('drop', e => { if (!$('#c-box')) return; e.preventDefault(); dragN = 0; $('#c-box').classList.remove('drag'); addFiles([...e.dataTransfer.files]); });
  det.addEventListener('paste', e => { if (e.target.id !== 'reply-body') return; const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
  det.addEventListener('keydown', e => { if (e.target.id === 'reply-body' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } });
  det.addEventListener('input', e => { if (e.target.id === 'reply-body') S.drafts[S.detail.id] = e.target.value; });
  det.addEventListener('submit', e => { e.preventDefault(); sendReply(); });

  $('#dlg-escalate').addEventListener('close', async () => {
    if ($('#dlg-escalate').returnValue !== 'ok') return;
    const t = toast('מעביר למנהל – אוסף את כל ההתכתבות והקבצים ושולח…', 'wait');
    document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = true));
    try {
      S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/escalate`, { method: 'POST', json: { note: $('#esc-note').value } });
      t.set(`הפניה הועברה למנהל (${S.cfg.manager}) ✓`, 'ok'); await loadList(); renderDetail();
    } catch (e) { t.set('ההעברה למנהל נכשלה: ' + e.message, 'err'); document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = false)); }
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
  loadList().catch(err => toast(err.message, 'err'));
  setInterval(async () => {
    if (document.hidden || document.querySelector('dialog[open]') || $('#app').hidden) return;
    await loadList().catch(() => {});
    const busy = S.sending || document.activeElement?.id === 'reply-body' || (S.selId && filesOf(S.selId).length);
    if (S.selId && !busy) {
      const fresh = await api('/inquiries/' + encodeURIComponent(S.selId)).catch(() => null);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(S.detail)) { S.detail = fresh; renderDetail(); }
    }
  }, 20000);
}

window.addEventListener('beforeunload', e => { if (S.sending) { e.preventDefault(); e.returnValue = ''; } });

(async function boot() {
  bindLogin();
  const pub = await fetch('/api/public').then(r => r.json()).catch(() => ({ team: [] }));
  if (pub.me) startApp(); else showLogin(pub.team);
})();
