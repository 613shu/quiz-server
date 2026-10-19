// לב המערכת: בונה "פניות" משרשורי המייל, מחשב סטטוס, ומבצע פעולות צוות.
// מצב כל פניה נשמר כתוויות בג׳ימייל (KOH/...), ולכן שורד הפעלה מחדש של השרת.
const config = require('./config');
const { categorize, isEnglish } = require('./categorize');
const { extractForwardedSender, extractAttachment } = require('./mail/parse');
const { splitHistory, bodyKey } = require('./mail/history');

const L = {
  done: 'KOH/done', esc: 'KOH/escalated', ignore: 'KOH/ignore', keep: 'KOH/keep', reopen: 'KOH/reopened', followup: 'KOH/followup', notEnglish: 'KOH/not-english',
  free: 'KOH/free', assigned: 'KOH/assigned',
  // KOH/by/<key> = מי שהפניה שלו. נשאר גם אחרי המענה – כדי שתגובה חוזרת של הלקוח תגיע לאותו חבר צוות.
  by: k => `KOH/by/${k}`, cat: k => `KOH/cat/${k}`,
};
const ilDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// כתובת מייל תקינה אחת (לנמען שהוקלד ידנית)
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/;
// הודעת מערכת: שם השולח או הכתובת מכילים את אחד הערכים ב-SYSTEM_SENDERS
const isSystemSender = p => {
  const hay = `${(p && p.name) || ''} ${(p && p.address) || ''}`.toLowerCase();
  return config.SYSTEM_SENDERS.some(s => hay.includes(s));
};

class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseSubject = s => (s || '').replace(/^(\s*(re|fw|fwd|השב|הועבר|תשובה)\s*:\s*)+/i, '').trim();
const fmtDate = iso => new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });

class Engine {
  constructor(provider, users) {
    this.p = provider;
    this.me = provider.address;
    this.users = users;
    this.catKeys = new Set(config.CATEGORIES.map(c => c.key));
    this.cache = null;
    this.pending = new Map();      // threadId -> [הודעות יוצאות שנשלחו ועוד לא סונכרנו]
    this.log = [];                 // יומן פעולות שוטף
    this.oldLog = [];              // רשומות ישנות מהארכיון (לסטטיסטיקה ולהיסטוריה)
    this.notes = [];               // הערות פנימיות – לא נשלחות לתורם
    this.stateLoaded = false;
    this.stateBroken = false;
    this.locks = new Map();
    this.saveChain = Promise.resolve();
    provider.on('change', () => { this.cache = null; });
    provider.on('ready', () => { this.cache = null; if (!this.stateLoaded) this.loadState(); });
  }

  loadState() {
    let s;
    try { s = this.p.loadState(); }
    catch (e) {
      // מצב פגום – לא דורסים אותו. המשתמשים נשארים לפי TEAM_USERS ושום דבר לא נשמר עד שיטופל.
      console.error('[state] לא נטען:', e.message);
      this.stateBroken = true; this.stateLoaded = true; return;
    }
    if (s && Array.isArray(s.log)) this.log = s.log;
    if (s && Array.isArray(s.notes)) this.notes = s.notes;
    try { this.oldLog = (this.p.loadArchives ? this.p.loadArchives() : []).flatMap(a => a.log || []); } catch (e) { console.error('[archive]', e.message); }
    const seeded = this.users.load(s && s.users);
    this.stateLoaded = true;
    this.cache = null;
    if (seeded) {
      console.log(`[users] נוצרו ${this.users.all().length} משתמשים מ-TEAM_USERS`);
      this.saveStateNow().catch(e => console.error('[state]', e.message));
    }
  }

  // שמירה בתור (כדי ששתי שמירות לא ירוצו במקביל). יומן ארוך עובר לארכיון במקום להימחק.
  saveStateNow() {
    clearTimeout(this.saveTimer);
    const run = this.saveChain.catch(() => {}).then(async () => {
      if (!this.stateLoaded || this.stateBroken) return;
      if (this.log.length > 4000) {
        const cut = this.log.length - 3000, chunk = this.log.slice(0, cut);
        await this.p.saveArchive({ v: 1, log: chunk });
        this.oldLog.push(...chunk);
        this.log = this.log.slice(cut);
      }
      await this.p.saveState({ v: 2, log: this.log, notes: this.notes, users: this.users.toJSON() });
    });
    this.saveChain = run;
    return run;
  }

  saveStateSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveStateNow().catch(e => console.error('[state]', e.message)), 8000);
  }

  addLog(threadId, user, action, text) {
    this.log.push({ t: threadId, at: new Date().toISOString(), user: user && user.key, action, text });
    this.saveStateSoon();
  }

  userName(key) { return (this.users.get(key) || {}).name || key; }
  isManager(user) { const u = user && this.users.get(user.key); return !!u && !u.deleted && u.role === 'manager'; }
  // כל המפתחות שאי פעם היו (כולל משתמשים שנמחקו) – כדי לנקות תוויות ישנות
  allKeys() { return [...new Set([...this.users.all().map(u => u.key), ...config.TEAM.map(u => u.key)])]; }

  // ---------- בניית פניות ----------
  // פניה = קבוצת הודעות. מתחילים מהשרשור של Gmail, ומאחדים שרשורים שהם בעצם אותה שיחה:
  // 1. לפי הכותרות In-Reply-To / References (הודעה שעונה להודעה משרשור אחר).
  // 2. אם ה-Message-ID השתנה בהעברה מאאוטלוק: אותו פונה + אותו נושא (בלי Re/Fw) בהפרש של עד 30 יום.
  // זה חשוב במיוחד להודעות מיובאות – Gmail לא תמיד משייך אותן לשרשור הקיים.
  threads() {
    if (this.cache) return this.cache;
    const msgs = [...this.p.messages.values()].filter(m => !m.system && !m.labels.has('\\Draft'));
    const out = [];
    this.alias = new Map();
    for (const g of this.mergeGroups(msgs)) {
      const t = this.buildThread(g.id, g.msgs, g.ids);
      if (!t) continue;
      out.push(t);
      for (const x of g.ids) this.alias.set(x, g.id);
    }
    this.cache = new Map(out.map(t => [t.id, t]));
    return this.cache;
  }

  // מי הצד השני בשיחה (לאיחוד לפי נושא): בהודעה נכנסת – השולח, ביוצאת – הנמען
  partyOf(m) {
    const skip = a => !a || a === this.me || config.ACCEPT_TO.includes(a) || config.FORWARDERS.includes(a);
    if (this.isOut(m)) return (m.to || []).find(a => !skip(a)) || null;
    const a = m.replyTo && m.replyTo.address && !skip(m.replyTo.address) ? m.replyTo.address : m.from.address;
    return skip(a) ? null : a;
  }

  mergeGroups(msgs) {
    const tidOf = m => m.threadId ? String(m.threadId) : `u${m.uid}`;
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(b, a); };
    for (const m of msgs) parent.set(tidOf(m), tidOf(m));

    // 1. לפי כותרות התשובה
    const byMid = new Map();
    for (const m of msgs) if (m.messageId) byMid.set(m.messageId, tidOf(m));
    for (const m of msgs) {
      for (const ref of [m.inReplyTo, ...(m.references || [])]) {
        const other = ref && byMid.get(ref);
        if (other) union(tidOf(m), other);
      }
    }

    // 2. אותו פונה + אותו נושא, קרובים בזמן
    const WINDOW = 30 * 24 * 3600e3;
    const lastByKey = new Map();
    const sorted = [...msgs].sort((a, b) => a.date.localeCompare(b.date));
    for (const m of sorted) {
      const party = this.partyOf(m);
      const subj = baseSubject(m.subject).toLowerCase().replace(/\s+/g, ' ');
      if (!party || subj.length < 2 || subj === '(ללא נושא)') continue;
      const key = `${party}|${subj}`, prev = lastByKey.get(key), t = Date.parse(m.date);
      if (prev && t - prev.t <= WINDOW) union(tidOf(m), prev.tid);
      lastByKey.set(key, { t, tid: tidOf(m) });
    }

    const groups = new Map();
    for (const m of msgs) {
      const r = find(tidOf(m));
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(m);
    }
    // מזהה קבוע לפניה: השרשור של ההודעה החיה (לא מיובאת) הראשונה – כך ייבוא ישן לא משנה את המזהה
    return [...groups.values()].map(list => {
      list.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid);
      const anchor = list.find(m => !m.imported) || list[0];
      return { id: tidOf(anchor), ids: [...new Set(list.map(tidOf))], msgs: list };
    });
  }

  // יוצאת = נשלחה מהדשבורד, או (בהודעות שיובאו מאאוטלוק) תשובה ישנה של הצוות מ-help@
  isOut(m) {
    return m.from.address === this.me || m.labels.has('\\Sent')
      || (m.imported && (config.FORWARDERS.includes(m.from.address) || config.IMPORT_SENDERS.includes(m.from.address)));
  }

  buildThread(threadId, msgs, ids = [threadId]) {
    msgs.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid);
    const incoming = msgs.filter(m => !this.isOut(m));
    if (!incoming.length) return null;
    // רק מיילים שהגיעו דרך help@ (לפי הנמען המקורי או נתיב ההעברה) – כדי שמיילים פרטיים לא ייכנסו
    const viaHelp = m => m.imported || m.to.some(a => config.ACCEPT_TO.includes(a)) || config.FORWARDERS.includes(m.from.address)
      || config.ACCEPT_TO.some(a => (m.route || '').includes(a.split('@')[1]));
    if (!config.ACCEPT_ALL && config.ACCEPT_TO.length && !incoming.some(viaHelp)) return null;

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
    let pend = ids.flatMap(x => this.pending.get(x) || []);
    ids.forEach(x => { if (x !== threadId) this.pending.delete(x); });
    pend = pend.filter(p => !msgs.some(m => m.messageId === p.messageId) && Date.now() - Date.parse(p.date) < 15 * 60e3);
    pend.sort((a, b) => a.date.localeCompare(b.date));
    if (pend.length) this.pending.set(threadId, pend); else this.pending.delete(threadId);

    const labels = new Set(msgs.flatMap(m => [...m.labels]));
    const last = msgs[msgs.length - 1];
    const lastIsOut = pend.length > 0 || this.isOut(last);

    // מי הפניה שלו: תווית KOH/by מפורשת; ואם אין – מי שענה אחרון מהדשבורד (לפניות שנענו לפני שהתווית נשמרה).
    // KOH/free = שוחררה / הוחזרה לכללי – אין בעלים. חבר צוות שנמחק לא מקבל פניות.
    let byKey = null;
    for (const k of this.allKeys()) if (labels.has(L.by(k))) { byKey = k; break; }
    let assignee = null;
    if (byKey) assignee = this.users.isActive(byKey) ? byKey : null;
    else if (!labels.has(L.free) && !labels.has(L.esc)) {
      const authors = [...msgs.filter(m => this.isOut(m)).map(m => m.author), ...pend.map(p => p.authorKey)].filter(Boolean);
      assignee = authors.reverse().find(k => this.users.isActive(k)) || null;
    }
    const autoIgnore = config.IGNORE_SENDERS.includes(customer.address) && !labels.has(L.keep);

    let status;
    if (labels.has(L.ignore) || autoIgnore) status = 'ignored';
    else if (labels.has(L.esc)) status = 'escalated';
    else if ((lastIsOut && !last.labels.has(L.reopen)) || (!pend.length && last.labels.has(L.done))) status = 'handled';
    else if (assignee) status = 'in_progress';
    else status = 'new';

    // בתיקיית המנהל: חדשה (הלקוח כתב אחרון / עוד לא נענתה), בטיפול, או נענתה
    const mgr = status === 'escalated' ? (assignee ? 'in_progress' : lastIsOut ? 'answered' : 'new') : null;

    const hadReply = msgs.some(m => this.isOut(m) || m.labels.has(L.done));
    // הלקוח כתב שוב אחרי שכבר ענינו – אצל המטפל/ת (בטיפול) או בכללי (אם אין מטפל/ת)
    const returned = (status === 'new' || status === 'in_progress') && hadReply && !lastIsOut;
    // ממתינה לנו: ההודעה האחרונה היא של הלקוח
    const waiting = !lastIsOut && (status === 'new' || status === 'in_progress' || (status === 'escalated' && mgr === 'new'));
    const assigned = status === 'in_progress' && labels.has(L.assigned);

    const manualCats = [...labels].filter(l => l.startsWith('KOH/cat/')).map(l => l.slice(8)).filter(k => this.catKeys.has(k));
    // הודעות מערכת (Synchroline, MailAdmin, Charidy Support…) – ישר לקטגוריה "הודעות מערכת"
    const fromSystem = isSystemSender(customer) || isSystemSender(first.from);
    let categories = manualCats.length ? manualCats
      : fromSystem ? ['system']
      : categorize(first.subject + ' ' + incoming.map(m => m.body).join(' '));
    // "אנגלית" – מזוהה אוטומטית גם כשיש קטגוריות ידניות (אלא אם מישהו הוריד אותה ידנית)
    if (!categories.includes('english') && !categories.includes('system') && !labels.has(L.notEnglish) && isEnglish(incoming.map(m => m.body))) {
      categories = [...categories.filter(k => k !== 'general'), 'english'];
    }

    const view = m => ({
      id: m.uid, direction: this.isOut(m) ? 'out' : 'in',
      name: this.isOut(m) ? config.FROM_NAME : senderOf(m).name || senderOf(m).address,
      email: this.isOut(m) ? null : senderOf(m).address,
      author: this.isOut(m) ? (m.author ? this.userName(m.author) : null) : null,
      authorKey: this.isOut(m) ? m.author || null : null,
      to: this.isOut(m) ? ((m.to || []).filter(a => a !== this.me).join(', ') || null) : null,
      date: m.date, body: m.body, quoted: m.quoted,
      attachments: m.attachments.map(a => ({ id: `${m.uid}-${a.index}`, name: a.name, type: a.type, size: a.size, inline: a.inline })),
    });

    // ההתכתבות המלאה: הודעות שלא נמצאות בתיבה (לא יובאו) משוחזרות מתוך הציטוט של ההודעות שכן קיימות
    const shown = msgs.map(view);
    const history = this.reconstruct(msgs, shown, customer);
    const messages = [...shown, ...history].sort((a, b) => a.date.localeCompare(b.date));

    return {
      id: threadId,
      ids,
      subject: first.subject,
      fromName: customer.name || customer.address,
      fromEmail: customer.address,
      replyTarget,
      status, mgr, assignee, returned, waiting, assigned, categories,
      lastIncoming: lastIn.date,
      lastActivity: pend.length ? pend[pend.length - 1].date : last.date,
      uids: msgs.map(m => m.uid),
      lastUid: last.uid,
      lastIn,
      messages: [...messages, ...pend],
      raw: msgs,
    };
  }

  // פירוק הציטוטים להודעות נפרדות, בלי כפילויות מול ההודעות האמיתיות (לפי כיוון + זמן, או תוכן זהה)
  reconstruct(msgs, shown, customer) {
    const own = a => !!a && (a === this.me || config.FORWARDERS.includes(a) || config.IMPORT_SENDERS.includes(a)
      || config.ACCEPT_TO.includes(a) || config.TEAM_DOMAINS.some(d => a.endsWith('@' + d)));
    const ownName = n => !!n && (n === config.FROM_NAME || /koh|help|עולם התורה/i.test(n));
    const known = shown.map(v => ({ dir: v.direction, t: Date.parse(v.date), key: bodyKey(v.body) }));
    const same = (a, b) => a.dir === b.dir && (
      (a.t && b.t && Math.abs(a.t - b.t) <= 3 * 60e3)
      || (a.key && a.key === b.key && (!a.t || !b.t || Math.abs(a.t - b.t) <= 15 * 3600e3)));   // אותו תוכן (גם אם השעה בציטוט באזור זמן אחר)
    const byUid = new Map(shown.map(v => [v.id, v]));
    const out = [];
    // מהחדשה לישנה – בהודעה האחרונה נמצאת ההיסטוריה המלאה ביותר
    for (const m of [...msgs].sort((a, b) => b.date.localeCompare(a.date))) {
      if (!m.quoted) continue;
      if (!m._hist) m._hist = splitHistory(m.quoted);
      const { parts, complete } = m._hist;
      if (complete && byUid.get(m.uid)) byUid.get(m.uid).quoted = null;   // הכול פורק לבועות – אין צורך בכפתור "היסטוריה קודמת"
      const base = Date.parse(m.date);
      parts.forEach((p, i) => {
        let t = p.date ? Date.parse(p.date) : null;
        if (t && t > base + 5 * 60e3) t = null;     // תאריך לא הגיוני (אחרי ההודעה שמצטטת אותו)
        const dir = own(p.address) || (!p.address && ownName(p.name)) ? 'out' : 'in';
        const c = { dir, t, key: bodyKey(p.body) };
        if (!c.key) return;
        if (known.some(k => same(k, c))) return;
        known.push(c);
        const email = dir === 'out' ? null : (p.address || customer.address);
        out.push({
          id: `h${m.uid}-${i}`, direction: dir, reconstructed: true, dateUnknown: !t,
          name: dir === 'out' ? config.FROM_NAME : (p.name || (email === customer.address ? customer.name : '') || email),
          email, author: null, authorKey: null,
          date: new Date(t || base - (i + 1) * 1000).toISOString(),
          body: p.body, quoted: null, attachments: [],
        });
      });
    }
    return out;
  }

  summary(t) {
    const overdue = t.waiting && Date.now() - Date.parse(t.lastIncoming) > config.OVERDUE_HOURS * 3600e3;
    return {
      id: t.id, subject: t.subject, fromName: t.fromName, fromEmail: t.fromEmail,
      status: t.status, mgr: t.mgr, assignee: t.assignee, assigneeName: t.assignee ? this.userName(t.assignee) : null,
      returned: t.returned, assigned: t.assigned, waiting: t.waiting, overdue, categories: t.categories,
      lastIncoming: t.lastIncoming, lastActivity: t.lastActivity,
      messageCount: t.messages.length,
      hasAttachments: t.messages.some(m => m.attachments.length),
      snippet: (t.lastIn.body || '').replace(/\s+/g, ' ').slice(0, 150),
    };
  }

  // הערות פנימיות: רואים רק מי שכתב/ה, המנהל, ומי שהפניה אצלו עכשיו
  notesFor(t, user) {
    const mgr = this.isManager(user);
    return this.notes.filter(n => t.ids.includes(n.t))
      .filter(n => mgr || n.user === user.key || t.assignee === user.key)
      .map(n => ({ id: n.id, at: n.at, user: this.userName(n.user), userKey: n.user, text: n.text, kind: n.kind || 'note', canDelete: mgr || n.user === user.key }));
  }

  detail(t, user) {
    return {
      ...this.summary(t),
      messages: t.messages,
      replyTo: t.replyTarget.address,
      events: [...this.oldLog, ...this.log].filter(e => t.ids.includes(e.t)).map(e => ({ at: e.at, user: e.user ? this.userName(e.user) : null, userKey: e.user, action: e.action, text: e.text })),
      notes: this.notesFor(t, user),
    };
  }

  // ---------- הרשאות צפייה ----------
  // מנהל: הכול. חבר צוות: פניות כלליות (חדשות בלי מטפל/ת) + הפניות שלו (בטיפול / טופלו על ידו).
  canSee(t, user) {
    if (this.isManager(user)) return true;
    if (t.status === 'new') return true;
    return (t.status === 'in_progress' || t.status === 'handled') && t.assignee === user.key;
  }

  inRange(iso, from, to) {
    const d = ilDay(iso);
    return (!from || d >= from) && (!to || d <= to);
  }

  // view: open (כללי) | mine | member (מנהל) | handled | escalated | ignored | overdue
  // sub (ל-mine/member): open | returned | overdue | done
  list({ view = 'open', sub = 'open', member, category, q, from, to }, user) {
    const mgr = this.isManager(user);
    if (['handled', 'escalated', 'ignored', 'overdue', 'member'].includes(view) && !mgr) throw new AppError(403, 'רק למנהל');
    const who = view === 'member' ? member : user.key;
    const all = [...this.threads().values()];
    const personal = t => t.assignee === who;
    const subF = {
      open: t => t.status === 'in_progress' && personal(t),
      returned: t => t.status === 'in_progress' && personal(t) && (t.returned || t.assigned),
      overdue: t => t.status === 'in_progress' && personal(t) && this.summary(t).overdue,
      done: t => t.status === 'handled' && personal(t) && this.inRange(t.lastActivity, from, to),
    };
    const f = {
      open: mgr ? (t => t.status === 'new' || t.status === 'in_progress') : (t => t.status === 'new'),
      mine: subF[sub] || subF.open,
      member: subF[sub] || subF.open,
      handled: t => t.status === 'handled' && this.inRange(t.lastActivity, from, to),
      escalated: t => t.status === 'escalated',
      ignored: t => t.status === 'ignored',
      overdue: t => this.summary(t).overdue,
    }[view] || (t => t.status === 'new');
    let items = all.filter(f);

    // מונים לפי קטגוריה – על התצוגה הנוכחית (לפני סינון קטגוריה/חיפוש)
    const byCategory = {};
    for (const t of items) for (const k of t.categories) byCategory[k] = (byCategory[k] || 0) + 1;
    // מונים ללשוניות המשנה של "הפניות שלי"
    let subCounts = null;
    if (view === 'mine' || view === 'member') {
      subCounts = {};
      for (const k of Object.keys(subF)) subCounts[k] = k === 'done' ? all.filter(t => t.status === 'handled' && personal(t)).length : all.filter(subF[k]).length;
    }

    if (category) items = items.filter(t => t.categories.includes(category));
    if (q) {
      const s = q.trim().toLowerCase();
      items = items.filter(t => [t.subject, t.fromName, t.fromEmail, ...t.messages.map(m => m.body)].some(x => (x || '').toLowerCase().includes(s)));
    }
    const key = (sub === 'done' || view === 'handled') ? 'lastActivity' : 'lastIncoming';
    items.sort((a, b) => b[key].localeCompare(a[key]));
    return { items: items.map(t => this.summary(t)), byCategory, subCounts };
  }

  counts(user) {
    const mgr = this.isManager(user), me = user.key, today = ilDay(new Date().toISOString());
    const c = { general: 0, open: 0, new: 0, in_progress: 0, mine: 0, mineReturned: 0, mineOverdue: 0, mineDone: 0, mineDoneToday: 0,
      handled: 0, escalated: 0, escalatedOpen: 0, ignored: 0, overdue: 0 };
    for (const t of this.threads().values()) {
      const s = this.summary(t);
      if (t.status === 'new') c.general++;
      if (t.status === 'in_progress' && t.assignee === me) {
        c.mine++;
        if (t.returned || t.assigned) c.mineReturned++;
        if (s.overdue) c.mineOverdue++;
      }
      if (t.status === 'handled' && t.assignee === me) { c.mineDone++; if (ilDay(t.lastActivity) === today) c.mineDoneToday++; }
      if (!mgr) continue;
      c[t.status]++;
      if (t.status === 'new' || t.status === 'in_progress') c.open++;
      if (t.status === 'escalated' && t.mgr !== 'answered') c.escalatedOpen++;
      if (s.overdue) c.overdue++;
    }
    if (!mgr) c.new = c.general;
    return c;
  }

  get(id, user) {
    const all = this.threads();
    const t = all.get(id) || all.get(this.alias && this.alias.get(String(id)));
    if (!t) throw new AppError(404, 'הפניה לא נמצאה (ייתכן שנמחקה מהתיבה)');
    if (user && !this.canSee(t, user)) throw new AppError(403, 'הפניה הזו לא נמצאת אצלך');
    return t;
  }

  // כל הפעולות על אותה פניה רצות בתור – כדי ששני אנשים לא יתנגשו
  async locked(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(id, run);
    try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); }
  }

  byLabels() { return this.allKeys().map(L.by); }
  // אחרי פעולה: אם המשתמש עדיין רואה את הפניה – הפרטים המלאים; אחרת רק סימן שהיא כבר לא אצלו
  refresh(id, user) {
    this.cache = null;
    const t = this.get(id);
    return this.canSee(t, user) ? this.detail(t, user) : { id: t.id, hidden: true, status: t.status };
  }
  // קביעת הבעלים: תווית אחת בלבד
  setOwner(t, key) {
    const rm = this.byLabels().filter(l => l !== L.by(key));
    return this.p.modifyLabels(t.uids, [L.by(key)], [...rm, L.free]);
  }

  // ---------- פעולות ----------
  take(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user), mgr = this.isManager(user);
      if (t.status === 'ignored') throw new AppError(400, 'הפניה מוסתרת. קודם צריך להחזיר אותה.');
      if (t.status === 'escalated' && !mgr) throw new AppError(403, 'רק המנהל מטפל בפניות שהועברו אליו');
      if (t.status === 'in_progress' && t.assignee && t.assignee !== user.key && !mgr) throw new AppError(409, `הפניה כבר בטיפול של ${this.userName(t.assignee)}`);
      // פניה שכבר טופלה (למשל נזכרנו להוסיף משהו ללקוח): פותחים אותה זמנית לתגובה נוספת.
      // אם משחררים בלי לענות – היא חוזרת ל"טופלה".
      const followup = t.status === 'handled';
      const from = t.assignee && t.assignee !== user.key ? t.assignee : null;
      await this.setOwner(t, user.key);
      await this.p.modifyLabels(t.uids, [], [L.done, L.ignore, L.assigned]);
      if (followup) await this.p.modifyLabels([t.lastUid], [L.reopen, L.followup], []);
      this.addLog(id, user, 'take', (followup ? 'לקח/ה לטיפול פניה שכבר טופלה (תגובה נוספת)' : 'לקח/ה לטיפול') + (from ? ` (מ${this.userName(from)})` : ''));
      return this.refresh(id, user);
    });
  }

  release(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user), mgr = this.isManager(user);
      if (t.assignee !== user.key && !mgr) throw new AppError(403, 'רק מי שהפניה אצלו יכול לשחרר אותה');
      const last = t.raw[t.raw.length - 1];
      if (last && last.labels.has(L.followup)) {
        // נפתחה רק לתגובה נוספת ולא נשלח כלום – חוזרת ל"טופלה", ונשארת של אותו חבר צוות
        await this.p.modifyLabels([t.lastUid], this.isOut(last) ? [] : [L.done], [L.reopen, L.followup]);
        this.addLog(id, user, 'release', 'ביטל/ה תגובה נוספת');
      } else if (t.status === 'escalated') {
        await this.p.modifyLabels(t.uids, [], this.byLabels());
        this.addLog(id, user, 'release', 'שחרר/ה (נשארת בתיקיית המנהל)');
      } else {
        await this.p.modifyLabels(t.uids, [L.free], [...this.byLabels(), L.assigned]);
        this.addLog(id, user, 'release', 'שחרר/ה – הפניה חזרה לפניות הכלליות');
      }
      return this.refresh(id, user);
    });
  }

  markHandled(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user), mgr = this.isManager(user);
      if (t.status === 'in_progress' && t.assignee !== user.key && !mgr) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      await this.p.modifyLabels([t.lastUid], [L.done], [L.reopen, L.followup]);
      // נשארת של מי שטיפל בה (כדי שתגובה חוזרת תגיע אליו). בתיקיית המנהל / בלי מטפל – של מי שסימן.
      await this.setOwner(t, t.status === 'escalated' || !t.assignee ? user.key : t.assignee);
      await this.p.modifyLabels(t.uids, [], [L.esc, L.assigned]);
      this.addLog(id, user, 'handled', t.status === 'escalated' ? 'סימן/ה כטופל (הוסרה מתיקיית המנהל)' : 'סימן/ה כטופל');
      return this.refresh(id, user);
    });
  }

  // מנהל: מחזיר לפניות הכלליות (מתיקיית המנהל, מטופלות, מוסתרות או מחבר צוות)
  reopen(id, user) {
    return this.locked(id, async () => {
      if (!this.isManager(user)) throw new AppError(403, 'רק המנהל יכול להחזיר פניה לכללי');
      const t = this.get(id, user);
      await this.p.modifyLabels(t.uids, [L.free], [L.done, L.esc, L.ignore, L.followup, L.assigned, ...this.byLabels()]);
      if (t.raw.length && this.isOut(t.raw[t.raw.length - 1])) await this.p.modifyLabels([t.lastUid], [L.reopen, L.keep]);
      else await this.p.modifyLabels([t.lastUid], [L.keep]);
      this.addLog(id, user, 'reopen', t.status === 'escalated' ? 'החזיר/ה מתיקיית המנהל לפניות הכלליות' : 'החזיר/ה לפניות הכלליות');
      return this.refresh(id, user);
    });
  }

  // מנהל: מעביר פניה לחבר צוות מסוים
  assign(id, user, toKey) {
    return this.locked(id, async () => {
      if (!this.isManager(user)) throw new AppError(403, 'רק המנהל יכול להעביר פניה לחבר צוות');
      if (!this.users.isActive(toKey)) throw new AppError(400, 'חבר הצוות לא נמצא');
      const t = this.get(id, user);
      if (t.assignee === toKey && t.status === 'in_progress') throw new AppError(409, `הפניה כבר אצל ${this.userName(toKey)}`);
      await this.setOwner(t, toKey);
      await this.p.modifyLabels(t.uids, toKey === user.key ? [] : [L.assigned], [L.esc, L.ignore, L.done, L.followup]);
      // פניה שכבר נענתה – נפתחת מחדש אצל מי שקיבל/ה אותה
      if (t.raw.length && this.isOut(t.raw[t.raw.length - 1])) await this.p.modifyLabels([t.lastUid], [L.reopen, L.keep]);
      else await this.p.modifyLabels([t.lastUid], [L.keep]);
      this.addLog(id, user, 'assign', `העביר/ה לטיפול של ${this.userName(toKey)}`);
      return this.refresh(id, user);
    });
  }

  ignore(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user), mgr = this.isManager(user);
      if (!mgr && t.status !== 'new' && t.assignee !== user.key) throw new AppError(403, 'אין הרשאה');
      await this.p.modifyLabels(t.uids, [L.ignore], [L.keep, L.assigned, ...this.byLabels()]);
      this.addLog(id, user, 'ignore', 'סימן/ה "לא פניה" – הוסתר');
      return this.refresh(id, user);
    });
  }

  setCategories(id, cats, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user);
      cats = cats.filter(k => this.catKeys.has(k));
      if (!cats.length) cats = ['general'];
      const all = config.CATEGORIES.map(c => L.cat(c.key));
      await this.p.modifyLabels(t.uids, [], all.filter(l => !cats.map(L.cat).includes(l)));
      await this.p.modifyLabels(t.uids, cats.map(L.cat), []);
      // הורדה ידנית של "אנגלית" נזכרת, כדי שהזיהוי האוטומטי לא יחזיר אותה
      if (cats.includes('english')) await this.p.modifyLabels(t.uids, [], [L.notEnglish]);
      else if (t.categories.includes('english')) await this.p.modifyLabels(t.uids, [L.notEnglish], []);
      const names = cats.map(k => config.CATEGORIES.find(c => c.key === k).name).join(', ');
      this.addLog(id, user, 'categories', `עדכן/ה קטגוריות: ${names}`);
      return this.refresh(id, user);
    });
  }

  // מענה ללקוח באותה שרשרת מייל
  // toAddress – רק אם המשתמש/ת שינה את הנמען; ריק = הפונה (שולח ההודעה האחרונה)
  reply(id, user, body, files, toAddress) {
    return this.locked(id, async () => {
      const t = this.get(id, user);
      if (!['in_progress', 'escalated'].includes(t.status) || t.assignee !== user.key) throw new AppError(403, 'כדי לענות צריך קודם ללחוץ "אני מטפל/ת בזה"');
      // אפשר כמה נמענים – מופרדים בפסיק, נקודה-פסיק או רווח
      const def = String(t.replyTarget.address).toLowerCase();
      const seen = new Set();
      const list = String(toAddress || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
        .filter(a => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
      const bad = list.find(a => !EMAIL_RE.test(a));
      if (bad) throw new AppError(400, `כתובת המייל של הנמען לא תקינה: ${bad}`);
      if (list.length > 10) throw new AppError(400, 'אפשר לשלוח לעד 10 נמענים במייל אחד');
      const same = !list.length || (list.length === 1 && list[0].toLowerCase() === def);
      const to = same ? [{ name: t.replyTarget.name || '', address: t.replyTarget.address }]
        : list.map(a => (a.toLowerCase() === def ? { name: t.replyTarget.name || '', address: t.replyTarget.address } : { name: '', address: a }));
      const toText = to.map(x => x.address).join(', ');
      const li = t.lastIn;
      const subject = /^re\s*:/i.test(li.subject) ? li.subject : 'Re: ' + baseSubject(li.subject);
      const quoteHead = `בתאריך ${fmtDate(li.date)}, ${li.from.name || li.from.address} כתב/ה:`;
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;text-align:right">${esc(body).replace(/\n/g, '<br>')}</div>
<br><div dir="rtl" style="font-family:Arial,sans-serif;font-size:13px;color:#555;text-align:right">${esc(quoteHead)}</div>
<blockquote dir="rtl" style="margin:0 8px 0 0;padding:0 10px 0 0;border-right:2px solid #ccc;color:#555;font-family:Arial,sans-serif;font-size:13px;text-align:right">${esc(li.body + (li.quoted ? '\n\n' + li.quoted : '')).replace(/\n/g, '<br>')}</blockquote>`;
      const text = `${body}\n\n${quoteHead}\n${(li.body || '').split('\n').map(l => '> ' + l).join('\n')}`;
      const references = [...(li.references || []), li.messageId].filter(Boolean);

      const messageId = await this.p.send({
        to,
        subject, text, html,
        inReplyTo: li.messageId || undefined,
        references: references.length ? references : undefined,
        headers: { 'X-KOH-Author': user.key },
        attachments: files.map(f => ({ filename: f.name, content: f.buffer, contentType: f.type })),
      });

      const pend = this.pending.get(t.id) || [];
      pend.push({
        id: 'pending-' + Date.now(), direction: 'out', name: config.FROM_NAME, email: null,
        author: user.name, authorKey: user.key, to: toText, date: new Date().toISOString(), body, quoted: null,
        attachments: files.map((f, i) => ({ id: null, name: f.name, type: f.type, size: f.size })), messageId,
      });
      this.pending.set(t.id, pend);
      // המייל כבר נשלח – גם אם עדכון התוויות נכשל, לא מחזירים שגיאה (אחרת ישלחו שוב).
      // הבעלות (KOH/by) נשארת – תגובה חוזרת של הלקוח תגיע לאותו חבר צוות.
      await this.p.modifyLabels(t.uids, [], [L.reopen, L.followup, L.assigned]).catch(e => console.error('[reply] labels', e.message));
      this.addLog(id, user, 'reply', same ? `השיב/ה ל-${toText}` : `השיב/ה ל-${toText} (נמענים שונים מברירת המחדל – הפונה ${t.replyTarget.address})`);
      return this.refresh(id, user);
    });
  }

  // העברה למנהל: רק תיוג. הפניה עוברת לתיקיית "הועבר למנהל" (רק המנהל רואה אותה). ההערה נשמרת כהערה פנימית.
  escalate(id, user, note) {
    return this.locked(id, async () => {
      const t = this.get(id, user), mgr = this.isManager(user);
      if (t.status === 'escalated') throw new AppError(409, 'הפניה כבר בתיקיית המנהל');
      if (t.status === 'in_progress' && t.assignee !== user.key && !mgr) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      await this.p.modifyLabels(t.uids, [L.esc], [...this.byLabels(), L.free, L.assigned]);
      if (note) this.pushNote(t.id, user, note, 'escalate');
      this.addLog(id, user, 'escalate', 'העביר/ה למנהל');
      return this.refresh(id, user);
    });
  }

  // ---------- הערות פנימיות ----------
  pushNote(threadId, user, text, kind = 'note') {
    text = String(text || '').trim();
    if (!text) throw new AppError(400, 'ההערה ריקה');
    if (text.length > 2000) throw new AppError(400, 'ההערה ארוכה מדי (עד 2,000 תווים)');
    this.notes.push({ id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: threadId, at: new Date().toISOString(), user: user.key, text, kind });
    this.saveStateSoon();
  }

  addNote(id, user, text) {
    return this.locked(id, async () => {
      const t = this.get(id, user);
      this.pushNote(t.id, user, text);
      return this.refresh(id, user);
    });
  }

  deleteNote(id, noteId, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user);
      const n = this.notes.find(x => x.id === noteId && t.ids.includes(x.t));
      if (!n) throw new AppError(404, 'ההערה לא נמצאה');
      if (n.user !== user.key && !this.isManager(user)) throw new AppError(403, 'אפשר למחוק רק הערה שכתבת');
      this.notes = this.notes.filter(x => x !== n);
      this.saveStateSoon();
      return this.refresh(id, user);
    });
  }

  // ---------- ניהול צוות ----------
  // מחיקת חבר צוות: הפניות הפתוחות שלו עוברות לחבר צוות אחר, או חוזרות לכללי
  async removeUser(key, actor, transferTo) {
    if (transferTo && (transferTo === key || !this.users.isActive(transferTo))) throw new AppError(400, 'חבר הצוות שאליו מעבירים לא נמצא');
    const open = [...this.threads().values()].filter(t => t.status === 'in_progress' && t.assignee === key);
    const u = this.users.remove(key, actor);
    await this.saveStateNow();
    for (const t of open) {
      await this.locked(t.id, async () => {
        if (transferTo) {
          await this.setOwner(t, transferTo);
          await this.p.modifyLabels(t.uids, [L.assigned], []);
          this.addLog(t.id, actor, 'assign', `העביר/ה לטיפול של ${this.userName(transferTo)} (${u.name} הוסר/ה מהצוות)`);
        } else {
          await this.p.modifyLabels(t.uids, [L.free], [...this.byLabels(), L.assigned]);
          this.addLog(t.id, actor, 'reopen', `חזרה לפניות הכלליות (${u.name} הוסר/ה מהצוות)`);
        }
      });
    }
    this.cache = null;
    return { moved: open.length };
  }

  // ---------- סטטיסטיקה ----------
  // "טיפל/ה" = פניה שחבר הצוות ענה בה או סימן אותה כטופלה באותו יום (כל פניה נספרת פעם אחת ביום)
  activity() {
    const per = new Map();     // key -> Map(day -> Set(threadId))
    const replies = new Map(); // key -> [{day, ms}] (ms = זמן מענה)
    const add = (key, day, tid) => {
      if (!key) return;
      if (!per.has(key)) per.set(key, new Map());
      const m = per.get(key);
      if (!m.has(day)) m.set(day, new Set());
      m.get(day).add(tid);
    };
    for (const t of this.threads().values()) {
      const msgs = [...t.raw.map(m => ({ out: this.isOut(m), author: this.isOut(m) ? m.author : null, date: m.date })),
        ...(this.pending.get(t.id) || []).map(p => ({ out: true, author: p.authorKey, date: p.date }))]
        .sort((a, b) => a.date.localeCompare(b.date));
      let waitFrom = null;
      for (const m of msgs) {
        if (!m.out) { if (!waitFrom) waitFrom = m.date; continue; }
        if (m.author) {
          const day = ilDay(m.date);
          add(m.author, day, t.id);
          if (!replies.has(m.author)) replies.set(m.author, []);
          replies.get(m.author).push({ day, ms: waitFrom ? Date.parse(m.date) - Date.parse(waitFrom) : null });
        }
        waitFrom = null;
      }
    }
    const tids = new Set(this.threads().keys());
    for (const e of [...this.oldLog, ...this.log]) {
      if (e.action !== 'handled' || !e.user) continue;
      const id = tids.has(e.t) ? e.t : this.alias && this.alias.get(String(e.t));
      if (id) add(e.user, ilDay(e.at), id);
    }
    return { per, replies };
  }

  stats({ from, to } = {}, user) {
    if (!this.isManager(user)) throw new AppError(403, 'רק למנהל');
    const today = ilDay(new Date().toISOString());
    const back = n => ilDay(new Date(Date.now() - n * 864e5).toISOString());
    to = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : today;
    from = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : back(29);
    if (from > to) [from, to] = [to, from];
    // רשימת הימים בטווח (עד שנה)
    const days = [];
    for (let d = new Date(to + 'T12:00:00Z'); days.length < 366; d = new Date(d - 864e5)) {
      const k = d.toISOString().slice(0, 10);
      if (k < from) break;
      days.unshift(k);
    }
    const { per, replies } = this.activity();
    const count = (key, a, b) => { const m = per.get(key); if (!m) return 0; const s = new Set(); for (const [d, set] of m) if (d >= a && d <= b) set.forEach(x => s.add(x)); return s.size; };
    const threads = [...this.threads().values()].map(t => [t, this.summary(t)]);
    const members = this.users.all().map(u => {
      const mine = threads.filter(([t]) => t.assignee === u.key);
      const r = (replies.get(u.key) || []).filter(x => x.day >= from && x.day <= to);
      const times = r.map(x => x.ms).filter(x => x != null && x >= 0);
      const m = per.get(u.key) || new Map();
      return {
        key: u.key, name: u.name, role: u.role || 'member', deleted: !!u.deleted,
        open: mine.filter(([t]) => t.status === 'in_progress').length,
        returned: mine.filter(([t]) => t.status === 'in_progress' && (t.returned || t.assigned)).length,
        overdue: mine.filter(([t, s]) => t.status === 'in_progress' && s.overdue).length,
        doneTotal: mine.filter(([t]) => t.status === 'handled').length,
        today: count(u.key, today, today), week: count(u.key, back(6), today), month: count(u.key, back(29), today),
        range: count(u.key, from, to),
        replies: r.length,
        avgResponseMin: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60000) : null,
        perDay: Object.fromEntries(days.map(d => [d, m.has(d) ? m.get(d).size : 0])),
      };
    }).filter(m => !m.deleted || m.range || m.open);
    const all = threads.map(([, s]) => s);
    return {
      from, to, today, days, overdueHours: config.OVERDUE_HOURS, members,
      totals: {
        general: all.filter(s => s.status === 'new').length,
        inProgress: all.filter(s => s.status === 'in_progress').length,
        escalatedOpen: all.filter(s => s.status === 'escalated' && s.mgr !== 'answered').length,
        overdue: all.filter(s => s.overdue).length,
        today: members.reduce((a, m) => a + m.today, 0),
        range: members.reduce((a, m) => a + m.range, 0),
        replies: members.reduce((a, m) => a + m.replies, 0),
        avgResponseMin: (() => {
          const all = [];
          for (const [, list] of replies) for (const x of list) if (x.day >= from && x.day <= to && x.ms != null && x.ms >= 0) all.push(x.ms);
          return all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length / 60000) : null;
        })(),
      },
    };
  }

  async attachment(attId, user) {
    const [uid, idx] = String(attId).split('-').map(Number);
    if (!this.p.messages.has(uid)) throw new AppError(404, 'הקובץ לא נמצא');
    // רק מי שרואה את הפניה יכול לפתוח את הקבצים שלה
    const t = [...this.threads().values()].find(x => x.uids.includes(uid));
    if (!t || !this.canSee(t, user)) throw new AppError(403, 'אין גישה לקובץ הזה');
    const raw = await this.p.getRaw(uid);
    const a = raw && await extractAttachment(raw, idx);
    if (!a) throw new AppError(404, 'הקובץ לא נמצא');
    return a;
  }
}

module.exports = { Engine, AppError };
