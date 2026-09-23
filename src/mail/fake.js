// ספק מייל מדומה – לבדיקות מקומיות בלבד (MAIL_PROVIDER=fake). לא פעיל בשרת האמיתי.
// מחקה את התנהגות Gmail: שרשור לפי References, תוויות, תיקיית נשלח.
const { EventEmitter } = require('events');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');
const { parseRaw } = require('./parse');
const importer = require('../importer');

const build = opts => new Promise((res, rej) => new MailComposer(opts).compile().build((e, m) => e ? rej(e) : res(m)));

class FakeProvider extends EventEmitter {
  constructor() {
    super();
    this.name = 'fake';
    this.address = config.GMAIL_USER;
    this.messages = new Map();
    this.raws = new Map();
    this.uid = 0;
    this.thr = 1000;
    this.status = { connected: true, ready: false, lastSync: null, error: null, send: { ok: !process.env.FAKE_SEND_FAIL, error: process.env.FAKE_SEND_FAIL ? 'המייל לא נשלח: השרת לא מצליח להתחבר לשירות השליחה של Gmail. (בדיקה)' : null } };
  }
  configured() { return true; }

  async start() {
    const H = 3600e3, now = Date.now();
    const seed = [
      ['יוסף רבינוביץ', 'y.r@example.com', 'Re: שמנו לב שתרומתך לא הושלמה', 'אני סידרתי את התרומה אבל אני רואה שגבו לי פעמיים\nלמה?\n\nבתאריך יום ה׳, 17 בספט׳ 2026 ב-16:37 מאת <support@charidy.com>:\nהיי יוסף, תודה על בחירתך לתמוך בקרן עולם התורה!', 2 * H],
      ['רחל גולדברג', 'rachel@example.com', 'לא קיבלתי קבלה', 'שלום,\nתרמתי 1,800 ש"ח באשראי לפני שבועיים ועדיין לא קיבלתי קבלה לפי סעיף 46.\nתודה, רחל', 5 * H, true],
      ['שירה לוי', 'shira@example.com', 'התרומות לא מופיעות בדף שלי', 'היי, אני שגרירה. שלושה תורמים תרמו ורשמו את השם שלי אבל זה לא נספר ליעד.', 26 * H],
    ];
    for (const [name, email, subject, text, ago, att] of seed)
      await this.incoming({ name, email, subject, text, date: new Date(now - ago), attach: att });
    this.status.ready = true;
    this.emit('ready');
    this.status.lastSync = new Date().toISOString();
  }

  threadFor(rec) {
    for (const r of this.messages.values()) {
      if (rec.inReplyTo && r.messageId === rec.inReplyTo) return r.threadId;
      if (rec.references.includes(r.messageId)) return r.threadId;
    }
    return String(++this.thr);
  }

  async add(raw, labels) {
    const uid = ++this.uid;
    const rec = await parseRaw(raw, { uid, labels });
    if (!rec.system && importer.isImportRequest(rec)) { rec.system = 'import-request'; setImmediate(() => importer.processImports(this, { checkAuth: false }).catch(e => console.error('[import]', e))); }
    rec.threadId = this.threadFor(rec);
    this.messages.set(uid, rec);
    this.raws.set(uid, raw);
    this.status.lastSync = new Date().toISOString();
    this.emit('change');
    return rec;
  }

  async incoming({ name, email, subject, text, date = new Date(), attach, inReplyTo, references }) {
    const raw = await build({
      from: { name, address: email }, to: { name: 'Help', address: 'help@koh.org.il' }, subject, text, date,
      inReplyTo, references,
      attachments: attach ? [{ filename: 'צילום_מסך.png', content: Buffer.from('fake-image') }] : [],
    });
    return this.add(raw, ['\\Inbox']);
  }

  async modifyLabels(uids, add = [], remove = []) {
    for (const uid of uids) { const r = this.messages.get(uid); if (!r) continue; add.forEach(l => r.labels.add(l)); remove.forEach(l => r.labels.delete(l)); }
  }

  async send(mail) {
    // לבדיקות: FAKE_SEND_DELAY=ms מדמה שליחה איטית, FAKE_SEND_FAIL=1 מדמה חסימת שליחה
    if (process.env.FAKE_SEND_DELAY) await new Promise(r => setTimeout(r, +process.env.FAKE_SEND_DELAY));
    if (process.env.FAKE_SEND_FAIL) { const e = new Error(this.status.send.error); e.status = 502; throw e; }
    const raw = await build({ from: { name: config.FROM_NAME, address: config.GMAIL_USER }, ...mail });
    const rec = await this.add(raw, ['\\Sent']);
    return rec.messageId;
  }

  async appendRaw(raw, box) { await this.add(raw, [box]); }
  async sync() {}

  async getRaw(uid) { return this.raws.get(uid); }
  loadState() { return this.state || null; }
  async saveState(s) { this.state = JSON.parse(JSON.stringify(s)); }
}

module.exports = FakeProvider;
