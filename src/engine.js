// לב המערכת: בונה "פניות" משרשורי המייל, מחשב סטטוס, ומבצע פעולות צוות.
// מצב כל פניה נשמר כתוויות בג׳ימייל (KOH/...), ולכן שורד הפעלה מחדש של השרת.
const config = require('./config');
const { categorize } = require('./categorize');
const { extractForwardedSender, extractAttachment, allAttachments } = require('./mail/parse');

const L = {
  done: 'KOH/done', esc: 'KOH/escalated', ignore: 'KOH/ignore', keep: 'KOH/keep', reopen: 'KOH/reopened', followup: 'KOH/followup',
  by: k => `KOH/by/${k}`, cat: k => `KOH/cat/${k}`,
};

class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseSubject = s => (s || '').replace(/^(\s*(re|fw|fwd|השב|הועבר|תשובה)\s*:\s*)+/i, '').trim();
const fmtDate = iso => new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });

class Engine {
  constructor(provider) {
    this.p = provider;
    this.me = provider.address;
    this.team = new Map(config.TEAM.map(u => [u.key, u]));
    this.catKeys = new Set(config.CATEGORIES.map(c => c.key));
    this.cache = null;
    this.pending = new Map();      // threadId -> [הודעות יוצאות שנשלחו ועוד לא סונכרנו]
    this.log = [];
    this.stateLoaded = false;
    this.locks = new Map();
    provider.on('change', () => { this.cache = null; });
    provider.on('ready', () => { this.cache = null; this.loadState(); });
  }

  loadState() {
    const s = this.p.loadState();
    if (s && Array.isArray(s.log)) this.log = s.log;
    this.stateLoaded = true;
  }

  saveStateSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.p.saveState({ v: 1, log: this.log.slice(-5000) }).catch(e => console.error('[state]', e.message));
    }, 8000);
  }

  addLog(threadId, user, action, text) {
    this.log.push({ t: threadId, at: new Date().toISOString(), user: user && user.key, action, text });
    this.saveStateSoon();
  }

  userName(key) { return (this.team.get(key) || {}).name || key; }

  // ---------- בניית פניות ----------
  threads() {
    if (this.cache) return this.cache;
    const groups = new Map();
    for (const m of this.p.messages.values()) {
      if (m.system || m.labels.has('\\Draft')) continue;
      if (!groups.has(m.threadId)) groups.set(m.threadId, []);
      groups.get(m.threadId).push(m);
    }
    const out = [];
    for (const [threadId, msgs] of groups) {
      const t = this.buildThread(threadId, msgs);
      if (t) out.push(t);
    }
    this.cache = new Map(out.map(t => [t.id, t]));
    return this.cache;
  }

  // יוצאת = נשלחה מהדשבורד, או (בהודעות שיובאו מאאוטלוק) תשובה ישנה של הצוות מ-help@
  isOut(m) {
    return m.from.address === this.me || m.labels.has('\\Sent')
      || (m.imported && (config.FORWARDERS.includes(m.from.address) || config.IMPORT_SENDERS.includes(m.from.address)));
  }

  buildThread(threadId, msgs) {
    msgs.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid);
    const incoming = msgs.filter(m => !this.isOut(m));
    if (!incoming.length) return null;
    // רק מיילים שהגיעו דרך help@ (לפי הנמען המקורי או נתיב ההעברה) – כדי שמיילים פרטיים לא ייכנסו
    const viaHelp = m => m.imported || m.to.some(a => config.ACCEPT_TO.includes(a)) || config.FORWARDERS.includes(m.from.address)
      || config.ACCEPT_TO.some(a => (m.route || '').includes(a.split('@')[1]));
    if (config.ACCEPT_TO.length && !incoming.some(viaHelp)) return null;

    // פונה: אם הגיע Fwd ידני מכתובת מעבירה – ננסה לחלץ את השולח המקורי
    const senderOf = m => {
      if (config.FORWARDERS.includes(m.from.address) && m.fullText) {
        const orig = extractForwardedSender(m.fullText);
        if (orig && orig.address !== m.from.address) return orig;
      }
      return m.replyTo && m.replyTo.address && !config.FORWARDERS.includes(m.replyTo.address)
        ? { name: m.from.name || m.replyTo.name, address: m.replyTo.address } : m.from;
    };
    const first = incoming[0], lastIn = incoming[incoming.length - 1];
    const customer = senderOf(first);
    const replyTarget = senderOf(lastIn);

    // הודעות יוצאות שעוד לא הגיעו מהסנכרון
    let pend = this.pending.get(threadId) || [];
    pend = pend.filter(p => !msgs.some(m => m.messageId === p.messageId) && Date.now() - Date.parse(p.date) < 15 * 60e3);
    if (pend.length) this.pending.set(threadId, pend); else this.pending.delete(threadId);

    const labels = new Set(msgs.flatMap(m => [...m.labels]));
    const last = msgs[msgs.length - 1];
    const lastIsOut = pend.length > 0 || this.isOut(last);

    let status, assignee = null;
    for (const k of this.team.keys()) if (labels.has(L.by(k))) { assignee = k; break; }
    const autoIgnore = config.IGNORE_SENDERS.includes(customer.address) && !labels.has(L.keep);

    if (labels.has(L.ignore) || autoIgnore) status = 'ignored';
    else if (labels.has(L.esc)) status = 'escalated';
    else if ((lastIsOut && !last.labels.has(L.reopen)) || (!pend.length && last.labels.has(L.done))) status = 'handled';
    else if (assignee) status = 'in_progress';
    else status = 'new';

    const hadReply = msgs.some(m => this.isOut(m) || m.labels.has(L.done));
    const returned = status === 'new' && hadReply && !this.isOut(last);

    const manualCats = [...labels].filter(l => l.startsWith('KOH/cat/')).map(l => l.slice(8)).filter(k => this.catKeys.has(k));
    const categories = manualCats.length ? manualCats : categorize(first.subject + ' ' + incoming.map(m => m.body).join(' '));

    const view = m => ({
      id: m.uid, direction: this.isOut(m) ? 'out' : 'in',
      name: this.isOut(m) ? config.FROM_NAME : senderOf(m).name || senderOf(m).address,
      email: this.isOut(m) ? null : senderOf(m).address,
      author: this.isOut(m) ? (m.author ? this.userName(m.author) : null) : null,
      authorKey: this.isOut(m) ? m.author || null : null,
      date: m.date, body: m.body, quoted: m.quoted,
      attachments: m.attachments.map(a => ({ id: `${m.uid}-${a.index}`, name: a.name, type: a.type, size: a.size })),
    });

    return {
      id: threadId,
      subject: first.subject,
      fromName: customer.name || customer.address,
      fromEmail: customer.address,
      replyTarget,
      status, assignee, returned, categories,
      lastIncoming: lastIn.date,
      lastActivity: pend.length ? pend[pend.length - 1].date : last.date,
      uids: msgs.map(m => m.uid),
      lastUid: last.uid,
      lastIn,
      messages: [...msgs.map(view), ...pend],
      raw: msgs,
    };
  }

  summary(t) {
    return {
      id: t.id, subject: t.subject, fromName: t.fromName, fromEmail: t.fromEmail,
      status: t.status, assignee: t.assignee, assigneeName: t.assignee ? this.userName(t.assignee) : null,
      returned: t.returned, categories: t.categories, lastIncoming: t.lastIncoming,
      messageCount: t.messages.length,
      hasAttachments: t.messages.some(m => m.attachments.length),
      snippet: (t.lastIn.body || '').replace(/\s+/g, ' ').slice(0, 150),
    };
  }

  detail(t) {
    return {
      ...this.summary(t),
      messages: t.messages,
      events: this.log.filter(e => e.t === t.id).map(e => ({ at: e.at, user: e.user ? this.userName(e.user) : null, userKey: e.user, action: e.action, text: e.text })),
    };
  }

  list({ view = 'open', category, q }, user) {
    let items = [...this.threads().values()];
    const f = {
      open: t => t.status === 'new' || t.status === 'in_progress',
      mine: t => t.status === 'in_progress' && t.assignee === user.key,
      handled: t => t.status === 'handled',
      escalated: t => t.status === 'escalated',
      ignored: t => t.status === 'ignored',
    }[view] || (t => t.status !== 'ignored');
    items = items.filter(f);
    if (category) items = items.filter(t => t.categories.includes(category));
    if (q) {
      const s = q.trim().toLowerCase();
      items = items.filter(t => [t.subject, t.fromName, t.fromEmail, ...t.messages.map(m => m.body)].some(x => (x || '').toLowerCase().includes(s)));
    }
    return items.sort((a, b) => b.lastIncoming.localeCompare(a.lastIncoming)).map(t => this.summary(t));
  }

  counts(user) {
    const c = { open: 0, new: 0, in_progress: 0, mine: 0, handled: 0, escalated: 0, ignored: 0, returned: 0, byCategory: {} };
    for (const t of this.threads().values()) {
      c[t.status]++;
      if (t.status === 'new' || t.status === 'in_progress') {
        c.open++;
        if (t.returned) c.returned++;
        for (const k of t.categories) c.byCategory[k] = (c.byCategory[k] || 0) + 1;
      }
      if (t.status === 'in_progress' && t.assignee === user.key) c.mine++;
    }
    return c;
  }

  get(id) {
    const t = this.threads().get(id);
    if (!t) throw new AppError(404, 'הפניה לא נמצאה (ייתכן שנמחקה מהתיבה)');
    return t;
  }

  // כל הפעולות על אותה פניה רצות בתור – כדי ששני אנשים לא יתנגשו
  async locked(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(id, run);
    try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); }
  }

  byLabels() { return [...this.team.keys()].map(L.by); }
  refresh(id) { this.cache = null; return this.detail(this.get(id)); }

  // ---------- פעולות ----------
  take(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      if (t.status === 'escalated') throw new AppError(409, 'הפניה הועברה למנהל');
      if (t.status === 'in_progress' && t.assignee !== user.key) throw new AppError(409, `הפניה כבר בטיפול של ${this.userName(t.assignee)}`);
      // פניה שכבר טופלה (למשל נזכרנו להוסיף משהו ללקוח): פותחים אותה זמנית לתגובה נוספת.
      // אם משחררים בלי לענות – היא חוזרת ל"טופלה".
      const followup = t.status === 'handled';
      await this.p.modifyLabels(t.uids, [L.by(user.key)], this.byLabels().filter(l => l !== L.by(user.key)).concat(L.done, L.ignore));
      if (followup) await this.p.modifyLabels([t.lastUid], [L.reopen, L.followup], []);
      this.addLog(id, user, 'take', followup ? 'לקח/ה לטיפול פניה שכבר טופלה (תגובה נוספת)' : 'לקח/ה לטיפול');
      return this.refresh(id);
    });
  }

  release(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      if (t.assignee !== user.key) throw new AppError(403, 'רק מי שלקח את הפניה יכול לשחרר אותה');
      await this.p.modifyLabels(t.uids, [], this.byLabels());
      const last = t.raw[t.raw.length - 1];
      if (last && last.labels.has(L.followup)) {
        // נפתחה רק לתגובה נוספת ולא נשלח כלום – חוזרת ל"טופלה"
        await this.p.modifyLabels([t.lastUid], this.isOut(last) ? [] : [L.done], [L.reopen, L.followup]);
      }
      this.addLog(id, user, 'release', 'שחרר/ה את הפניה');
      return this.refresh(id);
    });
  }

  markHandled(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      if (t.status === 'in_progress' && t.assignee !== user.key) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      await this.p.modifyLabels([t.lastUid], [L.done], [L.reopen, L.followup]);
      await this.p.modifyLabels(t.uids, [], this.byLabels());
      this.addLog(id, user, 'handled', 'סימן/ה כטופל');
      return this.refresh(id);
    });
  }

  reopen(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      await this.p.modifyLabels(t.uids, [], [L.done, L.esc, L.ignore, L.followup, ...this.byLabels()]);
      if (t.raw.length && this.isOut(t.raw[t.raw.length - 1])) await this.p.modifyLabels([t.lastUid], [L.reopen, L.keep]);
      else await this.p.modifyLabels([t.lastUid], [L.keep]);
      this.addLog(id, user, 'reopen', 'החזיר/ה לפניות הפתוחות');
      return this.refresh(id);
    });
  }

  ignore(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      await this.p.modifyLabels(t.uids, [L.ignore], [L.keep, ...this.byLabels()]);
      this.addLog(id, user, 'ignore', 'סימן/ה "לא פניה" – הוסתר');
      return this.refresh(id);
    });
  }

  setCategories(id, cats, user) {
    return this.locked(id, async () => {
      const t = this.get(id);
      cats = cats.filter(k => this.catKeys.has(k));
      if (!cats.length) cats = ['general'];
      const all = config.CATEGORIES.map(c => L.cat(c.key));
      await this.p.modifyLabels(t.uids, [], all.filter(l => !cats.map(L.cat).includes(l)));
      await this.p.modifyLabels(t.uids, cats.map(L.cat), []);
      const names = cats.map(k => config.CATEGORIES.find(c => c.key === k).name).join(', ');
      this.addLog(id, user, 'categories', `עדכן/ה קטגוריות: ${names}`);
      return this.refresh(id);
    });
  }

  // מענה ללקוח באותה שרשרת מייל
  reply(id, user, body, files) {
    return this.locked(id, async () => {
      const t = this.get(id);
      if (t.status !== 'in_progress' || t.assignee !== user.key) throw new AppError(403, 'כדי לענות צריך קודם ללחוץ "קח לטיפול"');
      const li = t.lastIn;
      const subject = /^re\s*:/i.test(li.subject) ? li.subject : 'Re: ' + baseSubject(li.subject);
      const quoteHead = `בתאריך ${fmtDate(li.date)}, ${li.from.name || li.from.address} כתב/ה:`;
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;text-align:right">${esc(body).replace(/\n/g, '<br>')}</div>
<br><div dir="rtl" style="font-family:Arial,sans-serif;font-size:13px;color:#555;text-align:right">${esc(quoteHead)}</div>
<blockquote dir="rtl" style="margin:0 8px 0 0;padding:0 10px 0 0;border-right:2px solid #ccc;color:#555;font-family:Arial,sans-serif;font-size:13px;text-align:right">${esc(li.body + (li.quoted ? '\n\n' + li.quoted : '')).replace(/\n/g, '<br>')}</blockquote>`;
      const text = `${body}\n\n${quoteHead}\n${(li.body || '').split('\n').map(l => '> ' + l).join('\n')}`;
      const references = [...(li.references || []), li.messageId].filter(Boolean);

      const messageId = await this.p.send({
        to: { name: t.replyTarget.name || '', address: t.replyTarget.address },
        subject, text, html,
        inReplyTo: li.messageId || undefined,
        references: references.length ? references : undefined,
        headers: { 'X-KOH-Author': user.key },
        attachments: files.map(f => ({ filename: f.name, content: f.buffer, contentType: f.type })),
      });

      const pend = this.pending.get(id) || [];
      pend.push({
        id: 'pending-' + Date.now(), direction: 'out', name: config.FROM_NAME, email: null,
        author: user.name, authorKey: user.key, date: new Date().toISOString(), body, quoted: null,
        attachments: files.map((f, i) => ({ id: null, name: f.name, type: f.type, size: f.size })), messageId,
      });
      this.pending.set(id, pend);
      // המייל כבר נשלח – גם אם עדכון התוויות נכשל, לא מחזירים שגיאה (אחרת ישלחו שוב)
      await this.p.modifyLabels(t.uids, [], [...this.byLabels(), L.reopen, L.followup]).catch(e => console.error('[reply] labels', e.message));
      this.addLog(id, user, 'reply', `השיב/ה ל-${t.replyTarget.address}`);
      return this.refresh(id);
    });
  }

  // העברה למנהל: כל ההתכתבות + קבצים במייל אחד, והפניה יורדת מהדשבורד
  escalate(id, user, note) {
    return this.locked(id, async () => {
      const t = this.get(id);
      if (t.status === 'in_progress' && t.assignee !== user.key) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      const rows = t.messages.map(m => `
        <div style="border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:0 0 10px;background:${m.direction === 'out' ? '#f0f7ff' : '#fff'}">
          <div style="font-size:12px;color:#666;margin-bottom:6px"><b style="color:#222">${esc(m.direction === 'out' ? `הצוות${m.author ? ' (' + m.author + ')' : ''}` : `${m.name} &lt;${m.email}&gt;`)}</b> · ${esc(fmtDate(m.date))}</div>
          <div>${esc(m.body).replace(/\n/g, '<br>')}</div></div>`).join('');
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;text-align:right">
        <p>פניה הועברה לטיפולך ע"י <b>${esc(user.name)}</b> ממערכת ניהול הפניות.</p>
        ${note ? `<p style="background:#fff7e6;border-right:4px solid #f59e0b;padding:8px 12px"><b>הערה:</b> ${esc(note)}</p>` : ''}
        <p><b>פונה:</b> ${esc(t.fromName)} &lt;${esc(t.fromEmail)}&gt;<br><b>נושא:</b> ${esc(t.subject)}</p>
        <hr style="border:0;border-top:1px solid #ddd">${rows}</div>`;

      const attachments = [];
      let total = 0;
      for (const m of t.raw) {
        if (!m.attachments.length) continue;
        const raw = await this.p.getRaw(m.uid);
        for (const a of await allAttachments(raw)) {
          if (total + a.content.length > 18 * 1024 * 1024) break;
          total += a.content.length;
          attachments.push(a);
        }
      }
      await this.p.send({
        to: config.MANAGER_EMAIL,
        replyTo: t.replyTarget.address,
        subject: `הועבר לטיפולך: ${baseSubject(t.subject)} – ${t.fromName}`,
        html, text: html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''),
        headers: { 'X-KOH-System': 'forward', 'X-KOH-Author': user.key },
        attachments,
      });
      await this.p.modifyLabels(t.uids, [L.esc], this.byLabels()).catch(e => console.error('[escalate] labels', e.message));
      this.addLog(id, user, 'escalate', `העביר/ה למנהל (${config.MANAGER_EMAIL})${note ? ' – ' + note : ''}`);
      return this.refresh(id);
    });
  }

  async attachment(attId) {
    const [uid, idx] = String(attId).split('-').map(Number);
    if (!this.p.messages.has(uid)) throw new AppError(404, 'הקובץ לא נמצא');
    const raw = await this.p.getRaw(uid);
    const a = raw && await extractAttachment(raw, idx);
    if (!a) throw new AppError(404, 'הקובץ לא נמצא');
    return a;
  }
}

module.exports = { Engine, AppError };
