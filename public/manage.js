/* מסכי המנהל: ניהול מענה (סטטיסטיקה לכל חבר צוות) וניהול צוות */
(function () {
  const M = { preset: '29', from: null, to: null, data: null, team: null, showTable: false, editKey: null, delKey: null };

  const fmtDay = d => { const [y, m, dd] = d.split('-'); return `${+dd}/${+m}`; };
  const dayName = d => new Date(d + 'T12:00:00Z').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  function fmtDur(min) {
    if (min == null) return '—';
    if (min < 1) return 'פחות מדקה';
    if (min < 60) return `${min} דק׳`;
    if (min < 48 * 60) { const h = Math.floor(min / 60), m = min % 60; return `${h}:${String(m).padStart(2, '0')} שע׳`; }
    return `${Math.round(min / 1440)} ימים`;
  }
  const ROLE = { manager: 'מנהל', member: 'חבר צוות' };
  const PRESETS = [['0', 'היום'], ['6', '7 ימים'], ['29', '30 ימים'], ['month', 'החודש'], ['89', '90 יום'], ['custom', 'טווח אחר']];

  function rangeParams() {
    const today = daysBack(0);
    if (M.preset === 'custom') return { from: M.from || daysBack(29), to: M.to || today };
    if (M.preset === 'month') return { from: today.slice(0, 8) + '01', to: today };
    return { from: daysBack(+M.preset), to: today };
  }

  // ---------- ניהול מענה ----------
  async function loadStats() {
    const r = rangeParams();
    M.data = await api(`/stats?from=${r.from}&to=${r.to}`);
  }

  function kpi(n, l, col, view, warn) {
    return `<button class="kpi ${warn && n ? 'warn' : ''}" style="--c:${col}" ${view ? `data-goview="${view}"` : 'disabled'}>
      <span class="kpi-n">${n}</span><span class="kpi-l">${l}</span></button>`;
  }

  // שורה בטבלת הצוות – לחיצה על השורה פותחת את הפניות של אותו חבר צוות
  function memberRow(m, max) {
    const c = teamColor(m.key);
    const share = max ? Math.round((m.range / max) * 100) : 0;
    const nb = (sub, n, cls = '') => `<button class="num-b ${n ? cls : 'zero'}" data-member="${esc(m.key)}" data-sub="${sub}">${n}</button>`;
    return `<tr class="go ${m.deleted ? 'gone' : ''}" style="--c:${c}" data-member="${esc(m.key)}" tabindex="0">
      <td><div class="who"><span class="who-dot"></span><div><div class="who-name">${esc(m.name)}</div>
        <div class="who-sub">${m.deleted ? 'הוסר/ה מהצוות' : ROLE[m.role] || ''}</div></div></div></td>
      <td class="n"><span class="big-n">${m.range}</span><span class="share" style="margin-inline:auto"><i style="width:${share}%"></i></span></td>
      <td class="n">${m.today}</td>
      <td class="n">${m.week}</td>
      <td class="n">${m.replies}</td>
      <td class="n">${nb('open', m.open)}</td>
      <td class="n">${nb('returned', m.returned, 'warm')}</td>
      <td class="n">${nb('overdue', m.overdue, 'alert')}</td>
      <td class="n">${fmtDur(m.avgResponseMin)}</td>
    </tr>`;
  }

  // עמודות יומיות מוערמות לפי חבר צוות (מעל 62 ימים – לפי שבועות)
  function buckets() {
    const { days } = M.data;
    if (days.length <= 62) return days.map(d => ({ key: d, label: fmtDay(d), title: dayName(d), days: [d] }));
    const out = [];
    for (let i = 0; i < days.length; i += 7) {
      const part = days.slice(i, i + 7);
      out.push({ key: part[0], label: fmtDay(part[0]), title: `שבוע ${fmtDay(part[0])}–${fmtDay(part[part.length - 1])}`, days: part });
    }
    return out;
  }

  function chart(members) {
    const bs = buckets();
    const series = members.filter(m => m.range > 0);
    if (!series.length) return `<div class="chart-empty">אין עדיין טיפול בפניות בטווח הזה</div>`;
    const val = (m, b) => b.days.reduce((a, d) => a + (m.perDay[d] || 0), 0);
    const totals = bs.map(b => series.reduce((a, m) => a + val(m, b), 0));
    const raw = Math.max(1, ...totals);
    const step = raw <= 5 ? 1 : raw <= 10 ? 2 : raw <= 25 ? 5 : raw <= 50 ? 10 : Math.ceil(raw / 50) * 10;
    const top = Math.ceil(raw / step) * step;
    const grid = []; for (let v = 0; v <= top; v += step) grid.push(v);
    const every = Math.ceil(bs.length / 12);
    const cols = bs.map((b, i) => {
      const segs = series.map(m => ({ m, v: val(m, b) })).filter(x => x.v);
      const tip = `<b>${esc(b.title)}</b>` + (segs.length ? segs.map(x => `<span class="tt-row"><i style="--c:${teamColor(x.m.key)}"></i>${esc(x.m.name)}<b>${x.v}</b></span>`).join('') + `<span class="tt-sum">סה״כ <b>${totals[i]}</b></span>` : '<span class="tt-row">אין טיפול</span>');
      return `<div class="col" data-tip="${esc(tip)}">
        <div class="stack" style="height:${(totals[i] / top) * 100}%">${segs.map(x => `<span style="--c:${teamColor(x.m.key)};flex:${x.v}"></span>`).join('')}</div>
        <div class="xl">${i % every === 0 || i === bs.length - 1 ? b.label : ''}</div></div>`;
    }).join('');
    return `<div class="legend">${series.map(m => `<span><i style="--c:${teamColor(m.key)}"></i>${esc(m.name)}</span>`).join('')}</div>
      <div class="chart" dir="ltr">
        <div class="grid">${grid.map(v => `<div class="gl" style="bottom:${(v / top) * 100}%"><span>${v}</span></div>`).join('')}</div>
        <div class="cols">${cols}</div>
      </div>`;
  }

  function dayTable(members) {
    const series = members.filter(m => m.range > 0 || !m.deleted);
    const bs = buckets().slice().reverse();
    const val = (m, b) => b.days.reduce((a, d) => a + (m.perDay[d] || 0), 0);
    return `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>${M.data.days.length > 62 ? 'שבוע' : 'יום'}</th>${series.map(m => `<th><span class="th-who"><i style="--c:${teamColor(m.key)}"></i>${esc(m.name)}</span></th>`).join('')}<th>סה״כ</th></tr></thead>
      <tbody>${bs.map(b => { const vs = series.map(m => val(m, b)); const sum = vs.reduce((a, x) => a + x, 0);
        return `<tr class="${sum ? '' : 'zero'}"><td>${esc(b.title)}</td>${vs.map(v => `<td>${v || '·'}</td>`).join('')}<td><b>${sum}</b></td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>סה״כ בטווח</td>${series.map(m => `<td><b>${m.range}</b></td>`).join('')}<td><b>${M.data.totals.range}</b></td></tr></tfoot>
    </table></div>`;
  }

  function renderStatsScreen() {
    const el = $('#manage'), d = M.data;
    const r = rangeParams();
    const members = d.members;
    const max = Math.max(0, ...members.map(m => m.range));
    const rangeLbl = d.from === d.to ? 'טופלו בטווח' : `טופלו <bdi>${fmtDay(d.from)}</bdi>–<bdi>${fmtDay(d.to)}</bdi>`;
    const html = `<div class="mg-wrap">
      <div class="mg-head">
        <div><h2>ניהול מענה</h2><p class="muted">כמה כל חבר צוות טיפל, מה ממתין אצלו, וכמה זמן לוקח לענות.</p></div>
        <div class="range">
          <div class="seg">${PRESETS.map(([k, l]) => `<button class="seg-b ${M.preset === k ? 'on' : ''}" data-preset="${k}">${l}</button>`).join('')}</div>
          ${M.preset === 'custom' ? `<div class="custom"><label>מ-<input type="date" id="r-from" value="${r.from}" max="${d.today}"></label><label>עד<input type="date" id="r-to" value="${r.to}" max="${d.today}"></label></div>` : ''}
        </div>
      </div>
      <div class="kpis panel">
        ${kpi(d.totals.range, rangeLbl, 'var(--green)')}
        ${kpi(d.totals.today, 'טופלו היום', 'var(--amber)')}
        ${kpi(d.totals.general, 'פניות כלליות, בלי מטפל', 'var(--blue)', 'open')}
        ${kpi(d.totals.escalatedOpen, 'ממתינות אצל המנהל', 'var(--violet)', 'escalated')}
        ${kpi(d.totals.overdue, `ממתינות מעל ${d.overdueHours} שעות`, 'var(--red)', 'overdue', true)}
      </div>
      <section class="mg-sec panel flush">
        <div class="sec-head"><h3>הצוות</h3><span class="sec-note">"טופלה" = פניה שענו בה או סימנו אותה כטופלה באותו יום. לחיצה על שורה פותחת את הפניות.</span></div>
        <div class="dtbl-wrap"><table class="dtbl">
          <thead><tr><th>חבר צוות</th><th class="n">טופלו בטווח</th><th class="n">היום</th><th class="n">7 ימים</th><th class="n">תשובות</th>
            <th class="n">פתוחות</th><th class="n">חוזרות</th><th class="n">ממתינות</th><th class="n">זמן מענה ממוצע</th></tr></thead>
          <tbody>${members.map(m => memberRow(m, max)).join('')}</tbody>
        </table></div>
      </section>
      <section class="mg-sec panel">
        <div class="sec-head"><h3>טיפול לפי ${d.days.length > 62 ? 'שבועות' : 'ימים'}</h3>
          <button class="lnk" id="tbl-toggle">${M.showTable ? 'הצג כגרף' : 'הצג כטבלה'}</button></div>
        ${M.showTable ? dayTable(members) : chart(members)}
      </section></div>`;
    if (el.innerHTML !== html) el.innerHTML = html;   // רענון שקט: רק אם משהו השתנה
  }

  // ---------- ניהול צוות ----------
  async function loadTeam() {
    const [t, st] = await Promise.all([api('/team'), api('/stats?from=' + daysBack(29) + '&to=' + daysBack(0))]);
    M.team = t.users; M.teamStats = Object.fromEntries(st.members.map(m => [m.key, m]));
  }

  function renderTeamScreen() {
    const el = $('#manage');
    const act = M.team.filter(u => !u.deleted), del = M.team.filter(u => u.deleted);
    const row = u => {
      const s = M.teamStats[u.key] || {};
      return `<tr style="--c:${teamColor(u.key)}">
        <td><div class="who"><span class="who-dot"></span><span class="who-name">${esc(u.name)}</span>${u.key === S.me.key ? '<span class="me-b">אני</span>' : ''}</div></td>
        <td><span class="role-t ${u.role}">${ROLE[u.role]}</span></td>
        <td>${u.phone ? `<span class="ltr">${esc(u.phone)}</span>` : '<span class="none">—</span>'}</td>
        <td>${u.email ? `<span class="ltr">${esc(u.email)}</span>` : '<span class="none">—</span>'}</td>
        <td class="n">${s.open || 0}</td>
        <td class="n">${s.month || 0}</td>
        <td><div class="row-acts">
          <button class="lnk" data-uedit="${esc(u.key)}">עריכה</button>
          <button class="lnk" data-upass="${esc(u.key)}">סיסמה</button>
          ${u.key !== S.me.key ? `<button class="lnk danger" data-udel="${esc(u.key)}">הסרה</button>` : ''}
        </div></td>
      </tr>`;
    };
    el.innerHTML = `<div class="mg-wrap">
      <div class="mg-head">
        <div><h2>ניהול צוות</h2><p class="muted">מי נכנס לדשבורד ומה התפקיד שלו. מנהל רואה הכול, כולל "הועבר למנהל" ומסכי הניהול. חבר צוות רואה את הפניות הכלליות ואת הפניות שלו.</p></div>
        <button class="btn primary" id="u-add">הוספת חבר צוות</button>
      </div>
      <section class="mg-sec panel flush"><div class="dtbl-wrap"><table class="dtbl">
        <thead><tr><th>שם</th><th>תפקיד</th><th>טלפון</th><th>מייל</th><th class="n">פתוחות</th><th class="n">טופלו ב-30 יום</th><th></th></tr></thead>
        <tbody>${act.map(row).join('')}</tbody>
      </table></div></section>
      ${del.length ? `<details class="gone-list"><summary>הוסרו מהצוות (${del.length})</summary>
        <div class="panel dtbl-wrap"><table class="dtbl"><tbody>${del.map(u => `<tr style="--c:${teamColor(u.key)}">
          <td><div class="who"><span class="who-dot"></span><span class="who-name">${esc(u.name)}</span></div></td>
          <td>${u.email ? `<span class="ltr">${esc(u.email)}</span>` : ''}</td>
          <td><div class="row-acts"><button class="lnk" data-urestore="${esc(u.key)}">החזרה לצוות</button></div></td></tr>`).join('')}</tbody></table></div>
      </details>` : ''}</div>`;
  }

  function openUser(key, passOnly) {
    M.editKey = key || null;
    const u = key ? M.team.find(x => x.key === key) : null;
    $('#user-title').textContent = !u ? 'חבר צוות חדש' : passOnly ? `סיסמה חדשה ל${u.name}` : `עריכת ${u.name}`;
    $('#u-name').value = u ? u.name : ''; $('#u-role').value = u ? u.role : 'member'; $('#u-email').value = u ? u.email : ''; $('#u-phone').value = u ? (u.phone || '') : ''; $('#u-pass').value = '';
    $('#u-pass-l').textContent = !u ? 'סיסמה (6 תווים לפחות)' : passOnly ? 'סיסמה חדשה (6 תווים לפחות)' : 'סיסמה חדשה – השאירו ריק כדי לא לשנות';
    for (const id of ['#u-name', '#u-role', '#u-email', '#u-phone']) $(id).closest('.field').hidden = !!passOnly;
    $('#u-role').disabled = !!(u && u.key === S.me.key);
    $('#u-err').textContent = '';
    $('#dlg-user').dataset.passOnly = passOnly ? '1' : '';
    $('#dlg-user').showModal();
    (passOnly ? $('#u-pass') : $('#u-name')).focus();
  }

  async function saveUser(e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const passOnly = !!$('#dlg-user').dataset.passOnly;
    const body = passOnly ? { password: $('#u-pass').value } : { name: $('#u-name').value, role: $('#u-role').value, email: $('#u-email').value, phone: $('#u-phone').value };
    if (!passOnly && $('#u-pass').value) body.password = $('#u-pass').value;
    if (!M.editKey) body.password = $('#u-pass').value;
    $('#u-save').disabled = true;
    try {
      const r = M.editKey ? await api('/team/' + encodeURIComponent(M.editKey), { method: 'PATCH', json: body }) : await api('/team', { method: 'POST', json: body });
      $('#dlg-user').close();
      toast(M.editKey ? (passOnly ? 'הסיסמה עודכנה' : 'הפרטים עודכנו') : `${r.user.name} נוסף/ה לצוות`, 'ok');
      await refreshTeamCfg(); await loadTeam(); renderTeamScreen();
    } catch (err) { $('#u-err').textContent = err.message; }
    finally { $('#u-save').disabled = false; }
  }

  function openDel(key) {
    const u = M.team.find(x => x.key === key), s = M.teamStats[key] || {};
    M.delKey = key;
    $('#del-title').textContent = `הסרת ${u.name} מהצוות`;
    $('#del-text').textContent = `${u.name} לא יוכל/תוכל להיכנס יותר ולא יקבל/תקבל פניות. ההיסטוריה והסטטיסטיקה נשמרות, ואפשר להחזיר אותו/ה לצוות בהמשך.`;
    $('#del-move-f').hidden = !s.open;
    $('#del-move').innerHTML = `<option value="">להחזיר לפניות הכלליות (${s.open || 0})</option>` +
      M.team.filter(x => !x.deleted && x.key !== key).map(x => `<option value="${esc(x.key)}">להעביר ל${esc(x.name)}</option>`).join('');
    $('#dlg-del').returnValue = '';
    $('#dlg-del').showModal();
  }

  async function refreshTeamCfg() { S.cfg = await api('/config'); }

  // ---------- חיבור ----------
  async function open(name) {
    M.screen = name;
    $('#manage').innerHTML = '<div class="mg-loading"><span class="spin"></span> טוען…</div>';
    try {
      if (name === 'stats') { await loadStats(); renderStatsScreen(); }
      else { await loadTeam(); renderTeamScreen(); }
    } catch (e) { $('#manage').innerHTML = `<div class="mg-loading err">${esc(e.message)}</div>`; }
  }
  // עדכון ברקע בלי הבהוב: מציירים מחדש רק כשהנתונים השתנו
  async function tick() {
    if (S.screen !== 'stats' || document.querySelector('#manage input:focus')) return;
    const before = JSON.stringify(M.data);
    await loadStats().catch(() => {});
    if (S.screen === 'stats' && JSON.stringify(M.data) !== before) renderStatsScreen();
  }

  function bind() {
    const el = $('#manage');
    el.addEventListener('click', async e => {
      const pr = e.target.closest('[data-preset]');
      if (pr) { M.preset = pr.dataset.preset; await loadStats().catch(err => toast(err.message, 'err')); return renderStatsScreen(); }
      const gv = e.target.closest('[data-goview]'); if (gv) return setView(gv.dataset.goview);
      const mm = e.target.closest('[data-member]');
      if (mm) { const key = mm.dataset.member; return key === S.me.key ? setView('mine', mm.dataset.sub || 'open') : setView('member', mm.dataset.sub || 'open', key); }
      if (e.target.closest('#tbl-toggle')) { M.showTable = !M.showTable; return renderStatsScreen(); }
      if (e.target.closest('#u-add')) return openUser(null);
      const ue = e.target.closest('[data-uedit]'); if (ue) return openUser(ue.dataset.uedit);
      const up = e.target.closest('[data-upass]'); if (up) return openUser(up.dataset.upass, true);
      const ud = e.target.closest('[data-udel]'); if (ud) return openDel(ud.dataset.udel);
      const ur = e.target.closest('[data-urestore]');
      if (ur) {
        try { await api(`/team/${encodeURIComponent(ur.dataset.urestore)}/restore`, { method: 'POST' }); toast('הוחזר/ה לצוות', 'ok'); await refreshTeamCfg(); await loadTeam(); renderTeamScreen(); }
        catch (err) { toast(err.message, 'err'); }
      }
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr[data-member]')) e.target.click(); });
    el.addEventListener('change', async e => {
      if (e.target.id === 'r-from' || e.target.id === 'r-to') {
        M.from = $('#r-from').value; M.to = $('#r-to').value;
        await loadStats().catch(err => toast(err.message, 'err')); renderStatsScreen();
      }
    });
    // טולטיפ לגרף
    const tip = $('#tip');
    el.addEventListener('mousemove', e => {
      const col = e.target.closest('[data-tip]');
      if (!col) { tip.hidden = true; return; }
      tip.innerHTML = col.dataset.tip; tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2)) + 'px';
      tip.style.top = Math.max(8, e.clientY - h - 14) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
    $('#user-form').addEventListener('submit', saveUser);
    $('#dlg-del').addEventListener('close', async () => {
      if ($('#dlg-del').returnValue !== 'ok') return;
      const t = toast('מסיר מהצוות…', 'wait');
      try {
        const r = await api('/team/' + encodeURIComponent(M.delKey), { method: 'DELETE', json: { transferTo: $('#del-move').value || null } });
        t.set(`הוסר/ה מהצוות${r.moved ? ` · ${r.moved} פניות ${$('#del-move').value ? 'הועברו' : 'חזרו לכללי'}` : ''}`, 'ok');
        await refreshTeamCfg(); await loadTeam(); renderTeamScreen();
      } catch (err) { t.set(err.message, 'err'); }
    });
  }

  window.Manage = { open, tick };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
