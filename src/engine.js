// לב המערכת: בונה "פניות" משרשורי המייל, מחשב סטטוס, ומבצע פעולות צוות.
// מצב כל פניה נשמר כתוויות בג׳ימייל (KOH/...), ולכן שורד הפעלה מחדש של השרת.
const config = require('./config');
const { categorize, isEnglish } = require('./categorize');
const { extractForwardedSender, attachmentList } = require('./mail/parse');
const attcache = require('./attcache');
const { splitHistory, bodyKey } = require('./mail/history');
const signature = require('./mail/signature');
const bounceInfo = require('./mail/bounce');

const L = {
  done: 'KOH/done', esc: 'KOH/escalated', ignore: 'KOH/ignore', keep: 'KOH/keep', reopen: 'KOH/reopened', followup: 'KOH/followup', track: 'KOH/track', notEnglish: 'KOH/not-english',
  free: 'KOH/free', assigned: 'KOH/assigned', outSeen: 'KOH/outbound',
  // "ראיתי" על מייל שחזר – מוריד את ההודעה מראש המסך; הפניה נשארת בטיפול עד שליחה חוזרת / "טופל"
  bounceSeen: 'KOH/bounce-seen',
  // סווג ע"י AI (ראו ai-worker.js)
  ai: 'KOH/ai', catManual: 'KOH/cat-manual',
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
    const all = [...this.p.messages.values()].filter(m => !m.system && !m.labels.has('\\Draft'));
    // מיילים חוזרים (אי-מסירה) לא משתתפים באיחוד השרשורים – הם משויכים למייל המקורי שחזר.
    // (בעבר כולם התאחדו לשרשור אחד ארוך לפי "אותו שולח + אותו נושא", או נכנסו לפניה כאילו הלקוח ענה.)
    const msgs = all.filter(m => !m.bounce);
    const groups = this.mergeGroups(msgs);
    const orphans = this.matchBounces(all.filter(m => m.bounce), groups);
    // מייל חוזר שלא נמצא למה הוא שייך – פניה נפרדת משלו (לא מתאחד עם מיילים חוזרים אחרים)
    for (const b of orphans) groups.push({ id: `b${b.uid}`, ids: [`b${b.uid}`], msgs: [b] });
    const out = [];
    this.alias = new Map();
    for (const g of groups) {
      const t = this.buildThread(g.id, g.msgs, g.ids, g.bounces || []);
      if (!t) continue;
      out.push(t);
      for (const x of g.ids) this.alias.set(x, g.id);
    }
    this.cache = new Map(out.map(t => [t.id, t]));
    for (const t of out) this.claimOutbound(t);
    return this.cache;
  }

  // מייל יזום שזה עתה הגיע מהסנכרון: הפניה נרשמת על שם השולחת (ובמעקב, אם ביקשה) – פעם אחת בלבד
  claimOutbound(t) {
    if (!t.outbound) return;
    const m = t.raw.find(x => x.uid === t.outboundUid);
    this.claiming ||= new Map();
    if (!m || m.labels.has(L.outSeen)) return;
    if (this.claiming.has(m.uid)) return this.claiming.get(m.uid);
    const hasOwner = t.raw.some(x => [...x.labels].some(l => l.startsWith('KOH/by/') || l === L.free));
    const add = [];
    if (!hasOwner && t.outboundAuthor && this.users.isActive(t.outboundAuthor)) add.push(L.by(t.outboundAuthor));
    if (t.outboundTrack && t.status === 'handled') add.push(L.track);
    const run = Promise.resolve()
      .then(() => add.length && this.p.modifyLabels(t.uids, add, []))
      .then(() => this.p.modifyLabels([m.uid], [L.outSeen], []))
      .then(() => { this.cache = null; })
      .catch(e => console.error('[compose] labels', e.message))
      .finally(() => this.claiming.delete(m.uid));
    this.claiming.set(m.uid, run);
    return run;
  }

  // שיוך כל מייל חוזר למייל היוצא שחזר: לפי ה-Message-ID המקורי שמצוטט בהודעת השגיאה,
  // ואם אין – לפי כתובת הנמען שנכשלה: המייל היוצא האחרון לכתובת הזו (עד 7 ימים לפני ההודעה החוזרת).
  // מחזיר את המיילים החוזרים שלא נמצא להם מקור.
  matchBounces(bounces, groups) {
    if (!bounces.length) return [];
    const byMid = new Map(), outs = [];
    for (const g of groups) for (const m of g.msgs) {
      if (!this.isOut(m)) continue;
      if (m.messageId) byMid.set(m.messageId, { g, m });
      outs.push({ g, m, t: Date.parse(m.date) });
    }
    const orphans = [];
    for (const b of bounces) {
      const info = b.bounce;
      let hit = null;
      for (const mid of info.mids) if ((hit = byMid.get(mid))) break;
      if (!hit) {
        const rc = info.recipients.length ? info.recipients : info.candidates;
        const bt = Date.parse(b.date);
        for (const o of outs) {
          if (o.t > bt + 5 * 60e3 || bt - o.t > 7 * 864e5 || !(o.m.to || []).some(a => rc.includes(a))) continue;
          if (!hit || o.t > hit.t) hit = o;
        }
      }
      if (hit) (hit.g.bounces ||= []).push({ msg: b, target: hit.m });
      else orphans.push(b);
    }
    return orphans;
  }

  // כתובת של הצוות (הדשבורד, help@, מעבירים, הדומיינים של הקרן)
  isTeam(a) {
    a = String(a || '').toLowerCase();
    return !!a && (a === this.me || config.FORWARDERS.includes(a) || config.IMPORT_SENDERS.includes(a)
      || config.ACCEPT_TO.includes(a) || config.TEAM_DOMAINS.some(d => a.endsWith('@' + d)));
  }

  // הודעה נכנסת מכתובת של הצוות (למשל המנהלת שמעבירה לדשבורד שרשור שהתכתבה עליו עם הצוות):
  // מפרקים את השרשור ומוצאים את הלקוח – ההודעה החדשה ביותר בשרשור מכתובת שאינה של הצוות.
  // מחזיר null אם ההודעה לא מהצוות; אחרת { customer, parts } (parts = הודעות הלקוח הרצופות, מהחדשה לישנה; customer=null אם לא נמצא)
  forwardOf(m) {
    if (m._fw !== undefined) return m._fw;
    m._fw = null;
    if (this.isOut(m) || m.outbound || !this.isTeam(m.from.address)) return null;
    const { parts } = splitHistory(m.fullText || [m.body, m.quoted].filter(Boolean).join('\n\n'));
    const i = parts.findIndex(p => p.address && !this.isTeam(p.address) && p.body);
    if (i < 0) return (m._fw = { customer: null, parts: [] });
    const addr = parts[i].address;
    const run = [];
    for (let k = i; k < parts.length && parts[k].address === addr; k++) if (parts[k].body) run.push(parts[k]);
    return (m._fw = { customer: { name: parts[i].name || addr, address: addr }, parts: run });
  }

  // מה יצוטט בתשובה ללקוח. בפניה שהועברה מהצוות – רק ההודעות של הלקוח (בלי ההתכתבות הפנימית)
  quoteOf(t) {
    const li = t.lastIn;
    if (!li) return { mode: 'none', label: '', blocks: [] };
    const fw = this.forwardOf(li);
    if (fw) {
      if (!fw.parts.length) return { mode: 'none', forwarded: true, label: 'לא זוהתה בשרשור הודעה של הפונה – התשובה תישלח בלי ציטוט', blocks: [] };
      const p = fw.parts[0], who = p.name || p.address;
      return {
        mode: 'customer', forwarded: true,
        label: (fw.parts.length > 1 ? `${fw.parts.length} ההודעות האחרונות של ${who}` : `ההודעה של ${who}`) + (p.date ? ` מ-${fmtDate(p.date)}` : ''),
        blocks: fw.parts.map(x => ({ head: (x.date ? `בתאריך ${fmtDate(x.date)}, ` : '') + `${x.name || x.address} כתב/ה:`, text: x.body })),
      };
    }
    return {
      mode: 'full', forwarded: false,
      label: `ההודעה של ${li.from.name || li.from.address} מ-${fmtDate(li.date)}` + (li.quoted ? ' (כולל ההתכתבות שמצוטטת בה)' : ''),
      blocks: [{ head: `בתאריך ${fmtDate(li.date)}, ${li.from.name || li.from.address} כתב/ה:`, text: li.body + (li.quoted ? '\n\n' + li.quoted : ''), plain: li.body }],
    };
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

  buildThread(threadId, msgs, ids = [threadId], bounces = []) {
    msgs.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid);
    const incoming = msgs.filter(m => !this.isOut(m));
    // מייל חדש שנשלח יזום מהדשבורד – פניה גם לפני שהתורם השיב
    const started = msgs.find(m => m.outbound && this.isOut(m));
    if (!incoming.length && !started) return null;
    // רק מיילים שהגיעו דרך help@ (לפי הנמען המקורי או נתיב ההעברה) – כדי שמיילים פרטיים לא ייכנסו
    const viaHelp = m => m.imported || m.to.some(a => config.ACCEPT_TO.includes(a)) || config.FORWARDERS.includes(m.from.address)
      || config.ACCEPT_TO.some(a => (m.route || '').includes(a.split('@')[1]));
    if (!started && !config.ACCEPT_ALL && config.ACCEPT_TO.length && !incoming.some(viaHelp)) return null;

    // פונה: אם הגיע Fwd ידני מכתובת מעבירה – ננסה לחלץ את השולח המקורי
    const senderOf = m => {
      const fw = this.forwardOf(m);
      if (fw && fw.customer) return fw.customer;
      if (config.FORWARDERS.includes(m.from.address) && m.fullText) {
        const orig = extractForwardedSender(m.fullText);
        if (orig && orig.address !== m.from.address && !this.isTeam(orig.address)) return orig;
      }
      return m.replyTo && m.replyTo.address && !config.FORWARDERS.includes(m.replyTo.address)
        ? { name: m.from.name || m.replyTo.name, address: m.replyTo.address } : m.from;
    };
    // בלי הודעה נכנסת (מייל יזום שעוד לא נענה): "הפונה" הוא הנמען, והתשובה הבאה ממשיכה את המייל שלנו
    const first = incoming[0] || started, lastIn = incoming[incoming.length - 1] || msgs[msgs.length - 1];
    const recipient = m => ({ name: m.toName || '', address: this.partyOf(m) || (m.to || [])[0] || '' });
    const customer = incoming.length ? senderOf(first) : recipient(started);
    const replyTarget = incoming.length ? senderOf(lastIn) : recipient(started);

    // הודעות יוצאות שעוד לא הגיעו מהסנכרון
    let pend = ids.flatMap(x => this.pending.get(x) || []);
    ids.forEach(x => { if (x !== threadId) this.pending.delete(x); });
    pend = pend.filter(p => !msgs.some(m => m.messageId === p.messageId) && Date.now() - Date.parse(p.date) < 15 * 60e3);
    pend.sort((a, b) => a.date.localeCompare(b.date));
    if (pend.length) this.pending.set(threadId, pend); else this.pending.delete(threadId);

    const labels = new Set(msgs.flatMap(m => [...m.labels]));
    const last = msgs[msgs.length - 1];
    const lastIsOut = pend.length > 0 || this.isOut(last);

    // מיילים שחזרו: לכל מייל יוצא – למי לא נמסר ולמה. כישלון סופי גובר על הודעת עיכוב.
    const deliveries = new Map();
    for (const { msg, target } of bounces) {
      const b = msg.bounce, tgtTo = (target.to || []).filter(a => a !== this.me);
      const failedTo = b.recipients.length ? b.recipients : b.candidates.filter(a => tgtTo.includes(a));
      const d = { kind: b.kind, to: failedTo.length ? failedTo : tgtTo, reason: bounceInfo.reason(b), status: b.status, diag: b.diag, at: msg.date, uid: msg.uid };
      const prev = deliveries.get(target.uid);
      if (!prev || (d.kind === 'fail' && prev.kind !== 'fail') || (d.kind === prev.kind && d.at > prev.at)) deliveries.set(target.uid, d);
    }
    // המייל האחרון שנשלח בפניה לא הגיע ליעד → הפניה חוזרת לטיפול (עד שעונים שוב או מסמנים "טופל").
    // מיילים חוזרים ישנים (מעל 30 יום) – רק מסומנים על ההודעה, בלי להחזיר את הפניה.
    const lastDel = !pend.length && this.isOut(last) ? deliveries.get(last.uid) : null;
    const bounced = lastDel && lastDel.kind === 'fail' && !last.labels.has(L.done) && Date.now() - Date.parse(lastDel.at) < 30 * 864e5 ? lastDel : null;

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
    // מייל שחזר – חוזר למי ששלחה אותו
    if (bounced && !assignee && !labels.has(L.free) && last.author && this.users.isActive(last.author)) assignee = last.author;
    const autoIgnore = config.IGNORE_SENDERS.includes(customer.address) && !labels.has(L.keep);

    let status;
    if (labels.has(L.ignore) || autoIgnore) status = 'ignored';
    else if (labels.has(L.esc)) status = 'escalated';
    else if (bounced) status = assignee ? 'in_progress' : 'new';
    else if ((lastIsOut && !last.labels.has(L.reopen)) || (!pend.length && last.labels.has(L.done))) status = 'handled';
    else if (assignee) status = 'in_progress';
    else status = 'new';

    // בתיקיית המנהל: חדשה (הלקוח כתב אחרון / עוד לא נענתה), בטיפול, או נענתה
    const mgr = status === 'escalated' ? (assignee ? 'in_progress' : lastIsOut && !bounced ? 'answered' : 'new') : null;

    const hadReply = msgs.some(m => this.isOut(m) || m.labels.has(L.done));
    // הלקוח כתב שוב אחרי שכבר ענינו – אצל המטפל/ת (בטיפול) או בכללי (אם אין מטפל/ת)
    const returned = (status === 'new' || status === 'in_progress') && hadReply && !lastIsOut;
    // ממתינה לנו: ההודעה האחרונה היא של הלקוח
    const waiting = !lastIsOut && (status === 'new' || status === 'in_progress' || (status === 'escalated' && mgr === 'new'));
    const assigned = status === 'in_progress' && labels.has(L.assigned);
    // טופלה – במעקב: הנציגה סימנה שמחכים ללקוח (למשל ביקשנו קובץ). בלי סימון = טופלה – הושלם.
    const tracking = status === 'handled' && labels.has(L.track);
    // הלקוח חזר על פניה שהייתה במעקב
    const fromTracking = returned && labels.has(L.track);
    // "תגובה נוספת" לפניה שהייתה במעקב (הלקוח עוד לא חזר) – בתשובה מוצע להשאיר במעקב
    const trackDefault = status === 'in_progress' && labels.has(L.track) && !returned;

    const manualCats = [...labels].filter(l => l.startsWith('KOH/cat/')).map(l => l.slice(8)).filter(k => this.catKeys.has(k));
    // הודעות מערכת (Synchroline, MailAdmin, Charidy Support…) – ישר לקטגוריה "הודעות מערכת"
    const fromSystem = isSystemSender(customer) || isSystemSender(first.from);
    // KOH/ai בלי קטגוריה = ה-AI סיווג "כללי". בלי סימון (AI כבוי / עוד לא סווג / נכשל) – לפי מילות מפתח.
    let categories = manualCats.length ? manualCats
      : fromSystem || first.bounce ? ['system']
      : labels.has(L.ai) ? ['general']
      : categorize(first.subject + ' ' + incoming.map(m => m.body).join(' '));
    // "אנגלית" – מזוהה אוטומטית גם כשיש קטגוריות ידניות (אלא אם מישהו הוריד אותה ידנית)
    if (!categories.includes('english') && !categories.includes('system') && !labels.has(L.notEnglish) && isEnglish(incoming.map(m => m.body))) {
      categories = [...categories.filter(k => k !== 'general'), 'english'];
    }

    // הודעה שחבר/ת צוות העבירו לדשבורד (לא דרך help@) – הבועה מציגה את מי שהעביר/ה, לא את הלקוח
    const teamFwd = m => !!this.forwardOf(m) && !config.FORWARDERS.includes(m.from.address);
    const view = m => ({
      id: m.uid, direction: this.isOut(m) ? 'out' : 'in',
      name: this.isOut(m) ? config.FROM_NAME : teamFwd(m) ? (m.from.name || m.from.address) : senderOf(m).name || senderOf(m).address,
      email: this.isOut(m) ? null : teamFwd(m) ? m.from.address : senderOf(m).address,
      forwarded: teamFwd(m) || undefined,
      author: this.isOut(m) ? (m.author ? this.userName(m.author) : null) : null,
      authorKey: this.isOut(m) ? m.author || null : null,
      to: this.isOut(m) ? ((m.to || []).filter(a => a !== this.me).join(', ') || null) : null,
      date: m.date, body: m.body, quoted: m.quoted,
      attachments: m.attachments.map(a => ({ id: `${m.uid}-${a.index}`, name: a.name, type: a.type, size: a.size, inline: a.inline })),
      // מייל יוצא שחזר: למי לא נמסר ולמה
      delivery: deliveries.has(m.uid) ? (({ uid, ...d }) => d)(deliveries.get(m.uid)) : null,
      // מייל חוזר שלא נמצא למה הוא שייך (פניה נפרדת)
      bounce: m.bounce ? { kind: m.bounce.kind, reason: bounceInfo.reason(m.bounce), to: m.bounce.recipients.concat(m.bounce.candidates).slice(0, 3) } : null,
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
      outbound: !!started, outboundUid: started ? started.uid : null, outboundAuthor: started ? started.author : null, outboundTrack: started ? started.outbound === 'track' : false,
      status, mgr, assignee, returned, waiting, assigned, tracking, fromTracking, trackDefault, categories,
      bounced: bounced ? { to: bounced.to, reason: bounced.reason, at: bounced.at, seen: last.labels.has(L.bounceSeen) } : null,
      bounceOrphan: !!(first.bounce && !incoming.some(m => !m.bounce)),
      hadBounce: bounces.length > 0,
      // מייל שחזר – הפניה עולה לראש הרשימה לפי זמן החזרה
      lastIncoming: bounced && bounced.at > lastIn.date ? bounced.at : lastIn.date,
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
    const own = a => this.isTeam(a);
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
      outbound: t.outbound, returned: t.returned, bounced: t.bounced, bounceOrphan: t.bounceOrphan, assigned: t.assigned, tracking: t.tracking, fromTracking: t.fromTracking, waiting: t.waiting, overdue, categories: t.categories,
      lastIncoming: t.lastIncoming, lastActivity: t.lastActivity,
      messageCount: t.messages.length,
      hasAttachments: t.messages.some(m => m.attachments.length),
      snippet: (t.lastIn.body || '').replace(/\s+/g, ' ').slice(0, 150),
    };
  }

  // הקפצות מהמנהל: הודעות שהמנהל הקפיץ למזכירה. "פתוחה" = עוד לא אישרה שקראה.
  pushesOf(t) { return this.notes.filter(n => n.kind === 'push' && t.ids.includes(n.t)); }
  openPushes(t, key) { return this.pushesOf(t).filter(n => n.to === key && !n.seenAt); }
  // סיכום לפי מי שמסתכל: הקפצה פתוחה אליו/ה; למנהל – למי הוקפץ ועוד לא נקרא
  summaryFor(t, user, who = user.key) {
    const s = this.summary(t);
    const open = this.openPushes(t, who);
    if (open.length) {
      const last = open[open.length - 1];
      s.push = { count: open.length, at: last.at, from: this.userName(last.user), fromKey: last.user, text: (last.text || '').replace(/\s+/g, ' ').slice(0, 140) };
    }
    if (this.isManager(user)) {
      const waiting = this.pushesOf(t).filter(n => !n.seenAt);
      if (waiting.length) s.pushedTo = [...new Set(waiting.map(n => n.to))].map(k => ({ key: k, name: this.userName(k) }));
    }
    return s;
  }

  // הערות פנימיות: כל מי שפותח/ת את הפניה רואה את כל ההערות. מחיקה – רק הכותב/ת או המנהל.
  notesFor(t, user) {
    const mgr = this.isManager(user);
    return this.notes.filter(n => t.ids.includes(n.t))
      .filter(n => this.noteVisible(n, t, user))
      .map(n => ({ id: n.id, at: n.at, user: this.userName(n.user), userKey: n.user, text: n.text, kind: n.kind || 'note', canDelete: mgr || n.user === user.key, files: this.noteFiles(n),
        ...(n.kind === 'push' ? { to: n.to, toName: this.userName(n.to), seenAt: n.seenAt || null, canAck: n.to === user.key && !n.seenAt } : {}) }));
  }

  detail(t, user) {
    return {
      ...this.summaryFor(t, user),
      messages: t.messages,
      replyTo: t.replyTarget.address,
      replyToTeam: this.isTeam(t.replyTarget.address),
      quote: (({ mode, forwarded, label, blocks }) => ({
        mode, forwarded, label, preview: blocks.map(b => b.head + '\n' + b.text).join('\n\n').slice(0, 4000),
      }))(this.quoteOf(t)),
      trackDefault: t.trackDefault,
      readOnly: !this.canEdit(t, user),
      events: [...this.oldLog, ...this.log].filter(e => t.ids.includes(e.t)).map(e => ({ at: e.at, user: e.user ? this.userName(e.user) : null, userKey: e.user, action: e.action, text: e.text })),
      notes: this.notesFor(t, user),
    };
  }

  // ---------- הרשאות צפייה ----------
  // מנהל: הכול. חבר צוות: פניות כלליות (חדשות בלי מטפל/ת) + הפניות שלו (בטיפול / טופלו על ידו).
  // בנוסף: כל הפניות שטופלו ושבטיפול (של כל הצוות) – לצפייה וחיפוש בלבד (canEdit).
  canSee(t, user) {
    if (this.isManager(user)) return true;
    return t.status === 'new' || t.status === 'handled' || t.status === 'in_progress';
  }

  // פניה שטופלה / בטיפול של מישהי אחרת – חבר/ת צוות רק צופה בה (לא לוקחת, לא עונה, לא משנה)
  canEdit(t, user) {
    if (this.isManager(user)) return true;
    return !((t.status === 'handled' || t.status === 'in_progress') && t.assignee !== user.key);
  }

  inRange(iso, from, to) {
    const d = ilDay(iso);
    return (!from || d >= from) && (!to || d <= to);
  }

  // view: all (הכל – כל מה שמותר לראות, לחיפוש כללי) | open (כללי) | mine | member (מנהל) | handled (טופלו – הושלם) | tracking (טופלו – במעקב) | escalated | ignored | overdue
  // sub (ל-mine/member): open | returned | overdue | tracking | done
  // done=1 ("טופלו" בסרגל הקטגוריות): כל הפניות שטופלו – בפניות הכלליות של כל הצוות, ב"הפניות שלי" רק שלי
  list({ view = 'open', sub = 'open', member, category, q, from, to, done }, user) {
    const mgr = this.isManager(user);
    if (['handled', 'tracking', 'escalated', 'ignored', 'overdue', 'bounced', 'member'].includes(view) && !mgr) throw new AppError(403, 'רק למנהל');
    const who = view === 'member' ? member : user.key;
    const all = [...this.threads().values()];
    // מנהל → מזכירה: הפניות שטיפלה בהן (ענתה / סימנה כטופל) בטווח – בדיוק אותה ספירה כמו בטבלת ניהול מענה
    if (view === 'member' && sub === 'worked') return this.workedList(who, { from, to, q }, user);
    const personal = t => t.assignee === who;
    // הקפצה פתוחה מהמנהל – הפניה בפתוחות שלה (גם אם כבר טופלה), עד שתאשר שקראה
    const pushed = t => this.openPushes(t, who).length > 0;
    const subF = {
      open: t => (t.status === 'in_progress' && personal(t)) || pushed(t),
      returned: t => t.status === 'in_progress' && personal(t) && (t.returned || t.assigned || !!t.bounced),
      overdue: t => t.status === 'in_progress' && personal(t) && this.summary(t).overdue,
      // מיילים שלא הגיעו ליעד ועוד לא סומן עליהם "ראיתי" (אותה ספירה כמו בהודעה בראש המסך)
      bounced: t => t.status === 'in_progress' && personal(t) && !!t.bounced && !t.bounced.seen,
      tracking: t => t.tracking && personal(t),
      done: t => t.status === 'handled' && !t.tracking && personal(t) && this.inRange(t.lastActivity, from, to),
    };
    const f = {
      all: t => this.canSee(t, user),
      open: mgr ? (t => t.status === 'new' || t.status === 'in_progress') : (t => t.status === 'new' || pushed(t)),
      mine: subF[sub] || subF.open,
      member: subF[sub] || subF.open,
      handled: t => t.status === 'handled' && !t.tracking && this.inRange(t.lastActivity, from, to),
      tracking: t => t.tracking,
      escalated: t => t.status === 'escalated',
      ignored: t => t.status === 'ignored',
      overdue: t => this.summary(t).overdue,
      bounced: t => !!t.bounced && !t.bounced.seen,
    }[view] || (t => t.status === 'new');
    const doneMode = done === '1' && (view === 'open' || view === 'mine');
    let items = doneMode
      ? all.filter(t => t.status === 'handled' && (view === 'open' || personal(t)) && this.inRange(t.lastActivity, from, to))
      : all.filter(f);

    // מונים לפי קטגוריה – על התצוגה הנוכחית (לפני סינון קטגוריה/חיפוש)
    const byCategory = {};
    for (const t of items) for (const k of t.categories) byCategory[k] = (byCategory[k] || 0) + 1;
    // מונים ללשוניות המשנה של "הפניות שלי"
    let subCounts = null;
    if (!doneMode && (view === 'mine' || view === 'member')) {
      subCounts = {};
      for (const k of Object.keys(subF)) subCounts[k] = k === 'done' ? all.filter(t => t.status === 'handled' && !t.tracking && personal(t)).length : all.filter(subF[k]).length;
    }

    if (category) items = items.filter(t => t.categories.includes(category));
    if (q) {
      const s = q.trim().toLowerCase();
      items = items.filter(t => [t.subject, t.fromName, t.fromEmail, t.assignee ? this.userName(t.assignee) : "",
        ...t.messages.flatMap(m => [m.body, m.from && m.from.address, ...(m.attachments || []).map(a => a.name)]),
        ...this.notesFor(t, user).map(n => n.text)].some(x => (x || '').toLowerCase().includes(s)));
    }
    const key = (view === 'all' || doneMode || sub === 'done' || sub === 'tracking' || view === 'handled' || view === 'tracking') ? 'lastActivity' : 'lastIncoming';
    // הודעות שהמנהל הקפיץ – בראש הרשימה (האחרונה ראשונה), אחריהן הסדר הרגיל
    const pushAt = t => { const o = this.openPushes(t, who); return o.length ? o[o.length - 1].at : ''; };
    items.sort((a, b) => pushAt(b).localeCompare(pushAt(a)) || b[key].localeCompare(a[key]));
    return { items: items.map(t => this.summaryFor(t, user, who)), byCategory, subCounts };
  }

  counts(user) {
    const mgr = this.isManager(user), me = user.key, today = ilDay(new Date().toISOString());
    const c = { all: 0, general: 0, open: 0, new: 0, in_progress: 0, mine: 0, mineReturned: 0, mineBounced: 0, bounced: 0, mineOverdue: 0, mineDone: 0, mineDoneToday: 0, mineTracking: 0, handledAll: 0,
      handled: 0, tracking: 0, escalated: 0, escalatedOpen: 0, ignored: 0, overdue: 0, pushed: 0 };
    for (const t of this.threads().values()) {
      const s = this.summary(t);
      if (this.canSee(t, user)) c.all++;
      if (t.status === 'new') c.general++;
      const pushed = this.openPushes(t, me).length > 0;
      if (pushed) c.pushed++;
      if (pushed && t.status !== 'in_progress') c.mine++;
      if (t.status === 'in_progress' && t.assignee === me) {
        c.mine++;
        if (t.returned || t.assigned || (t.bounced && !t.bounced.seen)) c.mineReturned++;
        if (t.bounced && !t.bounced.seen) c.mineBounced++;
        if (s.overdue) c.mineOverdue++;
      }
      if (t.status === 'handled') c.handledAll++;
      if (t.status === 'handled' && t.assignee === me) {
        if (t.tracking) c.mineTracking++;
        else c.mineDone++;
        if (ilDay(t.lastActivity) === today) c.mineDoneToday++;
      }
      if (!mgr) continue;
      if (t.tracking) c.tracking++; else c[t.status]++;
      if (t.status === 'new' || t.status === 'in_progress') c.open++;
      if (t.status === 'escalated' && t.mgr !== 'answered') c.escalatedOpen++;
      if (s.overdue) c.overdue++;
      if (t.bounced && !t.bounced.seen) c.bounced++;
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

  getEdit(id, user) {
    const t = this.get(id, user);
    if (!this.canEdit(t, user)) throw new AppError(403, t.assignee
      ? `הפניה ${t.status === 'in_progress' ? 'בטיפול של' : 'טופלה על ידי'} ${this.userName(t.assignee)} – אפשר רק לצפות בה`
      : 'הפניה טופלה – אפשר רק לצפות בה');
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
      const t = this.getEdit(id, user), mgr = this.isManager(user);
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
      const t = this.getEdit(id, user), mgr = this.isManager(user);
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

  // track = true → "טופלה – במעקב" (מחכים ללקוח); אחרת "טופלה – הושלם"
  markHandled(id, user, track = false) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user), mgr = this.isManager(user);
      if (t.status === 'in_progress' && t.assignee !== user.key && !mgr) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      await this.p.modifyLabels([t.lastUid], [L.done], [L.reopen, L.followup]);
      await this.p.modifyLabels(t.uids, track ? [L.track] : [], track ? [] : [L.track]);
      // נשארת של מי שטיפל בה (כדי שתגובה חוזרת תגיע אליו). בתיקיית המנהל / בלי מטפל – של מי שסימן.
      await this.setOwner(t, t.status === 'escalated' || !t.assignee ? user.key : t.assignee);
      await this.p.modifyLabels(t.uids, [], [L.esc, L.assigned]);
      this.ackPushes(t, user);
      const what = (track ? 'סימן/ה כטופל – במעקב' : 'סימן/ה כטופל – הושלם') + (t.bounced ? ' (אחרי שהמייל האחרון לא הגיע ליעד)' : '');
      this.addLog(id, user, 'handled', t.status === 'escalated' ? `${what} (הוסרה מתיקיית המנהל)` : what);
      return this.refresh(id, user);
    });
  }

  // ---------- תיקון חד-פעמי: בעלות שגויה מאיחוד ההודעות החוזרות (לפני 16.11) ----------
  // עד התיקון, כל ההודעות החוזרות התאחדו לפניה אחת, וגררו איתן (דרך השרשור של Gmail) את המיילים המקוריים שחזרו.
  // מי שלקח/סימן את הפניה הזו קיבל/ה תווית KOH/by על כל המיילים, ותוויות הבעלים הקודמות נמחקו.
  // כאן מאתרים פניות שחזר בהן מייל, שרשומות על מי שלא שלח/ה את המייל האחרון ולא פעל/ה בפניה מאז
  // (לא לקח/ה, לא סימן/ה, לא הועברה אליו/ה) – ומסירים את תווית הבעלים.
  // הבעלות חוזרת אוטומטית למי ששלח/ה את המייל האחרון (גם כשכמה מזכירות ענו בפניה).
  ownerFixCandidates() {
    const out = [];
    for (const t of this.threads().values()) {
      if (!t.hadBounce) continue;
      const labels = new Set(t.raw.flatMap(m => [...m.labels]));
      if (labels.has(L.assigned)) continue;
      const owners = this.allKeys().filter(k => labels.has(L.by(k)));
      if (!owners.length) continue;
      const outs = t.raw.filter(m => this.isOut(m) && m.author);
      if (!outs.length) continue;
      const authors = outs.map(m => m.author), lastAuthor = authors[authors.length - 1];
      // מאז המייל האחרון שנשלח: מי לקח/ה, קיבל/ה העברה או פעל/ה בפניה (פעולה כזו = בעלות אמיתית)
      const since = Date.parse(outs[outs.length - 1].date) - 60e3;
      const ids = new Set(t.ids);
      const recent = [...this.oldLog, ...this.log].filter(e => ids.has(e.t) && Date.parse(e.at) >= since);
      const handedOver = recent.some(e => e.action === 'assign' || e.action === 'push');
      // תווית שגויה: לא של מי ששלח/ה את המייל האחרון, ואין לה שום פעולה מאז המייל הזה
      const wrong = owners.filter(k => k !== lastAuthor && !handedOver && !recent.some(e => e.user === k));
      if (!wrong.length || wrong.length !== owners.length) continue;
      const to = [...authors].reverse().find(k => this.users.isActive(k)) || null;
      out.push({ id: t.id, subject: t.subject, customer: t.fromEmail, status: t.status, from: owners.map(k => this.userName(k)).join(', '), to: to ? this.userName(to) : '(כללי – אין שולח/ת פעיל/ה)', lastSent: t.raw.filter(m => this.isOut(m)).pop().date });
    }
    return out.sort((a, b) => b.lastSent.localeCompare(a.lastSent));
  }

  async applyOwnerFix(user) {
    const list = this.ownerFixCandidates();
    for (const c of list) {
      await this.locked(c.id, async () => {
        const t = this.get(c.id);
        await this.p.modifyLabels(t.uids, [], this.byLabels());
        this.addLog(c.id, user, 'owner-fix', `תיקון שיוך: הפניה הייתה רשומה בטעות על ${c.from} (איחוד הודעות חוזרות לפני 16.11) – חזרה ל${c.to}`);
      });
    }
    this.cache = null;
    await this.saveStateNow();
    return { fixed: list.length, items: list };
  }

  // "ראיתי" על מייל שחזר: ההודעה יורדת מראש המסך (גם אצל המנהל), הפניה נשארת בטיפול
  markBounceSeen(id, user) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user);
      if (!t.bounced || t.bounced.seen) return this.refresh(id, user);
      if (t.assignee && t.assignee !== user.key && !this.isManager(user)) throw new AppError(403, `הפניה של ${this.userName(t.assignee)}`);
      await this.p.modifyLabels([t.lastUid], [L.bounceSeen], []);
      this.addLog(id, user, 'bounce-seen', 'ראה/תה שהמייל האחרון לא הגיע ליעד');
      return this.refresh(id, user);
    });
  }

  // פניה שכבר טופלה: מעבר בין "הושלם" ל"במעקב" בלי לשלוח כלום
  setTracking(id, user, on) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user), mgr = this.isManager(user);
      if (t.status !== 'handled') throw new AppError(400, 'אפשר לסמן מעקב רק לפניה שטופלה');
      if (t.assignee && t.assignee !== user.key && !mgr) throw new AppError(403, `הפניה של ${this.userName(t.assignee)}`);
      if (!!t.tracking === !!on) return this.refresh(id, user);
      await this.p.modifyLabels(t.uids, on ? [L.track] : [], on ? [] : [L.track]);
      this.addLog(id, user, 'tracking', on ? 'העביר/ה ל"טופלו – במעקב"' : 'סימן/ה "טופלו – הושלם" (הוסר מהמעקב)');
      return this.refresh(id, user);
    });
  }

  // מנהל: מחזיר לפניות הכלליות (מתיקיית המנהל, מטופלות, מוסתרות או מחבר צוות)
  reopen(id, user) {
    return this.locked(id, async () => {
      if (!this.isManager(user)) throw new AppError(403, 'רק המנהל יכול להחזיר פניה לכללי');
      const t = this.getEdit(id, user);
      await this.p.modifyLabels(t.uids, [L.free], [L.done, L.esc, L.ignore, L.followup, L.track, L.assigned, ...this.byLabels()]);
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
      const t = this.getEdit(id, user);
      if (t.assignee === toKey && t.status === 'in_progress') throw new AppError(409, `הפניה כבר אצל ${this.userName(toKey)}`);
      await this.moveTo(t, user, toKey);
      this.addLog(id, user, 'assign', `העביר/ה לטיפול של ${this.userName(toKey)}`);
      return this.refresh(id, user);
    });
  }

  // העברת פניה לחבר צוות (בלי נעילה – נקרא מתוך פעולה נעולה)
  async moveTo(t, user, toKey) {
    await this.setOwner(t, toKey);
    await this.p.modifyLabels(t.uids, toKey === user.key ? [] : [L.assigned], [L.esc, L.ignore, L.done, L.followup, L.track]);
    // פניה שכבר נענתה – נפתחת מחדש אצל מי שקיבל/ה אותה
    if (t.raw.length && this.isOut(t.raw[t.raw.length - 1])) await this.p.modifyLabels([t.lastUid], [L.reopen, L.keep]);
    else await this.p.modifyLabels([t.lastUid], [L.keep]);
  }

  ignore(id, user) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user), mgr = this.isManager(user);
      if (!mgr && t.status !== 'new' && t.assignee !== user.key) throw new AppError(403, 'אין הרשאה');
      await this.p.modifyLabels(t.uids, [L.ignore], [L.keep, L.assigned, ...this.byLabels()]);
      this.addLog(id, user, 'ignore', 'סימן/ה "לא פניה" – הוסתר');
      return this.refresh(id, user);
    });
  }

  setCategories(id, cats, user) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user);
      cats = cats.filter(k => this.catKeys.has(k));
      if (!cats.length) cats = ['general'];
      const all = config.CATEGORIES.map(c => L.cat(c.key));
      await this.p.modifyLabels(t.uids, [], all.filter(l => !cats.map(L.cat).includes(l)));
      // KOH/cat-manual: הצוות קבע – סיווג ה-AI לא נוגע יותר בפניה (גם לא בסיווג חוזר)
      await this.p.modifyLabels(t.uids, [...cats.map(L.cat), L.catManual], []);
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
  // track = true → אחרי השליחה הפניה ב"טופלו – במעקב"; אחרת "טופלו – הושלם" (ברירת מחדל)
  reply(id, user, body, files, toAddress, track = false, withQuote = null) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user);
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
      const q = this.quoteOf(t);
      // פניה שהועברה מהצוות: הנושא בלי "FW:"/"RE:" המצטברים של ההתכתבות הפנימית
      const subject = q.forwarded ? 'Re: ' + baseSubject(li.subject) : /^re\s*:/i.test(li.subject) ? li.subject : 'Re: ' + baseSubject(li.subject);
      // ברירת המחדל: בלי ציטוט. מצרפים רק כשביקשו (withQuote=true). בפניה שהועברה מהצוות – רק ההודעות של הלקוח
      const noQuote = withQuote !== true;
      const blocks = noQuote ? [] : q.blocks;
      const qStyle = 'font-family:Arial,sans-serif;font-size:13px;color:#555;text-align:right';
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;text-align:right">${esc(body).replace(/\n/g, '<br>')}</div>${signature.html()}`
        + blocks.map(b => `
<br><div dir="rtl" style="${qStyle}">${esc(b.head)}</div>
<blockquote dir="rtl" style="margin:0 8px 0 0;padding:0 10px 0 0;border-right:2px solid #ccc;${qStyle}">${esc(b.text).replace(/\n/g, '<br>')}</blockquote>`).join('');
      const text = body + blocks.map(b => `\n\n${b.head}\n${(b.plain ?? b.text ?? '').split('\n').map(l => '> ' + l).join('\n')}`).join('');
      const references = [...(li.references || []), li.messageId].filter(Boolean);

      const messageId = await this.p.send({
        to,
        subject, text, html,
        inReplyTo: li.messageId || undefined,
        references: references.length ? references : undefined,
        headers: { 'X-KOH-Author': user.key },
        attachments: [...files.map(f => ({ filename: f.name, content: f.buffer, contentType: f.type })), ...signature.attachment()],
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
      const tr = track && t.status !== 'escalated';
      await this.p.modifyLabels(t.uids, tr ? [L.track] : [], [L.reopen, L.followup, L.assigned, ...(tr ? [] : [L.track])]).catch(e => console.error('[reply] labels', e.message));
      this.ackPushes(t, user);
      this.addLog(id, user, 'reply', (same ? `השיב/ה ל-${toText}` : `השיב/ה ל-${toText} (נמענים שונים מברירת המחדל – הפונה ${t.replyTarget.address})`) + (noQuote ? ' · בלי ציטוט' : q.forwarded && blocks.length ? ' · ציטוט: רק הודעת הפונה' : '') + (tr ? ' · טופלו – במעקב' : ''));
      return this.refresh(id, user);
    });
  }

  // מייל חדש לתורם, יזום מהדשבורד (למשל אחרי שיחת טלפון). נוצרת פניה על שם השולחת:
  // "טופלו – הושלם", או "טופלו – במעקב" (track). כשהתורם משיב – הפניה חוזרת אליה כרגיל.
  async compose(user, { to, name, subject, body, files = [], track = false }) {
    const seen = new Set();
    const list = String(to || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
      .filter(a => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
    if (!list.length) throw new AppError(400, 'צריך להזין כתובת מייל של הנמען');
    const bad = list.find(a => !EMAIL_RE.test(a));
    if (bad) throw new AppError(400, `כתובת המייל לא תקינה: ${bad}`);
    if (list.length > 10) throw new AppError(400, 'אפשר לשלוח לעד 10 נמענים במייל אחד');
    if (list.some(a => a.toLowerCase() === this.me)) throw new AppError(400, 'אי אפשר לשלוח מייל לתיבה של הדשבורד עצמה');
    subject = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
    body = String(body || '').trim();
    if (!subject) throw new AppError(400, 'צריך לכתוב נושא למייל');
    if (!body) throw new AppError(400, 'אי אפשר לשלוח מייל ריק');
    if (subject.length > 200) throw new AppError(400, 'הנושא ארוך מדי');
    name = String(name || '').replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 100);
    const toList = list.map((a, i) => ({ name: i === 0 ? name : '', address: a }));
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;text-align:right">${esc(body).replace(/\n/g, '<br>')}</div>${signature.html()}`;

    const messageId = await this.p.send({
      to: toList, subject, text: body, html,
      headers: { 'X-KOH-Author': user.key, 'X-KOH-Outbound': track ? 'track' : 'done' },
      attachments: [...files.map(f => ({ filename: f.name, content: f.buffer, contentType: f.type })), ...signature.attachment()],
    });
    const toText = list.join(', ');

    // מחכים שהמייל יופיע בתיבה (כמה שניות), כדי לפתוח את הפניה החדשה
    let t = null;
    for (let i = 0; i < 24 && !t; i++) {
      this.cache = null;
      t = [...this.threads().values()].find(x => x.raw.some(m => m.messageId === messageId));
      if (!t) await new Promise(r => setTimeout(r, 500));
    }
    this.addLog(t ? t.id : null, user, 'compose', `שלח/ה מייל חדש ל-${toText}` + (track ? ' · טופלו – במעקב' : ''));
    if (!t) return { sent: true, id: null };
    await this.claimOutbound(t);
    this.cache = null;
    return { sent: true, ...this.refresh(t.id, user) };
  }

  // העברה למנהל: רק תיוג. הפניה עוברת לתיקיית "הועבר למנהל" (רק המנהל רואה אותה). ההערה נשמרת כהערה פנימית.
  // files – מסמכים למנהל: נשמרים בתיבה (KOH-System) ומוצגים בהערה של ההעברה
  escalate(id, user, note, files = []) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user), mgr = this.isManager(user);
      if (t.status === 'escalated') throw new AppError(409, 'הפניה כבר בתיקיית המנהל');
      if (t.status === 'in_progress' && t.assignee !== user.key && !mgr) throw new AppError(409, `הפניה בטיפול של ${this.userName(t.assignee)}`);
      let n = null;
      if (note || files.length) {
        n = this.makeNote(t.id, user, note || '', 'escalate', !!files.length);
        if (files.length) {
          // קודם שומרים את הקבצים – אם זה נכשל, הפניה לא מועברת (ולא הולכים לאיבוד מסמכים)
          try { await this.p.saveFiles(n.id, t.id, files); }
          catch (e) { throw new AppError(502, `שמירת המסמכים נכשלה, הפניה לא הועברה: ${e.message}`); }
          n.files = files.map(f => ({ name: f.name, type: f.type, size: f.size }));
        }
      }
      await this.p.modifyLabels(t.uids, [L.esc], [...this.byLabels(), L.free, L.assigned]);
      if (n) { this.notes.push(n); this.saveStateSoon(); }
      this.addLog(id, user, 'escalate', 'העביר/ה למנהל' + (files.length ? ` (צורפו ${files.length === 1 ? 'מסמך אחד' : files.length + ' מסמכים'})` : ''));
      return this.refresh(id, user);
    });
  }

  // ---------- הערות פנימיות ----------
  makeNote(threadId, user, text, kind = 'note', allowEmpty = false) {
    text = String(text || '').trim();
    if (!text && !allowEmpty) throw new AppError(400, 'ההערה ריקה');
    if (text.length > 2000) throw new AppError(400, 'ההערה ארוכה מדי (עד 2,000 תווים)');
    return { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: threadId, at: new Date().toISOString(), user: user.key, text, kind };
  }

  pushNote(threadId, user, text, kind = 'note') {
    this.notes.push(this.makeNote(threadId, user, text, kind));
    this.saveStateSoon();
  }

  // קבצים של הערה: מההודעה ששמורה בתיבה (עד שהסנכרון מביא אותה – רק השמות, בלי קישור)
  noteFiles(n) {
    if (!n.files) return [];
    const rec = [...this.p.messages.values()].find(m => m.system === 'files' && m.note === n.id);
    return rec ? rec.attachments.map(a => ({ id: `${rec.uid}-${a.index}`, name: a.name, type: a.type, size: a.size, inline: false }))
      : n.files.map(f => ({ id: null, ...f }));
  }

  // כל מי שרואה את הפניה רואה את כל ההערות שבה (הגישה לפניה עצמה נבדקת ב-canSee)
  noteVisible(n, t, user) {
    return this.canSee(t, user);
  }

  addNote(id, user, text) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user);
      this.pushNote(t.id, user, text);
      return this.refresh(id, user);
    });
  }

  deleteNote(id, noteId, user) {
    return this.locked(id, async () => {
      const t = this.getEdit(id, user);
      const n = this.notes.find(x => x.id === noteId && t.ids.includes(x.t));
      if (!n) throw new AppError(404, 'ההערה לא נמצאה');
      if (n.user !== user.key && !this.isManager(user)) throw new AppError(403, 'אפשר למחוק רק הערה שכתבת');
      this.notes = this.notes.filter(x => x !== n);
      this.saveStateSoon();
      return this.refresh(id, user);
    });
  }

  // ---------- הקפצת הודעה מהמנהל למזכירה ----------
  // ההודעה מופיעה אצלה בראש הפתוחות עם מסגרת בולטת, עד שהיא מאשרת שקראה (או עונה / מסמנת כטופל).
  // אם הפניה לא אצלה (אצל המנהל, חדשה, אצל מישהי אחרת) – היא עוברת אליה.
  pushToMember(id, user, toKey, text) {
    return this.locked(id, async () => {
      if (!this.isManager(user)) throw new AppError(403, 'רק המנהל יכול להקפיץ הודעה');
      if (!toKey || !this.users.isActive(toKey)) throw new AppError(400, 'בחרו למי להקפיץ את ההודעה');
      if (toKey === user.key) throw new AppError(400, 'אי אפשר להקפיץ הודעה לעצמך');
      const t = this.getEdit(id, user);
      const n = this.makeNote(t.id, user, text, 'push', true);
      n.to = toKey;
      const hers = t.assignee === toKey && ['in_progress', 'handled'].includes(t.status);
      if (!hers) await this.moveTo(t, user, toKey);
      this.notes.push(n);
      await this.saveStateNow();
      this.addLog(id, user, 'push', `הקפיץ/ה הודעה אל ${this.userName(toKey)}` + (hers ? '' : ' (הפניה עברה אליה)'));
      return this.refresh(id, user);
    });
  }

  ackPushes(t, user) {
    const open = this.openPushes(t, user.key);
    if (!open.length) return 0;
    const at = new Date().toISOString();
    for (const n of open) n.seenAt = at;
    this.saveStateSoon();
    return open.length;
  }

  ackPush(id, user) {
    return this.locked(id, async () => {
      const t = this.get(id, user);
      if (this.ackPushes(t, user)) this.addLog(id, user, 'push-seen', 'אישר/ה שקרא/ה את ההודעה מהמנהל');
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
    const acts = new Map();    // key -> Map(threadId -> [{at, day, kind: reply|handled}])
    const add = (key, day, tid, at, kind) => {
      if (!key) return;
      if (!acts.has(key)) acts.set(key, new Map());
      const a = acts.get(key);
      if (!a.has(tid)) a.set(tid, []);
      a.get(tid).push({ at, day, kind });
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
          add(m.author, day, t.id, m.date, 'reply');
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
      if (id) add(e.user, ilDay(e.at), id, e.at, 'handled');
    }
    return { per, replies, acts };
  }

  // הפניות שחבר צוות טיפל בהן בטווח + מונים לסרגל הצד (היום / אתמול / 7 / 30 / החודש / כרגע אצלו)
  workedList(key, { from, to, q }, user) {
    const today = ilDay(new Date().toISOString());
    const back = n => ilDay(new Date(Date.now() - n * 864e5).toISOString());
    const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    to = ok(to) ? to : today; from = ok(from) ? from : today;
    if (from > to) [from, to] = [to, from];
    const acts = this.activity().acts.get(key) || new Map();
    const threads = this.threads();
    const countIn = (a, b) => { let n = 0; for (const list of acts.values()) if (list.some(x => x.day >= a && x.day <= b)) n++; return n; };
    let items = [];
    for (const [tid, list] of acts) {
      const t = threads.get(tid); if (!t) continue;
      const inR = list.filter(x => x.day >= from && x.day <= to);
      if (!inR.length) continue;
      const last = inR.reduce((a, x) => x.at > a ? x.at : a, '');
      items.push({ t, worked: { replies: inR.filter(x => x.kind === 'reply').length, handled: inR.some(x => x.kind === 'handled'), last } });
    }
    if (q) {
      const s = q.trim().toLowerCase();
      items = items.filter(({ t }) => [t.subject, t.fromName, t.fromEmail,
        ...t.messages.flatMap(m => [m.body, m.from && m.from.address, ...(m.attachments || []).map(a => a.name)]),
        ...this.notesFor(t, user).map(n => n.text)].some(x => (x || '').toLowerCase().includes(s)));
    }
    items.sort((a, b) => b.worked.last.localeCompare(a.worked.last));
    const mine = [...threads.values()].filter(t => t.assignee === key);
    const workedCounts = {
      today: countIn(today, today), yesterday: countIn(back(1), back(1)), week: countIn(back(6), today),
      month30: countIn(back(29), today), thisMonth: countIn(today.slice(0, 8) + '01', today),
      range: items.length, replies: items.reduce((a, x) => a + x.worked.replies, 0),
    };
    const subCounts = {
      open: mine.filter(t => t.status === 'in_progress').length,
      returned: mine.filter(t => t.status === 'in_progress' && (t.returned || t.assigned || t.bounced)).length,
      overdue: mine.filter(t => t.status === 'in_progress' && this.summary(t).overdue).length,
      tracking: mine.filter(t => t.tracking).length,
    };
    return { items: items.map(({ t, worked }) => ({ ...this.summary(t), worked })), byCategory: {}, subCounts, workedCounts, from, to };
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
        returned: mine.filter(([t]) => t.status === 'in_progress' && (t.returned || t.assigned || t.bounced)).length,
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
    const rec = this.p.messages.get(uid);
    if (!rec) throw new AppError(404, 'הקובץ לא נמצא');
    // רק מי שרואה את הפניה יכול לפתוח את הקבצים שלה (ובקבצים של הערה – מי שרואה את ההערה)
    const n = rec.system === 'files' ? this.notes.find(x => x.id === rec.note) : null;
    if (rec.system && !n) throw new AppError(404, 'הקובץ לא נמצא');
    const t = [...this.threads().values()].find(x => n ? x.ids.includes(n.t) : x.uids.includes(uid));
    if (!t || !this.canSee(t, user) || (n && !this.noteVisible(n, t, user))) throw new AppError(403, 'אין גישה לקובץ הזה');
    const list = await attcache.get(uid, async u => {
      const raw = await this.p.getRaw(u);
      return raw ? attachmentList(raw) : [];
    });
    const a = list[idx];
    if (!a) throw new AppError(404, 'הקובץ לא נמצא');
    return a;
  }
}

module.exports = { Engine, AppError };
