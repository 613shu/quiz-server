// חיבור לתיבת Gmail דרך IMAP (קריאה, תוויות) + SMTP (שליחה), עם סיסמת אפליקציה.
// כל המידע נשמר בתוך Gmail עצמו (תוויות KOH/...), כך ששום דבר לא הולך לאיבוד כשהשרת מופעל מחדש.
const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const config = require('../config');
const { parseRaw } = require('./parse');
const importer = require('../importer');

const MailComposer = require('nodemailer/lib/mail-composer');

const STATE_BOX = 'KOH-System';
const build = opts => new Promise((res, rej) => new MailComposer(opts).compile().build((e, m) => e ? rej(e) : res(m)));
// הכתובת שממנה יוצאות התשובות: SEND_USER אם הוגדר, אחרת תיבת הקריאה
const SENDER = config.SEND_USER || config.GMAIL_USER;
const SENDER_PASS = config.SEND_USER ? config.SEND_APP_PASSWORD : config.GMAIL_APP_PASSWORD;

class GmailProvider extends EventEmitter {
  constructor() {
    super();
    this.name = 'gmail';
    this.address = config.GMAIL_USER;
    this.messages = new Map();       // uid -> record
    this.status = { connected: false, ready: false, lastSync: null, error: null, send: { ok: null, error: null, checkedAt: null } };
    this.client = null;
    this.allMail = null;
    this.trash = null;
    this.uidValidity = null;
    this.maxUid = 0;
    this.syncing = null;
    this.sentBox = null;
    this.smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: SENDER, pass: SENDER_PASS },
      // זמני המתנה קצרים – כדי שתקלה תדווח תוך שניות ולא תשאיר את המשתמש מחכה דקות
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 90000,
    });
  }

  configured() { return !!(config.GMAIL_USER && config.GMAIL_APP_PASSWORD); }

  async start() {
    if (!this.configured()) {
      this.status.error = 'חסרים פרטי התחברות לג׳ימייל (GMAIL_APP_PASSWORD)';
      return;
    }
    await this.connect();
    setInterval(() => this.sync().catch(e => this.fail(e)), config.SYNC_INTERVAL_MS);
    this.checkSend();
  }

  // בדיקה שאפשר לשלוח מיילים (SMTP). התוצאה מוצגת בדשבורד לפני שמישהו כותב תשובה.
  async checkSend() {
    clearTimeout(this.sendCheckTimer);
    try {
      await this.smtp.verify();
      this.status.send = { ok: true, error: null, checkedAt: new Date().toISOString() };
      console.log('[smtp] שליחת מיילים תקינה');
    } catch (e) {
      const fe = friendlySendError(e);
      this.status.send = { ok: false, error: fe.message, checkedAt: new Date().toISOString() };
      console.error('[smtp] שליחה לא זמינה:', e.code || '', e.message);
    }
    this.sendCheckTimer = setTimeout(() => this.checkSend(), this.status.send.ok ? 60 * 60e3 : 5 * 60e3);
  }

  fail(e) {
    console.error('[gmail]', e.message);
    this.status.error = e.message;
  }

  async connect() {
    clearTimeout(this.reconnectTimer);
    try {
      const client = new ImapFlow({
        host: 'imap.gmail.com', port: 993, secure: true,
        auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD },
        logger: false, emitLogs: false,
      });
      client.on('error', e => this.fail(e));
      client.on('close', () => {
        this.status.connected = false;
        if (this.client === client) this.reconnectTimer = setTimeout(() => this.connect(), 15000);
      });
      client.on('exists', () => { this.sync().catch(e => this.fail(e)); });
      await client.connect();
      this.client = client;

      const boxes = await client.list();
      const find = flag => boxes.find(b => b.specialUse === flag);
      this.allMail = (find('\\All') || {}).path;
      this.trash = (find('\\Trash') || {}).path;
      this.sentBox = (find('\\Sent') || {}).path;
      if (!this.allMail) throw new Error('לא נמצאה תיקיית "כל הדואר" – ודאו ש-IMAP מופעל בג׳ימייל');
      // יצירת התוויות שהמערכת משתמשת בהן (אם עוד לא קיימות)
      const needed = [STATE_BOX, 'KOH', 'KOH/by', 'KOH/cat', 'KOH/done', 'KOH/escalated', 'KOH/ignore', 'KOH/keep', 'KOH/reopened', 'KOH/followup', importer.LABEL_BOX, importer.DONE_LABEL,
        ...config.TEAM.map(u => `KOH/by/${u.key}`), ...config.CATEGORIES.map(c => `KOH/cat/${c.key}`)];
      for (const path of needed) if (!boxes.some(b => b.path === path)) await client.mailboxCreate(path).catch(() => {});

      const mb = await client.mailboxOpen(this.allMail);
      if (this.uidValidity && String(mb.uidValidity) !== String(this.uidValidity)) {
        this.messages.clear(); this.maxUid = 0;
      }
      this.uidValidity = mb.uidValidity;
      this.status.connected = true;
      this.status.error = null;
      await this.sync(true);
      if (!this.status.ready) { this.status.ready = true; this.emit('ready'); }
      console.log(`[gmail] מחובר ל-${config.GMAIL_USER}, ${this.messages.size} הודעות`);
      // בקשות ייבוא שלא הושלמו (למשל כי החיבור נפל באמצע) – ממשיכים אותן
      setImmediate(() => importer.processImports(this).catch(e => this.fail(e)));
    } catch (e) {
      this.fail(e);
      this.status.connected = false;
      if (/auth|credentials|invalid/i.test(e.message || '')) this.status.error = 'ההתחברות לג׳ימייל נכשלה – בדקו את סיסמת האפליקציה';
      this.reconnectTimer = setTimeout(() => this.connect(), 30000);
    }
  }

  // סנכרון: הודעות חדשות + רענון תוויות לכל ההודעות (שינויים שנעשו ישירות בג׳ימייל)
  sync(full = false) {
    if (this.syncing) return this.syncing;
    this.syncing = this._sync(full).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async _sync() {
    const c = this.client;
    if (!c || !this.status.connected) return;
    let changed = false;

    if (!c.mailbox || !c.mailbox.exists) {
      if (this.messages.size) { this.messages.clear(); changed = true; }
      this.status.lastSync = new Date().toISOString();
      if (changed) this.emit('change');
      return;
    }

    // 1. הודעות חדשות – קודם רק פרטים קטנים (uid, גודל, תוויות), ואחר כך התוכן במנות,
    //    כדי שתיבה גדולה (או מיילי ייבוא ענקיים) לא יחרגו מהזיכרון של השרת
    const metas = [];
    for await (const m of c.fetch(`${this.maxUid + 1}:*`, { uid: true, labels: true, size: true }, { uid: true })) {
      if (m.uid > this.maxUid) metas.push({ uid: m.uid, size: m.size || 0, labels: new Set(m.labels || []) });
    }
    // מיילי בקשת ייבוא שכבר עובדו – לא צריך להוריד אותם שוב (הם מוסתרים ממילא, ולרוב ענקיים)
    const want = metas.filter(m => !m.labels.has(importer.DONE_LABEL));
    const fresh = [];
    if (want.length > 40) this.status.loading = { done: 0, total: want.length };
    let done = 0;
    while (want.length) {
      const batch = [];
      let bytes = 0;
      while (want.length && batch.length < 40 && (!batch.length || bytes + want[0].size <= 25 * 1024 * 1024)) {
        bytes += want[0].size; batch.push(want.shift().uid);
      }
      const got = [];
      for await (const m of c.fetch(batch.join(','), { uid: true, labels: true, threadId: true, internalDate: true, source: true }, { uid: true })) got.push(m);
      for (const m of got) {
        try {
          const rec = await parseRaw(m.source, { uid: m.uid, threadId: m.threadId, labels: m.labels, internalDate: m.internalDate });
          if (!rec.system && importer.isImportRequest(rec)) rec.system = 'import-request';
          if (!rec.system && !config.FORWARDERS.includes(rec.from.address)) delete rec.fullText;
          this.messages.set(m.uid, rec);
          fresh.push(m.uid);
          changed = true;
        } catch (e) { console.error('[gmail] parse', m.uid, e.message); }
        m.source = null;
      }
      done += batch.length;
      if (this.status.loading) {
        this.status.loading = { done, total: this.status.loading.total };
        console.log(`[gmail] נטענו ${done}/${this.status.loading.total}`);
      }
    }
    this.status.loading = null;
    for (const m of metas) this.maxUid = Math.max(this.maxUid, m.uid);

    // 2. רענון תוויות + זיהוי הודעות שנמחקו/הועברו לספאם
    const seen = new Set();
    for await (const m of c.fetch('1:*', { uid: true, labels: true, threadId: true }, { uid: true })) {
      seen.add(m.uid);
      const rec = this.messages.get(m.uid);
      if (!rec) continue;
      const labels = new Set(m.labels || []);
      if (!sameSet(labels, rec.labels)) { rec.labels = labels; changed = true; }
      if (m.threadId && String(m.threadId) !== rec.threadId) { rec.threadId = String(m.threadId); changed = true; }
    }
    for (const uid of [...this.messages.keys()]) {
      if (!seen.has(uid)) { this.messages.delete(uid); changed = true; }
    }

    this.status.lastSync = new Date().toISOString();
    if (changed) this.emit('change');
    // בקשות ייבוא מאאוטלוק – רצות אחרי שהסנכרון הסתיים
    if (fresh.length) setImmediate(() => importer.processImports(this).catch(e => this.fail(e)));
  }

  // שמירת הודעה קיימת (ייבוא) ישירות לתיבה, עם התאריך המקורי
  async appendRaw(raw, box, date) {
    await this.client.append(box, raw, ['\\Seen'], date);
  }

  async modifyLabels(uids, add = [], remove = []) {
    if (!uids.length) return;
    const range = uids.join(',');
    if (add.length) await this.client.messageFlagsAdd(range, add, { uid: true, useLabels: true });
    if (remove.length) await this.client.messageFlagsRemove(range, remove, { uid: true, useLabels: true });
    for (const uid of uids) {
      const r = this.messages.get(uid);
      if (!r) continue;
      add.forEach(l => r.labels.add(l));
      remove.forEach(l => r.labels.delete(l));
    }
  }

  async send(mail) {
    const separate = SENDER !== config.GMAIL_USER;
    const opts = {
      from: { name: config.FROM_NAME, address: SENDER },
      ...(config.REPLY_TO ? { replyTo: config.REPLY_TO } : {}),
      ...mail,
    };
    if (separate) {
      // מזהה ותאריך קבועים – כדי שהעותק שנשמר בתיבת הקריאה יהיה זהה למה שנשלח
      opts.messageId = opts.messageId || `<${Date.now()}.${Math.random().toString(36).slice(2)}@${SENDER.split('@')[1]}>`;
      opts.date = opts.date || new Date();
    }
    let info;
    try {
      info = await this.smtp.sendMail(opts);
    } catch (e) {
      console.error('[smtp] שליחה נכשלה:', e.code || '', e.responseCode || '', e.message);
      const fe = friendlySendError(e);
      if (fe.connection) this.status.send = { ok: false, error: fe.message, checkedAt: new Date().toISOString() };
      throw fe;
    }
    this.status.send = { ok: true, error: null, checkedAt: new Date().toISOString() };
    // שליחה מתיבה אחרת: שומרים עותק ב"דואר יוצא" של תיבת הקריאה, כדי שהדשבורד יראה את התשובה
    if (separate) {
      try {
        const raw = await build(opts);
        await this.client.append(this.sentBox || this.allMail, raw, ['\\Seen'], opts.date);
      } catch (e) {
        console.error('[smtp] המייל נשלח, אבל שמירת העותק בתיבה נכשלה:', e.message);
      }
    }
    setTimeout(() => this.sync().catch(() => {}), 2500);
    return info.messageId;
  }

  async getRaw(uid) {
    if (!this.client || !this.status.connected) throw new Error('אין כרגע חיבור לג׳ימייל');
    const m = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m || !m.source) throw new Error('לא הצלחתי להוריד את המייל מג׳ימייל (ייתכן שהחיבור התנתק)');
    return m.source;
  }

  // אחסון קטן ועמיד (יומן פעולות) – הודעה בתווית KOH-System
  loadState() {
    const recs = [...this.messages.values()].filter(r => r.system === 'state').sort((a, b) => b.uid - a.uid);
    if (!recs.length) return null;
    try { return JSON.parse(recs[0].fullText); } catch { return null; }
  }

  async saveState(obj) {
    if (!this.status.connected) return;
    const old = [...this.messages.values()].filter(r => r.system === 'state').map(r => r.uid);
    const raw = [
      `From: "KOH System" <${config.GMAIL_USER}>`,
      `To: <${config.GMAIL_USER}>`,
      'Subject: KOH dashboard state (do not delete)',
      'X-KOH-System: state',
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(JSON.stringify(obj)).toString('base64').replace(/.{76}/g, '$&\r\n'),
    ].join('\r\n');
    await this.client.append(STATE_BOX, raw, ['\\Seen']);
    await this.sync();
    if (old.length && this.trash) await this.client.messageMove(old.join(','), this.trash, { uid: true }).catch(() => {});
  }
}

