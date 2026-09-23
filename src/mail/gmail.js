// חיבור לתיבת Gmail דרך IMAP (קריאה, תוויות) + SMTP (שליחה), עם סיסמת אפליקציה.
// כל המידע נשמר בתוך Gmail עצמו (תוויות KOH/...), כך ששום דבר לא הולך לאיבוד כשהשרת מופעל מחדש.
const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const config = require('../config');
const { parseRaw } = require('./parse');

const STATE_BOX = 'KOH-System';

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
    this.smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD },
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
      if (!this.allMail) throw new Error('לא נמצאה תיקיית "כל הדואר" – ודאו ש-IMAP מופעל בג׳ימייל');
      // יצירת התוויות שהמערכת משתמשת בהן (אם עוד לא קיימות)
      const needed = [STATE_BOX, 'KOH', 'KOH/by', 'KOH/cat', 'KOH/done', 'KOH/escalated', 'KOH/ignore', 'KOH/keep', 'KOH/reopened',
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

    // 1. הודעות חדשות
    const fresh = [];
    for await (const m of c.fetch(`${this.maxUid + 1}:*`, { uid: true, labels: true, threadId: true, internalDate: true, source: true }, { uid: true })) {
      if (m.uid > this.maxUid) fresh.push(m);
    }
    for (const m of fresh) {
      try {
        const rec = await parseRaw(m.source, { uid: m.uid, threadId: m.threadId, labels: m.labels, internalDate: m.internalDate });
        if (!rec.system && !config.FORWARDERS.includes(rec.from.address)) delete rec.fullText;
        this.messages.set(m.uid, rec);
        changed = true;
      } catch (e) { console.error('[gmail] parse', m.uid, e.message); }
      this.maxUid = Math.max(this.maxUid, m.uid);
    }

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
    let info;
    try {
      info = await this.smtp.sendMail({
        from: { name: config.FROM_NAME, address: config.GMAIL_USER },
        ...(config.REPLY_TO ? { replyTo: config.REPLY_TO } : {}),
        ...mail,
      });
    } catch (e) {
      console.error('[smtp] שליחה נכשלה:', e.code || '', e.responseCode || '', e.message);
      const fe = friendlySendError(e);
      if (fe.connection) this.status.send = { ok: false, error: fe.message, checkedAt: new Date().toISOString() };
      throw fe;
    }
    this.status.send = { ok: true, error: null, checkedAt: new Date().toISOString() };
    setTimeout(() => this.sync().catch(() => {}), 2500);
    return info.messageId;
  }

  async getRaw(uid) {
    const m = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
    return m && m.source;
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
