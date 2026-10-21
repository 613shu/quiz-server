/* דשבורד ניהול פניות – צד לקוח */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const STATUS = { new: 'חדשה', in_progress: 'בטיפול', handled: 'טופלה', escalated: 'הועברה למנהל', ignored: 'הוסתרה' };
const STATUS_COLOR = { new: 'var(--blue)', in_progress: 'var(--amber)', handled: 'var(--green)', tracking: 'var(--teal)', escalated: 'var(--violet)', ignored: '#b5bad0' };
// טופלה מתחלקת לשתיים: הושלם (ברירת מחדל) / במעקב (הנציגה סימנה שמחכים ללקוח)
const doneText = it => it.tracking ? 'טופלה · במעקב' : 'טופלה · הושלם';
const stKey = it => it.status === 'handled' && it.tracking ? 'tracking' : it.status;
const daysSince = iso => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400e3));
const trackAge = iso => { const n = daysSince(iso); return n === 0 ? 'נענתה היום' : n === 1 ? 'ממתינה יום אחד' : `ממתינה ${n} ימים`; };
// צבע קבוע לכל חבר צוות לפי סדר ההוספה (לא לפי דירוג) – פלטה שנבדקה לעיוורון צבעים על הרקע הכהה
const TEAM_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
// אייקוני קו שקטים (במקום אימוג׳י)
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ret: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-7.9"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const isMgr = () => !!(S.me && S.me.manager);
// תצוגות לפי תפקיד: [מפתח, שם, מונה]
function viewTabs() {
  const c = S.counts;
  if (!isMgr()) return [['open', 'פניות כלליות', c.general], ['mine', 'הפניות שלי', c.mine, c.mineReturned]];
  return [['open', 'כל הפתוחות', c.open], ['mine', 'הפניות שלי', c.mine, c.mineReturned], ['escalated', 'הועבר למנהל', c.escalatedOpen],
    ['overdue', 'ממתינות זמן רב', c.overdue], ['handled', 'טופלו – הושלם', c.handled], ['tracking', 'טופלו – במעקב', c.tracking], ['ignored', 'הוסתרו', c.ignored]];
}
const SUBS = [['open', 'לטיפול'], ['returned', 'חוזרות'], ['overdue', 'ממתינות'], ['done', 'הושלמו'], ['tracking', 'במעקב']];
const RANGES = [['', 'הכל'], ['0', 'היום'], ['6', '7 ימים'], ['29', '30 ימים']];
const CUST_COLORS = ['#3b6cf6', '#7c4dff', '#0f9f8f', '#e8488a', '#f08c1a', '#0ea5e9', '#16a36a', '#c2410c'];


const S = {
  cfg: null, me: null, view: 'open', sub: 'open', done: false, member: null, range: '', screen: 'inbox', category: null, q: '', byCategory: {}, subCounts: null, noteDraft: {},
  items: [], counts: {}, status: {}, selId: null, detail: null, filesBy: {}, drafts: {}, toBy: {}, sending: null, sendErr: {}, sentOk: {},
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
  if (status === 418) return 'הבקשה נחסמה בדרך לשרת – כנראה ע״י סינון האינטרנט או תוסף בדפדפן (418).';
  if (status >= 502 && status <= 504) return 'השרת לא הגיב בזמן (ייתכן שהוא מתעורר משינה). נסו שוב בעוד דקה.';
  return `שגיאה בתקשורת עם השרת (${status}).`;
}