// תרגום שגיאות שליחה להודעה ברורה בעברית
function friendlySendError(e) {
  const code = e.code || '', rc = e.responseCode || 0, msg = String(e.message || '');
  let text, connection = false;
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(code) || /greeting|timeout|timed out/i.test(msg)) {
    connection = true;
    text = 'המייל לא נשלח: השרת לא מצליח להתחבר לשירות השליחה של Gmail. (בשירות החינמי של Render שליחת מיילים חסומה – צריך תוכנית בתשלום.)';
  } else if (code === 'EAUTH' || rc === 535 || rc === 534) {
    connection = true;
    text = 'המייל לא נשלח: Gmail דחה את פרטי ההתחברות. בדקו את סיסמת האפליקציה (GMAIL_APP_PASSWORD).';
  } else if (rc === 552 || /size|too large/i.test(msg)) {
    text = 'המייל לא נשלח: הקבצים המצורפים גדולים מדי. Gmail מאפשר עד 25MB בסך הכול.';
  } else if (/5\.4\.5|daily|limit/i.test(msg)) {
    text = 'המייל לא נשלח: הגעתם למגבלת השליחה היומית של Gmail. נסו שוב מחר.';
  } else if (rc === 550 || rc === 553 || code === 'EENVELOPE') {
    text = 'המייל לא נשלח: כתובת הנמען נדחתה. בדקו שכתובת המייל של הפונה תקינה.';
  } else {
    text = `המייל לא נשלח: ${msg}`;
  }
  const err = new Error(text);
  err.status = 502; err.connection = connection;
  return err;
}

function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }

module.exports = GmailProvider;