// הודעות קופצות: הצלחה נעלמת מהר, שגיאה נשארת עד שסוגרים (או 10 שניות)
const TOAST_ICON = { ok: '✓', err: '!', info: 'i', wait: '' };
function toast(msg, kind = 'info', ms) {
  const box = $('#toasts');
  const life = ms ?? (kind === 'err' ? 10000 : kind === 'wait' ? 0 : 3500);
  // אותה הודעה כבר מוצגת – לא מוסיפים עוד אחת, רק מעדכנים מונה ומאריכים את הזמן
  if (kind !== 'wait') {
    const dup = [...box.children].find(t => !t.classList.contains('out') && t.dataset.kind === kind && t.dataset.msg === msg);
    if (dup) {
      dup._n = (dup._n || 1) + 1;
      dup.querySelector('.t-n').textContent = '×' + dup._n;
      dup.classList.remove('bump'); void dup.offsetWidth; dup.classList.add('bump');
      if (life) { clearTimeout(dup._timer); dup._timer = setTimeout(dup._close, life); }
      return dup._api;
    }
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.dataset.kind = kind; t.dataset.msg = msg;
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = `<span class="t-ic">${kind === 'wait' ? '<span class="spin"></span>' : TOAST_ICON[kind] || 'i'}</span><span class="t-msg">${esc(msg)}</span><span class="t-n"></span><button class="t-x" title="סגירה">✕</button>`;
  const close = () => { clearTimeout(t._timer); t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t._close = close;
  t.querySelector('.t-x').onclick = close;
  box.appendChild(t);
  while (box.children.length > 3) { const kids = [...box.children]; (kids.find(k => k !== t && k.dataset.kind !== 'err' && k.dataset.kind !== 'wait') || kids[0]).remove(); }
  if (life) t._timer = setTimeout(close, life);
  t._api = { close, set(m, k) { t.className = 'toast ' + k; t.dataset.kind = k; t.dataset.msg = m; t.querySelector('.t-msg').textContent = m; t.querySelector('.t-ic').innerHTML = TOAST_ICON[k] || 'i'; clearTimeout(t._timer); t._timer = setTimeout(close, k === 'err' ? 10000 : 3500); } };
  return t._api;
}

const initials = n => { const w = String(n || '?').replace(/["'<>]/g, '').trim().split(/\s+/); return (w[0]?.[0] || '?') + (w[1]?.[0] || ''); };
const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const custColor = key => CUST_COLORS[hash(key) % CUST_COLORS.length];
const teamColor = key => { const i = (S.cfg?.team || []).findIndex(u => u.key === key); return TEAM_COLORS[(i < 0 ? hash(key || '') : i) % TEAM_COLORS.length]; };
const teamName = key => (S.cfg?.team || []).find(u => u.key === key)?.name || key;
const ilDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const daysBack = n => ilDay(new Date(Date.now() - n * 864e5));
function waitText(iso) {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3600e3);
  return h >= 48 ? `ממתינה ${Math.floor(h / 24)} ימים` : `ממתינה ${h} שע׳`;
}
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
  return ic(type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext) ? 'image' : 'file');
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
  $('#sync').title = txt;
  const b = $('#banner');
  if (st.error) { b.hidden = false; b.className = 'banner'; b.textContent = st.error; }
  else if (st.send && st.send.ok === false) { b.hidden = false; b.className = 'banner'; b.textContent = 'שליחת מיילים לא זמינה כרגע – אפשר לקרוא פניות, אבל תשובות לא יישלחו. ' + (st.send.error || ''); }
  else if (st.loading && st.loading.total) { b.hidden = false; b.className = 'banner info'; b.textContent = `טוען מיילים מהתיבה: ${st.loading.done} מתוך ${st.loading.total}…`; }
  else if (!st.ready) { b.hidden = false; b.className = 'banner info'; b.textContent = 'המערכת טוענת את כל המיילים מהתיבה. זה לוקח רגע בהפעלה הראשונה.'; }
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
  if (r.error) return `ייבוא "${esc(r.subject)}" לא בוצע: ${esc(r.error)}`;
  let t = `יובאו <b>${r.added}</b> הודעות${what}`;
  if (r.dup) t += ` · ${r.dup} כבר היו במערכת ודולגו`;
  if (r.failed) t += ` · ${r.failed} לא נקראו`;
  if (r.unknown && r.unknown.length) t += ` · לא זוהה בנושא: "${esc(r.unknown.join('", "'))}" (יובאו בלי הסיווג הזה)`;
  return t + ` · ${ago(r.at)}`;
}

function renderStats() {
  const c = S.counts;
  const cards = isMgr() ? [
    ['open', '', 'inbox', c.new || 0, 'חדשות – בלי מטפל', 'var(--blue)'],
    ['open', '', 'clock', c.in_progress || 0, 'בטיפול הצוות', 'var(--amber)'],
    ['escalated', '', 'folder', c.escalatedOpen || 0, 'אצל המנהל', 'var(--violet)'],
    ['overdue', '', 'clock', c.overdue || 0, `ממתינות מעל ${S.cfg.overdueHours} שע׳`, 'var(--red)'],
  ] : [
    ['open', '', 'inbox', c.general || 0, 'פניות כלליות', 'var(--blue)'],
    ['mine', 'open', 'user', c.mine || 0, 'לטיפול שלי', 'var(--pink)'],
    ['mine', 'returned', 'ret', c.mineReturned || 0, 'חוזרות אליי', 'var(--amber)'],
    ['mine', 'done', 'check', c.mineDoneToday || 0, 'טיפלתי היום', 'var(--green)'],
  ];
  $('#stats').innerHTML = cards.map(([v, sub, icn, n, l, col]) =>
    `<div class="stat ${S.screen === 'inbox' && S.view === v && (!sub || S.sub === sub) ? 'on' : ''}" data-view="${v}" data-sub="${sub}" style="--c:${col}">
      <div class="stat-ic">${ic(icn)}</div><div><div class="num">${n}</div><div class="lbl">${l}</div></div></div>`).join('');
}

function renderTabs() {
  const tab = ([k, l, n, hot]) => `<button class="tab ${S.screen === 'inbox' && S.view === k ? 'active' : ''}" data-view="${k}">${l}${hot ? `<span class="hot" title="חוזרות / הועברו אליך">${hot}</span>` : ''}<span class="cnt">${n || 0}</span></button>`;
  $('#tabs').innerHTML = viewTabs().map(tab).join('');
  // ניווט ראשי של המנהל – בשורה העליונה
  const admin = isMgr();
  $('#main-nav').hidden = !admin;
  if (admin) {
    const nav = [['stats', 'ניהול מענה'], ['inbox', 'פניות', S.counts.open], ['team', 'ניהול צוות']]
      .map(([k, l, n]) => `<button class="nav-b ${S.screen === k ? 'on' : ''}" data-screen="${k}" ${S.screen === k ? 'aria-current="page"' : ''}>${l}${n ? `<span class="nav-n">${n}</span>` : ''}</button>`).join('');
    if ($('#main-nav').innerHTML !== nav) $('#main-nav').innerHTML = nav;
  }
  $('#stats').hidden = S.screen !== 'inbox';
}

// "טופלו" – בראש הקטגוריות (לחברות הצוות): כל הפניות שטופלו לצפייה וחיפוש. לפי התצוגה: כל הצוות / רק שלי.
const doneOn = () => S.done && !isMgr() && (S.view === 'open' || S.view === 'mine');
function renderChips() {
  const by = S.byCategory || {}, c = S.counts || {};
  const n = S.view === 'mine' ? (c.mineDone || 0) + (c.mineTracking || 0) : c.handledAll || 0;
  const doneBtn = isMgr() || !(S.view === 'open' || S.view === 'mine') ? ''
    : `<button class="chip done-chip ${doneOn() ? 'active' : ''}" data-done="1" style="--c:var(--green)" aria-pressed="${doneOn()}"
        title="${S.view === 'mine' ? 'הפניות שלי שטופלו' : 'כל הפניות שטופלו בצוות – לצפייה וחיפוש'}">${ic('check')}<span>טופלו</span>${n ? `<span class="n">${n}</span>` : ''}</button><div class="chip-sep"></div>`;
  $('#chips').innerHTML = doneBtn + `<button class="chip ${!S.category ? 'active' : ''}" data-cat="" style="--c:var(--ink-2)">הכל</button>` +
    S.cfg.categories.map(c => `<button class="chip ${S.category === c.key ? 'active' : ''}" data-cat="${c.key}" style="--c:${c.color}">${esc(c.name)}${by[c.key] ? `<span class="n">${by[c.key]}</span>` : ''}</button>`).join('');
}

// כותרת הרשימה: לשוניות משנה של "הפניות שלי" / הפניות של חבר צוות (מנהל), וטווח תאריכים לטופלו
function renderListHead() {
  const el = $('#list-head');
  const personal = S.view === 'mine' || S.view === 'member';
  if (doneOn()) {
    el.hidden = false;
    el.innerHTML = `<div class="lh-done">${ic('check')}<span><b>${S.view === 'mine' ? 'הפניות שלי שטופלו' : 'כל הפניות שטופלו'}</b>${S.view === 'mine' ? '' : ' · של כל הצוות, לצפייה וחיפוש'}</span>
        <button class="btn ghost sm" data-done-off="1">סגירה ✕</button></div>
      <div class="seg small">${RANGES.map(([k, l]) => `<button class="seg-b ${S.range === k ? 'on' : ''}" data-range="${k}">${l}</button>`).join('')}</div>`;
    return;
  }
  const ranged = (personal && S.sub === 'done') || S.view === 'handled';
  if (!personal && !ranged) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const sc = S.subCounts || {};
  let html = '';
  if (S.view === 'member') html += `<div class="lh-who">${avatar(teamName(S.member), teamColor(S.member), 'sm team')}<b>הפניות של ${esc(teamName(S.member))}</b><button class="btn ghost sm" data-screen="stats">חזרה לניהול מענה</button></div>`;
  if (personal) html += `<div class="seg">${SUBS.map(([k, l]) => `<button class="seg-b ${S.sub === k ? 'on' : ''} ${k === 'returned' && sc.returned ? 'warm' : ''} ${k === 'overdue' && sc.overdue ? 'alert' : ''}" data-sub="${k}">${l}<span>${sc[k] || 0}</span></button>`).join('')}</div>`;
  if (ranged) html += `<div class="seg small">${RANGES.map(([k, l]) => `<button class="seg-b ${S.range === k ? 'on' : ''}" data-range="${k}">${l}</button>`).join('')}</div>`;
  el.innerHTML = html;
}

// הודעה בולטת: פניות שחזרו אליי / הועברו אליי / ממתינות זמן רב
function renderNotice() {
  const c = S.counts, el = $('#notice');
  const parts = [];
  if (c.mineReturned) parts.push(`<button class="nt warm" data-view="mine" data-sub="returned"><span class="nt-ic">${ic('ret')}</span><span>יש לך <b>${c.mineReturned}</b> ${c.mineReturned === 1 ? 'פניה חוזרת' : 'פניות חוזרות'} לטיפול</span><span class="nt-go">לצפייה ←</span></button>`);
  if (c.mineOverdue) parts.push(`<button class="nt alert" data-view="mine" data-sub="overdue"><span class="nt-ic">${ic('clock')}</span><span><b>${c.mineOverdue}</b> מהפניות שלך ממתינות למענה יותר מ-${S.cfg.overdueHours} שעות</span><span class="nt-go">לצפייה ←</span></button>`);
  el.hidden = !parts.length;
  el.innerHTML = parts.join('');
}

const isUnread = it => (it.status === 'new' || (it.status === 'escalated' && it.mgr === 'new')) && S.seen[it.id] !== it.lastIncoming;
const MGR_LABEL = { new: 'חדשה', in_progress: 'בטיפול', answered: 'נענתה' };
const statusText = it => it.status === 'escalated'
  ? `אצל המנהל · ${MGR_LABEL[it.mgr] || ''}${it.mgr === 'in_progress' && it.assigneeName ? ' – ' + it.assigneeName : ''}`
  : it.status === 'handled' ? doneText(it)
  : STATUS[it.status] + (it.status === 'in_progress' && it.assignee !== S.me.key ? ' · ' + it.assigneeName : '');
// תיוג "מי מטפל" על הפניה (כמו קטגוריה) – בתצוגות הכלליות של המנהל
const ownerTag = it => it.assignee && it.assignee !== S.me.key && S.view !== 'member'
  ? `<span class="owner-tag" style="--c:${teamColor(it.assignee)}"><i>${esc(initials(it.assigneeName))}</i>${esc(it.assigneeName)}</span>` : '';

function renderList() {
  const el = $('#list');
  if (!S.items.length) {
    const clear = !S.q && !S.category;
    const msg = !clear ? 'לא נמצאו פניות'
      : doneOn() ? 'אין עדיין פניות שטופלו'
      : S.view === 'open' ? 'אין פניות פתוחות – כל הכבוד!'
      : S.view === 'tracking' || S.sub === 'tracking' ? 'אין פניות במעקב כרגע'
      : (S.view === 'mine' || S.view === 'member') && S.sub !== 'done' ? (S.sub === 'open' ? 'אין פניות שממתינות לטיפול' : 'אין כאן כלום כרגע')
      : 'לא נמצאו פניות';
    const good = clear && !doneOn() && S.view !== 'handled' && S.sub !== 'done' && S.view !== 'tracking' && S.sub !== 'tracking';
    el.innerHTML = `<li class="empty-list"><div class="big">${ic(good ? 'check' : 'search')}</div>${msg}</li>`;
    S._listHtml = null;
    return;
  }
  const html = S.items.map(it => `
    <li class="inq ${it.id === S.selId ? 'sel' : ''}" data-id="${esc(it.id)}" style="--s:${STATUS_COLOR[stKey(it)]}">
      ${avatar(it.fromName, custColor(it.fromEmail))}
      <div class="inq-main">
        <div class="inq-row"><span class="inq-from">${isUnread(it) ? '<span class="unread-dot"></span>' : ''}${esc(it.fromName)}</span><span class="inq-time">${fmtTime(it.lastIncoming)}</span></div>
        <div class="inq-subj">${esc(it.subject)}</div>
        <div class="inq-snip">${esc(it.snippet)}</div>
        <div class="inq-meta">
          <span class="pill ${stKey(it)}">${it.tracking ? ic('eye') : ''}${esc(statusText(it))}</span>
          ${it.tracking ? `<span class="pill track-age" title="מאז התשובה האחרונה">${trackAge(it.lastActivity)}</span>` : ''}
          ${it.fromTracking ? '<span class="pill from-track">חזרה ממעקב</span>' : ''}
          ${it.assigned ? '<span class="pill assigned">הועבר אליך</span>' : ''}
          ${it.returned ? '<span class="pill returned">הלקוח חזר</span>' : ''}
          ${it.overdue ? `<span class="pill overdue">${waitText(it.lastIncoming)}</span>` : ''}
          ${ownerTag(it)}
          ${it.categories.map(catPill).join('')}
          ${it.hasAttachments ? `<span class="mini">${ic('clip')}</span>` : ''}
          ${it.messageCount > 1 ? `<span class="mini">${ic('chat')} ${it.messageCount}</span>` : ''}
        </div>
      </div>
    </li>`).join('');
  if (html === S._listHtml && el.children.length) return; // שום דבר לא השתנה – לא נוגעים ברשימה
  S._listHtml = html;
  // עוגן גלילה: הפריט הנבחר (אם גלוי) או הפריט העליון הגלוי נשאר בדיוק באותו מקום על המסך,
  // גם כשהרשימה מתעדכנת ברקע (פניה חדשה למעלה, פניה שירדה וכו') – שום פניה לא "קופצת".
  const top = el.getBoundingClientRect().top;
  const visible = [...el.children].filter(li => li.dataset.id && li.getBoundingClientRect().bottom > top + 1);
  const anchorLi = visible.find(li => li.dataset.id === S.selId && li.getBoundingClientRect().top >= top - 1) || visible[0];
  const anchorId = anchorLi?.dataset.id;
  const anchorOff = anchorLi ? anchorLi.getBoundingClientRect().top - top : 0;
  const prevScroll = el.scrollTop;
  el.innerHTML = html;
  const again = anchorId && [...el.children].find(li => li.dataset.id === anchorId);
  const pinned = prevScroll > 0 || (S.selId && anchorId === S.selId); // למעלה ובלי בחירה – פניות חדשות מופיעות כרגיל
  if (again && pinned && el.offsetParent !== null) el.scrollTop += again.getBoundingClientRect().top - el.getBoundingClientRect().top - anchorOff;
  else el.scrollTop = prevScroll;
}

function bubble(m, first) {
  const out = m.direction === 'out';
  const color = out ? (m.authorKey ? teamColor(m.authorKey) : '#3b6cf6') : custColor(S.detail.fromEmail);
  const who = out ? (m.author ? `${m.author} · צוות KOH` : 'צוות KOH') : (m.name || m.email || 'הפונה');
  const tag = out ? 'תשובת הצוות' : (m.reconstructed && m.email && m.email !== S.detail.fromEmail ? 'צד נוסף' : 'הפונה');
  // ההיסטוריה המצוטטת מוצגת רק בהודעה הראשונה – בשאר היא כבר מופיעה בשרשור עצמו
  const showQuoted = m.quoted && first;
  return `
    <div class="row ${m.direction}">
      ${avatar(out ? (m.author || 'KOH') : who, color, out ? 'sm team' : 'sm')}
      <div class="bubble" style="--c:${color}">
        <div class="b-head">
          <span class="b-who"><span class="b-tag">${tag}</span>${esc(who)}</span>
          <span class="b-time">${m.dateUnknown ? '' : hm(m.date)}</span>
        </div>
        ${!out && m.email && m.email !== m.name ? `<div class="b-email">${esc(m.email)}</div>` : ''}
        <div class="b-body">${esc(bodyText(m)) || '<span class="b-empty">(הודעה ללא טקסט)</span>'}</div>
        ${m.reconstructed ? '<div class="b-recon" title="ההודעה הזו לא יובאה בנפרד – היא שוחזרה מתוך ההיסטוריה שמצוטטת בהודעה מאוחרת יותר">↩ מתוך ההתכתבות המצוטטת</div>' : ''}
        ${showQuoted ? `<button class="q-toggle" data-q="${m.id}">הצג היסטוריה קודמת</button><div class="quoted" id="q-${m.id}" hidden>${esc(m.quoted)}</div>` : ''}
        ${m.attachments.length ? attList(m.attachments) : ''}
        ${out && m.to && m.to.toLowerCase() !== (S.detail.fromEmail || '').toLowerCase() ? `<div class="b-to">נשלח אל <span dir="ltr">${esc(m.to)}</span></div>` : ''}
        ${String(m.id).startsWith('pending') ? '<div class="sending">✓ נשלח</div>' : ''}
      </div>
    </div>`;
}

// קבצים מצורפים: תמונות מוצגות כתמונה ממוזערת, PDF/טקסט נפתחים בלשונית חדשה – בלי להוריד. ⬇ = הורדה.
const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const VIEW_RE = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i;
function attList(atts) {
  const imgs = atts.filter(a => a.id && IMG_RE.test(a.type || ''));
  const files = atts.filter(a => !imgs.includes(a));
  const url = a => `/api/attachments/${encodeURIComponent(a.id)}`;
  return `<div class="atts">
    ${imgs.map(a => `<a class="att-img" href="${url(a)}?view=1" target="_blank" rel="noopener" title="${esc(a.name)} – לחצו לפתיחה בגודל מלא">
      <img src="${url(a)}?view=1" alt="${esc(a.name)}" loading="lazy"></a>`).join('')}
    ${files.map(a => !a.id ? `<span class="att">${ic('clip')} ${esc(a.name)}</span>`
      : VIEW_RE.test(a.type || '')
        ? `<span class="att"><a href="${url(a)}?view=1" target="_blank" rel="noopener">${ic('clip')} ${esc(a.name)} <span class="sz">${fmtSize(a.size)}</span></a><a class="att-dl" href="${url(a)}" title="הורדה">${ic('download')}</a></span>`
        : `<a class="att" href="${url(a)}">${ic('clip')} ${esc(a.name)} <span class="sz">${fmtSize(a.size)}</span></a>`).join('')}
  </div>`;
}
// ג'ימייל כותב "[image: image.png]" בגרסת הטקסט של תמונה מודבקת – מיותר כשהתמונה עצמה מוצגת
function bodyText(m) {
  if (!m.body || !m.attachments.some(a => a.id && IMG_RE.test(a.type || ''))) return m.body;
  return m.body.replace(/^[ \t]*\[image:[^\]\n]{0,200}\][ \t]*\n?/gim, '').trim();
}

function timeline(d) {
  const items = [
    // "היסטוריה קודמת" רק בהודעה האמיתית הראשונה שיש בה ציטוט שלא פורק לבועות
    ...d.messages.map(m => ({ at: m.date, rank: 1, html: bubble(m, m === d.messages.find(x => x.quoted)) })),
    ...d.events.filter(e => e.action !== 'reply').map(e => {
      const c = e.userKey ? teamColor(e.userKey) : '#8a90ab';
      return { at: e.at, rank: e.action === 'take' ? 0 : 2, html: `<div class="event" style="--c:${c}"><i class="ev-dot"></i><b>${esc(e.user || '')}</b> ${esc(e.text)} · ${hm(e.at)}</div>` };
    }),
    ...(d.notes || []).map(n => ({ at: n.at, rank: 3, html: `<div class="note" style="--c:${teamColor(n.userKey)}">
      <div class="n-head"><span class="n-tag">${n.kind === 'escalate' ? 'הערה בהעברה למנהל' : 'הערה פנימית'}</span><b>${esc(n.user)}</b><span class="n-time">${hm(n.at)}</span>
        ${n.canDelete ? `<button class="n-del" data-note-del="${esc(n.id)}" title="מחיקת ההערה">✕</button>` : ''}</div>
      <div class="n-body">${esc(n.text)}</div>
      <div class="n-foot">לא נשלחה לתורם</div></div>` })),
  // כמו במייל: החדש למעלה. באותה שנייה (כותרת Date של מייל מעוגלת לשניות): "לקח לטיפול" מתחת לתשובה, פעולות אחרות מעליה
  ].sort((a, b) => b.at.slice(0, 19).localeCompare(a.at.slice(0, 19)) || b.rank - a.rank);
  let lastDay = null, html = '';
  for (const it of items) {
    const day = dayLabel(it.at);
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
    html += it.html;
  }
  return html;
}

function detailActions(d) {
  const me = S.me.key, mgr = isMgr();
  const esc_ = d.status === 'escalated';
  const mine = (d.status === 'in_progress' || esc_) && d.assignee === me;
  const B = {
    take: l => `<button class="btn primary" data-act="take">${l || 'אני מטפל/ת בזה'}</button>`,
    // סימון כטופל – שתי אפשרויות ברורות
    handled: `<span class="done-split" role="group" aria-label="סימון כטופל">
      <button class="btn green" data-act="handled" title="הטיפול הסתיים">${ic('check')} טופל – הושלם</button>
      <button class="btn teal" data-act="handled-track" title="ענינו, ומחכים ללקוח (למשל ביקשנו קובץ)">${ic('eye')} טופל – במעקב</button></span>`,
    escalate: `<button class="btn violet" data-act="escalate">העבר למנהל</button>`,
    assign: `<button class="btn violet" data-act="assign">העבר לחבר צוות</button>`,
    reopen: l => `<button class="btn amber" data-act="reopen">${l || 'החזר לפניות הכלליות'}</button>`,
    release: `<button class="btn ghost sm" data-act="release">שחרר</button>`,
    ignore: `<button class="btn ghost sm" data-act="ignore" title="למשל: פרסומת או הודעת מערכת">לא פניה</button>`,
  };
  // חבר צוות יכול להעביר רק למנהל. מנהל מעביר לכל חבר צוות ומחזיר לכללי.
  const pass = mgr ? B.assign : B.escalate;
  if (esc_) return (mine ? B.release : !d.assignee ? B.take() : '') + B.handled + B.assign + B.reopen();
  if (d.status === 'new') return B.take() + B.handled + pass + B.ignore;
  if (d.status === 'in_progress' && mine) return B.handled + pass + B.release;
  if (d.status === 'in_progress') return B.take(`קח ממנו לטיפול שלי`) + B.assign + B.reopen() + B.handled;
  if (d.readOnly) return '';
  if (d.status === 'handled') {
    const canTrack = mgr || !d.assignee || d.assignee === me;
    const tr = !canTrack ? '' : d.tracking
      ? `<button class="btn green" data-act="track-off" title="הטיפול הסתיים – יוצא מרשימת המעקב">${ic('check')} סמן כהושלם</button>`
      : `<button class="btn teal" data-act="track-on" title="מחכים ללקוח – נכנס לרשימת המעקב">${ic('eye')} העבר למעקב</button>`;
    return B.take('תגובה נוספת') + tr + (mgr ? B.assign + B.reopen() : '');
  }
  if (d.status === 'ignored') return mgr ? B.reopen() : '';
  return '';
}

// הערות פנימיות – לא נשלחות לתורם
function notesBox(d) {
  return `<div class="notes-box">
    <div class="nb-head"><span>הערה פנימית</span><span class="nb-who">רואים: את/ה, המנהל, ומי שהפניה אצלו · לא נשלחת לתורם</span></div>
    <div class="nb-row">
      <textarea id="note-text" rows="1" maxlength="2000" placeholder="מה עשיתי, למה, מה עוד צריך…">${esc(S.noteDraft[d.id] || '')}</textarea>
      <button type="button" class="btn sm note-btn" id="note-add">הוספה</button>
    </div>
  </div>`;
}

function renderDetail() {
  const d = S.detail, el = $('#detail');
  if (!d) { el.innerHTML = `<div class="empty-detail"><div class="big">${ic('chat')}</div><div>בחרו פניה מהרשימה כדי לראות את כל השיחה</div></div>`; return; }
  const me = S.me.key;
  const esc_ = d.status === 'escalated';
  const mine = (d.status === 'in_progress' || esc_) && d.assignee === me;
  const other = (d.status === 'in_progress' || esc_) && !!d.assignee && d.assignee !== me;
  const actions = detailActions(d);

  let owner = '';
  if (d.assignee) owner = `<span class="owner">${avatar(d.assigneeName, teamColor(d.assignee), 'sm team')} ${
    d.status === 'handled' ? (d.assignee === me ? 'טופלה על ידך' : `טופלה על ידי <b>${esc(d.assigneeName)}</b>`)
    : mine ? 'בטיפול שלך' : `בטיפול של <b>${esc(d.assigneeName)}</b>`}</span>`;

  let composer;
  if (mine) composer = composerHtml(d);
  else if (d.status === 'new' || (esc_ && !d.assignee)) composer = `<div class="locked">כדי לענות, לחצו <b>"אני מטפל/ת בזה"</b>. כך אף אחד אחר לא יענה במקביל.</div>`;
  else if (d.readOnly) composer = `<div class="locked">${ic('eye')} צפייה בלבד – הפניה טופלה על ידי <b>${esc(d.assigneeName || 'הצוות')}</b>. אפשר לקרוא ולחפש, בלי לקחת או לענות.</div>`;
  else if (other) composer = `<div class="locked">${ic('lock')} <b>${esc(d.assigneeName)}</b> מטפל/ת בפניה הזו. אפשר לקרוא, אבל לא לענות.</div>`;
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
        <span class="pill ${stKey(d)}">${d.tracking ? ic('eye') : ''}${esc(d.status === 'escalated' ? 'אצל המנהל · ' + (MGR_LABEL[d.mgr] || '') : d.status === 'handled' ? doneText(d) : STATUS[d.status])}</span>
        ${d.tracking ? `<span class="pill track-age" title="מאז התשובה האחרונה ללקוח">${trackAge(d.lastActivity)}</span>` : ''}
        ${d.fromTracking ? '<span class="pill from-track">הלקוח חזר – הפניה הייתה במעקב</span>' : ''}
        ${d.assigned ? '<span class="pill assigned">הועבר אליך ע״י המנהל</span>' : ''}
        ${d.returned ? '<span class="pill returned">הלקוח כתב שוב אחרי שענינו</span>' : ''}
        ${d.overdue ? `<span class="pill overdue">${waitText(d.lastIncoming)}</span>` : ''}
        ${owner}
      </div>
      ${actions ? `<div class="d-actions">${actions}</div>` : ''}
      <div class="d-cats"><span class="lbl">קטגוריה:</span>${S.cfg.categories.map(c =>
        `<button class="cat-toggle ${d.categories.includes(c.key) ? 'on' : ''}" data-cat="${c.key}" style="--c:${c.color}" ${d.readOnly ? 'disabled' : ''}>${esc(c.name)}</button>`).join('')}</div>
      ${d.readOnly ? '' : notesBox(d)}
    </div>
    ${composer}
    <div class="convo" id="convo">${timeline(d)}</div>`;
  renderFiles();
  renderSendState();
  const cv = $("#convo"); requestAnimationFrame(() => { cv.scrollTop = 0; });
}

// נמען התשובה: ברירת המחדל היא הפונה, ואפשר לשנות ידנית (נשמר לכל פניה עד השליחה)
const defTo = d => d.replyTo || d.fromEmail || '';
const toOf = d => S.toBy[d.id] ?? defTo(d);
// אפשר כמה נמענים – מופרדים בפסיק, נקודה-פסיק או רווח
const toList = d => [...new Set(toOf(d).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase()))];
const toChanged = d => { const l = toList(d); return !(l.length === 1 && l[0] === defTo(d).toLowerCase()); };
function toNote(d) {
  const l = toList(d), def = defTo(d).toLowerCase();
  if (!l.length) return 'חסרה כתובת מייל של הנמען.';
  if (l.length === 1) return `שימו לב: התשובה תישלח לכתובת אחרת מזו של הפונה (${defTo(d)}).`;
  return `התשובה תישלח ל-${l.length} נמענים` + (l.includes(def) ? ', כולל הפונה.' : `. שימו לב: הפונה (${defTo(d)}) לא ביניהם.`);
}
const validEmail = s => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/.test(s);

function composerHtml(d) {
  const blocked = S.status.send && S.status.send.ok === false;
  return `
    <form class="composer" id="composer" novalidate>
      <div class="c-head">
        <label for="reply-to">תשובה אל</label>
        <input type="text" inputmode="email" id="reply-to" class="c-to" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(toOf(d))}" placeholder="name@example.com, other@example.com" title="אפשר לשנות את הנמען, או להוסיף כתובות נוספות מופרדות בפסיק">
        <button type="button" class="c-to-reset" id="reply-to-reset" title="חזרה לכתובת של הפונה" ${toChanged(d) ? '' : 'hidden'}>חזרה לפונה</button>
        <span>· תישלח במייל באותה שרשרת · לכמה נמענים: הפרידו בפסיק</span>
      </div>
      <div class="c-to-note" id="reply-to-note" ${toChanged(d) ? '' : 'hidden'}>${esc(toNote(d))}</div>
      ${blocked ? `<div class="c-warn">שליחת מיילים לא זמינה כרגע בשרת, ולכן התשובה כנראה לא תישלח. אפשר לכתוב – הטיוטה נשמרת.</div>` : ''}
      <div class="c-box" id="c-box">
        <textarea id="reply-body" placeholder="כתבו כאן את התשובה…">${esc(S.drafts[d.id] || '')}</textarea>
        <div class="files" id="files"></div>
        <div class="c-foot">
          <span class="c-hint">אפשר לגרור קבצים לכאן · Ctrl+Enter לשליחה</span>
          <div class="c-btns">
            <label class="btn ghost sm file-btn">${ic('clip')} צירוף קובץ<input type="file" id="file-input" multiple hidden></label>
            <button class="btn teal send-track" type="button" id="send-track-btn" title="התשובה תישלח, והפניה תעבור ל&quot;טופלו – במעקב&quot; (למשל כשביקשנו מהלקוח קובץ)">${ic('eye')} שליחה והשארה במעקב</button>
            <button class="btn primary" type="submit" id="send-btn" title="התשובה תישלח, והפניה תעבור ל&quot;טופלו – הושלם&quot;">שליחה</button>
          </div>
        </div>
        <div class="drop-hint">${ic('clip')} שחררו כאן כדי לצרף</div>
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
  const ti = $('#reply-to'); if (ti) ti.readOnly = busy;
  const tb = $('#send-track-btn'), trk = busy && S.sendTrack;
  if (btn) { btn.disabled = busy; btn.innerHTML = busy && !trk ? '<span class="spin"></span> שולח…' : 'שליחה'; }
  if (tb) { tb.disabled = busy; tb.hidden = S.detail.status === 'escalated'; tb.innerHTML = trk ? '<span class="spin"></span> שולח…' : `${ic('eye')} שליחה והשארה במעקב`; }
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
      <div class="se-title">התשובה לא נשלחה</div>
      <div class="se-msg">${esc(S.sendErr[id])}</div>
      <div class="se-foot">הטקסט והקבצים נשמרו – לא צריך לכתוב מחדש.
        <button type="button" class="btn sm red" id="retry-btn">נסו לשלוח שוב</button>
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

// track = true → "שליחה והשארה במעקב"
async function sendReply(track = false) {
  const d = S.detail; if (!d || S.sending) return;
  const id = d.id;
  const body = ($('#reply-body').value || '').trim();
  if (!body) { $('#reply-body').focus(); $('#c-box').classList.add('shake'); setTimeout(() => $('#c-box')?.classList.remove('shake'), 500); return toast('כתבו תשובה לפני השליחה', 'err', 4000); }
  const tl = toList(d), to = tl.join(', '), badTo = tl.find(a => !validEmail(a));
  if (!tl.length || badTo) { $('#reply-to')?.focus(); return toast(badTo ? `כתובת המייל של הנמען לא תקינה: ${badTo}` : 'חסרה כתובת מייל של הנמען', 'err', 5000); }
  if (tl.length > 10) { $('#reply-to')?.focus(); return toast('אפשר לשלוח לעד 10 נמענים במייל אחד', 'err', 5000); }
  const other = toChanged(d);
  const files = filesOf(id);
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL) return toast('הקבצים גדולים מדי יחד (מעל 24MB). הסירו חלק מהם ונסו שוב.', 'err');
  const fd = new FormData(); fd.append('body', body); if (other) fd.append('to', to);
  track = track && d.status !== 'escalated'; if (track) fd.append('track', '1');
  files.forEach(f => fd.append('files', f));

  S.sending = id; S.sendTrack = track; delete S.sendErr[id]; delete S.sentOk[id];
  S.sendProgress = files.length ? { stage: 'upload', loaded: 0, total } : { stage: 'send' };
  renderFiles(); renderSendState();
  try {
    const res = await postWithProgress(`/inquiries/${encodeURIComponent(id)}/reply`, fd, (loaded, tot) => {
      S.sendProgress = loaded < 0 || loaded >= tot ? { stage: 'send', loaded: total, total } : { stage: 'upload', loaded, total: tot };
      if (S.detail && S.detail.id === id) renderSendState();
    });
    S.sending = null; S.sendProgress = null;
    delete S.drafts[id]; delete S.toBy[id]; S.filesBy[id] = []; S.sentOk[id] = to;
    toast(`התשובה נשלחה ל-${other ? to : d.fromName}` + (track ? ' · הפניה במעקב' : ''), 'ok');
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
  const p = new URLSearchParams({ view: S.view, sub: S.sub });
  if (doneOn()) p.set('done', '1');
  if (S.view === 'member') p.set('member', S.member);
  if (S.range !== '') { p.set('from', daysBack(+S.range)); p.set('to', daysBack(0)); }
  if (S.category) p.set('category', S.category);
  if (S.q) p.set('q', S.q);
  const { items, counts, status, byCategory, subCounts } = await api('/inquiries?' + p);
  S.items = items; S.counts = counts; S.status = status; S.byCategory = byCategory || {}; S.subCounts = subCounts;
  renderTop(); renderStats(); renderTabs(); renderNotice();
  if (S.screen !== 'inbox') return;
  renderChips(); renderListHead(); renderList();
}

// מעבר בין המסכים: פניות / ניהול מענה / ניהול צוות
function showScreen(name) {
  S.screen = name;
  const inbox = name === 'inbox';
  $('#layout').classList.toggle('manage-mode', !inbox);
  $('#manage').hidden = inbox;
  $('#layout').classList.remove('show-detail');
  renderTabs(); renderStats();
  if (inbox) { renderChips(); renderListHead(); renderList(); loadList().catch(() => {}); }
  else window.Manage && Manage.open(name);
}

// מעבר לתצוגת פניות (גם מכרטיס בניהול מענה)
function setView(v, sub, member) {
  S.view = v; S.sub = sub || 'open'; S.member = member || null;
  if (v !== 'handled' && S.sub !== 'done' && !doneOn()) S.range = '';
  S.selId = null; S.detail = null; S._listHtml = null;
  if (S.screen !== 'inbox') showScreen('inbox');
  renderDetail();
  $('#list').scrollTop = 0;
  return loadList();
}

function setDone(on) {
  S.done = on; S.range = ''; S.selId = null; S.detail = null; S._listHtml = null;
  renderDetail(); $('#list').scrollTop = 0;
  return loadList().catch(err => toast(err.message, 'err'));
}

async function openInquiry(id) {
  S.selId = id;
  S.detail = await api('/inquiries/' + encodeURIComponent(id));
  if (S.detail.hidden) return gone();
  const it = S.items.find(x => x.id === id);
  if (it) { S.seen[id] = it.lastIncoming; ls.set('koh.seen', S.seen); }
  renderList(); renderDetail();
  $('#layout').classList.add('show-detail');
}

async function act(action) {
  const d = S.detail;
  if (action === 'back') { $('#layout').classList.remove('show-detail'); return; }
  if (action === 'escalate') { $('#esc-note').value = ''; $('#dlg-escalate').returnValue = ''; $('#dlg-escalate').showModal(); return; }
  if (action === 'assign') return openAssign();
  const msgs = { take: 'הפניה אצלך – אפשר לענות', release: 'הפניה שוחררה', handled: 'סומן: טופל – הושלם', 'handled-track': 'סומן: טופל – במעקב',
    'track-on': 'הפניה עברה למעקב', 'track-off': 'סומן: טופל – הושלם', reopen: 'הפניה חזרה לפניות הכלליות', ignore: 'הוסתר – לא פניה' };
  if (action === 'release' && ($('#reply-body')?.value.trim() || filesOf(d.id).length) && !confirm('יש טיוטה שלא נשלחה. לשחרר את הפניה בכל זאת? (הטיוטה תישמר)')) return;
  const clicked = document.querySelector(`[data-act="${action}"]`);
  document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = true));
  if (clicked) clicked.innerHTML = '<span class="spin"></span> ' + clicked.textContent.replace(/^\S+\s/, '');
  try {
    const call = { 'handled-track': ['handled', { track: true }], 'track-on': ['tracking', { on: true }], 'track-off': ['tracking', { on: false }] }[action] || [action];
    S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/${call[0]}`, { method: 'POST', json: call[1] });
    delete S.sentOk[d.id];
    toast(msgs[action] || 'עודכן', 'ok');
    if (S.detail.hidden) { S.detail = null; S.selId = null; $('#layout').classList.remove('show-detail'); }
    await loadList(); renderDetail();
    if (action === 'take') $('#reply-body')?.focus();
  } catch (e) { toast(e.message, 'err'); await refresh().catch(() => {}); }
}

async function refresh() {
  await loadList();
  if (S.selId) { S.detail = await api('/inquiries/' + encodeURIComponent(S.selId)).catch(() => null); if (S.detail && S.detail.hidden) S.detail = null; renderDetail(); }
}

// הפניה כבר לא אצלך (הועברה / נלקחה) – סוגרים אותה בעדינות
function gone() {
  S.detail = null; S.selId = null;
  $('#layout').classList.remove('show-detail');
  renderDetail(); loadList().catch(() => {});
  toast('הפניה הזו כבר לא אצלך', 'info');
}

// העברה לחבר צוות (מנהל)
function openAssign() {
  const d = S.detail;
  const list = (S.cfg.team || []).filter(u => !u.deleted);
  $('#assign-list').innerHTML = list.map(u => `<button class="pick ${u.key === d.assignee ? 'cur' : ''}" value="${esc(u.key)}" style="--c:${teamColor(u.key)}">
    ${avatar(u.name, teamColor(u.key), 'sm team')}<span>${esc(u.name)}${u.key === S.me.key ? ' (אני)' : ''}</span>${u.role === 'manager' ? '<span class="role-b">מנהל</span>' : ''}${u.key === d.assignee ? '<span class="cur-b">אצלו עכשיו</span>' : ''}</button>`).join('');
  $('#dlg-assign').returnValue = '';
  $('#dlg-assign').showModal();
}

async function addNote() {
  const d = S.detail, ta = $('#note-text'); if (!d || !ta) return;
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const b = $('#note-add'); b.disabled = true;
  try {
    S.detail = await api(`/inquiries/${encodeURIComponent(d.id)}/notes`, { method: 'POST', json: { text } });
    delete S.noteDraft[d.id];
    renderDetail(); toast('ההערה נשמרה (לא נשלחה לתורם)', 'ok');
  } catch (e) { toast(e.message, 'err'); b.disabled = false; }
}

// ---------- events ----------
function bindApp() {
  const go = b => setView(b.dataset.view, b.dataset.sub || 'open').catch(err => toast(err.message, 'err'));
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) go(b); });
  $('#stats').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) go(b); });
  $('#notice').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) go(b); });
  $('#main-nav').addEventListener('click', e => { const b = e.target.closest('[data-screen]'); if (b && b.dataset.screen !== S.screen) showScreen(b.dataset.screen); });
  $('#list-head').addEventListener('click', e => {
    const sc = e.target.closest('[data-screen]'); if (sc) return showScreen(sc.dataset.screen);
    if (e.target.closest('[data-done-off]')) return setDone(false);
    const sb = e.target.closest('[data-sub]'); if (sb) return setView(S.view, sb.dataset.sub, S.member);
    const rg = e.target.closest('[data-range]'); if (rg) { S.range = rg.dataset.range; loadList(); }
  });
  $('#chips').addEventListener('click', e => {
    if (e.target.closest('[data-done]')) return setDone(!doneOn());
    const b = e.target.closest('[data-cat]'); if (b) { S.category = b.dataset.cat || null; loadList(); }
  });
  let t; $('#search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; loadList(); }, 250); });
  $('#list').addEventListener('click', e => { const li = e.target.closest('[data-id]'); if (li) openInquiry(li.dataset.id).catch(err => toast(err.message, 'err')); });

  const det = $('#detail');
  det.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]'); if (a) return act(a.dataset.act);
    const q = e.target.closest('[data-q]');
    if (q) { const box = $('#q-' + q.dataset.q); box.hidden = !box.hidden; q.textContent = box.hidden ? 'הצג היסטוריה קודמת' : 'הסתר היסטוריה'; return; }
    const rm = e.target.closest('[data-rm]'); if (rm) { filesOf(S.detail.id).splice(+rm.dataset.rm, 1); renderFiles(); return; }
    if (e.target.closest('#note-add')) return addNote();
    if (e.target.closest('#send-track-btn')) return sendReply(true);
    const nd = e.target.closest('[data-note-del]');
    if (nd) {
      if (!confirm('למחוק את ההערה?')) return;
      try { S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/notes/${encodeURIComponent(nd.dataset.noteDel)}`, { method: 'DELETE' }); renderDetail(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (e.target.closest('#retry-btn')) return sendReply(!!S.sendTrack);
    if (e.target.closest('#reply-to-reset')) { delete S.toBy[S.detail.id]; $('#reply-to').value = defTo(S.detail); $('#reply-to-reset').hidden = true; $('#reply-to-note').hidden = true; return; }
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
  // Enter בשדה הנמען לא שולח את המייל – רק עובר לכתיבת התשובה
  det.addEventListener('keydown', e => { if (e.target.id === 'reply-to' && e.key === 'Enter') { e.preventDefault(); $('#reply-body')?.focus(); } });
  det.addEventListener('keydown', e => { if (e.target.id === 'reply-body' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } });
  det.addEventListener('keydown', e => { if (e.target.id === 'note-text' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } });
  det.addEventListener('input', e => {
    if (e.target.id === 'reply-body') S.drafts[S.detail.id] = e.target.value;
    if (e.target.id === 'note-text') { S.noteDraft[S.detail.id] = e.target.value; e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }
    if (e.target.id === 'reply-to') {
      S.toBy[S.detail.id] = e.target.value;
      const ch = toChanged(S.detail);
      $('#reply-to-reset').hidden = !ch; $('#reply-to-note').hidden = !ch; $('#reply-to-note').textContent = toNote(S.detail);
    }
  });
  det.addEventListener('submit', e => { e.preventDefault(); sendReply(); });

  $('#dlg-escalate').addEventListener('close', async () => {
    if ($('#dlg-escalate').returnValue !== 'ok') return;
    const t = toast('מעביר לתיקיית המנהל…', 'wait');
    document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = true));
    try {
      S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/escalate`, { method: 'POST', json: { note: $('#esc-note').value } });
      t.set('הפניה הועברה למנהל', 'ok');
      if (S.detail.hidden) { S.detail = null; S.selId = null; $('#layout').classList.remove('show-detail'); }
      await loadList(); renderDetail();
    } catch (e) { t.set('ההעברה למנהל נכשלה: ' + e.message, 'err'); document.querySelectorAll('.d-actions [data-act]').forEach(b => (b.disabled = false)); }
  });

  $('#dlg-assign').addEventListener('close', async () => {
    const to = $('#dlg-assign').returnValue;
    if (!to || to === 'cancel' || !S.detail) return;
    const t = toast(`מעביר ל${teamName(to)}…`, 'wait');
    try {
      S.detail = await api(`/inquiries/${encodeURIComponent(S.detail.id)}/assign`, { method: 'POST', json: { to } });
      t.set(`הפניה הועברה ל${teamName(to)}`, 'ok'); await loadList(); renderDetail();
    } catch (e) { t.set(e.message, 'err'); }
  });

  // החלפת הסיסמה שלי
  $('#my-pass').addEventListener('click', () => { $('#p-old').value = ''; $('#p-new').value = ''; $('#p-err').textContent = ''; $('#dlg-pass').showModal(); $('#p-old').focus(); });
  $('#pass-form').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    try {
      await api('/me/password', { method: 'POST', json: { old: $('#p-old').value, password: $('#p-new').value } });
      $('#dlg-pass').close(); toast('הסיסמה הוחלפה', 'ok');
    } catch (err) { $('#p-err').textContent = err.message; }
  });

  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
}

let started = false;
async function startApp() {
  S.cfg = await api('/config');
  S.me = S.cfg.me;
  $('#login').hidden = true; $('#app').hidden = false;
  $('#me-name').textContent = S.me.name;
  $('#me-role').textContent = S.me.manager ? 'מנהל' : '';
  document.body.classList.toggle('is-mgr', !!S.me.manager);
  $('#me-avatar').outerHTML = avatar(S.me.name, teamColor(S.me.key), 'sm team').replace('<span', '<span id="me-avatar"');
  if (!started) { bindApp(); started = true; }
  renderDetail();
  if (isMgr() && S.screen === 'inbox') showScreen('stats');   // הדף הראשי של המנהל: ניהול מענה
  loadList().catch(err => toast(err.message, 'err'));
  setInterval(async () => {
    if (document.hidden || document.querySelector('dialog[open]') || $('#app').hidden) return;
    await loadList().catch(() => {});
    if (S.screen !== 'inbox') { window.Manage && Manage.tick(); return; }
    const busy = S.sending || ['reply-body', 'reply-to', 'note-text'].includes(document.activeElement?.id) || (S.selId && filesOf(S.selId).length);
    if (S.selId && !busy) {
      const fresh = await api('/inquiries/' + encodeURIComponent(S.selId)).catch(e => /לא נמצאת אצלך/.test(e.message) ? { hidden: true } : null);
      if (fresh && fresh.hidden) gone();
      else if (fresh && JSON.stringify(fresh) !== JSON.stringify(S.detail)) { S.detail = fresh; renderDetail(); }
    }
  }, 20000);
}

window.addEventListener('beforeunload', e => { if (S.sending) { e.preventDefault(); e.returnValue = ''; } });

(async function boot() {
  bindLogin();
  const pub = await fetch('/api/public').then(r => r.json()).catch(() => ({ team: [] }));
  if (pub.me) startApp(); else showLogin(pub.team);
})();
