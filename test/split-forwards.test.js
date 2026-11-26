// פיצול העברות מרוכזות: כמה תשובות של לקוחות שונות שהועברו מהצוות ונכנסו לאותו שרשור Gmail
process.env.MAIL_PROVIDER = 'fake';
process.env.GMAIL_USER = process.env.GMAIL_USER || 'dash@example.org';
const test = require('node:test');
const assert = require('node:assert');
const MailComposer = require('nodemailer/lib/mail-composer');
const FakeProvider = require('../src/mail/fake');
const { Engine } = require('../src/engine');
const { Users } = require('../src/users');

const build = opts => new Promise((res, rej) => new MailComposer(opts).compile().build((e, m) => e ? rej(e) : res(m)));
const BLAST = '<blast@kerenolamhatorah.org>';
const quoteBlast = `בתאריך יום ב׳, 16 בנוב׳ 2026 ב-9:37 מאת למען תורתך <\nsystems@kerenolamhatorah.org>:\n\n> שטר השותפות\n> מנהלות ורכזות יקרות שלום רב.`;
const fwd = (name, addr, text) => `---------- Forwarded message ---------\nמאת: ${name} <${addr}>\nDate: יום ב׳, 16 בנוב׳ 2026 ב-11:19\nSubject: Re: שטר השותפות\nTo: למען תורתך <systems@kerenolamhatorah.org>\n\n\n${text}\n\n${quoteBlast}\n`;

async function setup() {
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const add = async (opts, labels = ['\\Inbox']) => {
    const r = await p.add(await build({ to: 'help@koh.org.il', ...opts }), labels);
    r.threadId = 'T1'; // Gmail מצרף את כולן לאותו שרשור
    return r;
  };
  const chaya = await add({ from: 'חיה <chaya@example.com>', subject: 'Re: שטר השותפות', text: 'אפשר לקבל מידע אילו תלמידות תרמו?\n\n' + quoteBlast, date: new Date('2026-11-16T09:29:00Z'), inReplyTo: BLAST, references: [BLAST] });
  const sys = 'קרן עולם התורה <systems@kerenolamhatorah.org>';
  const a = await add({ from: sys, subject: 'Fwd: Re: שטר השותפות', text: fwd('הדסה', 'hadasa@example.com', 'מתי הרכזת תקבל את הסכום?'), date: new Date('2026-11-20T08:49:00Z'), references: [BLAST, '<h@x>'] });
  const b = await add({ from: sys, subject: 'Fwd: Re: שטר השותפות', text: fwd('ריקי', 'riki@example.com', 'אשמח לפירוט התרומות'), date: new Date('2026-11-20T08:48:00Z'), references: [BLAST, '<r@x>'] });
  const note = await add({ from: sys, subject: 'Fwd: פנייתכם בטיפול', text: 'פנייתכם בטיפול', date: new Date('2026-11-20T08:48:30Z') });
  // התוויות של הפניה המאוחדת (המנהל לקח, הועבר למנהל)
  for (const r of [chaya, a, b, note]) { r.labels.add('KOH/escalated'); r.labels.add('KOH/by/manager'); }
  e.cache = null;
  return { p, e, chaya, a, b, note };
}

test('כל לקוחה שהועברה מקבלת פניה נפרדת', async () => {
  const { e, chaya, a, b, note } = await setup();
  const ts = [...e.threads().values()];
  const byUid = uid => ts.find(t => t.raw.some(m => m.uid === uid));
  assert.notStrictEqual(byUid(a.uid), byUid(chaya.uid));
  assert.notStrictEqual(byUid(b.uid), byUid(chaya.uid));
  assert.notStrictEqual(byUid(a.uid), byUid(b.uid));
  assert.notStrictEqual(byUid(note.uid), byUid(chaya.uid));
  assert.strictEqual(byUid(chaya.uid).id, 'T1'); // הפניה המקורית שומרת על המזהה שלה
  assert.strictEqual(byUid(a.uid).fromEmail, 'hadasa@example.com');
  assert.strictEqual(byUid(b.uid).fromEmail, 'riki@example.com');
  assert.strictEqual(byUid(chaya.uid).raw.length, 1);
});

test('הפניות שפוצלו מתחילות כחדשות (התוויות הישנות מנוקות פעם אחת)', async () => {
  const { e, a, chaya } = await setup();
  e.threads();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(a.labels.has('KOH/split'));
  assert.ok(!a.labels.has('KOH/escalated') && !a.labels.has('KOH/by/manager'));
  assert.ok(chaya.labels.has('KOH/escalated')); // המקורית לא נוגעים
  const t = [...e.threads().values()].find(x => x.raw.some(m => m.uid === a.uid));
  assert.strictEqual(t.status, 'new');
  // מכאן התוויות לא מנוקות שוב (למשל מישהי לקחה את הפניה החדשה)
  a.labels.add('KOH/by/manager'); e.cache = null; e.threads();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(a.labels.has('KOH/by/manager'));
});

test('תשובה מהדשבורד ללקוחה שפוצלה נשארת בפניה שלה', async () => {
  const { p, e, a, chaya } = await setup();
  const r = await p.add(await build({ from: process.env.GMAIL_USER, to: 'hadasa@example.com', subject: 'Re: שטר השותפות', text: 'שלום', date: new Date('2026-11-21T08:00:00Z'), inReplyTo: a.messageId, references: [a.messageId] }), ['\\Sent']);
  r.threadId = 'T1';
  // והודעה של המנהל לכתובת אחרת, שעונה לאותה העברה – נשארת בפניה המקורית ולא מחברת אותן מחדש
  const m = await p.add(await build({ from: process.env.GMAIL_USER, to: 'other@example.com', subject: 'Re: שטר השותפות', text: 'יש בעיה', date: new Date('2026-11-22T08:00:00Z'), inReplyTo: a.messageId, references: [a.messageId] }), ['\\Sent']);
  m.threadId = 'T1';
  e.cache = null;
  const ts = [...e.threads().values()];
  const byUid = uid => ts.find(t => t.raw.some(x => x.uid === uid));
  assert.strictEqual(byUid(r.uid), byUid(a.uid));
  assert.strictEqual(byUid(m.uid), byUid(chaya.uid));
  assert.notStrictEqual(byUid(a.uid), byUid(chaya.uid));
});

test('שרשור רגיל של לקוח אחד – בלי שינוי', async () => {
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const x = await p.add(await build({ from: 'x@example.com', to: 'help@koh.org.il', subject: 'שאלה', text: 'שלום', date: new Date('2026-11-20T08:00:00Z') }), ['\\Inbox']);
  const y = await p.add(await build({ from: 'מנהלת <israel@kerenolamhatorah.org>', to: 'help@koh.org.il', subject: 'Fwd: שאלה', text: fwd('x', 'x@example.com', 'עוד שאלה'), date: new Date('2026-11-21T08:00:00Z') }), ['\\Inbox']);
  x.threadId = y.threadId = 'T9';
  e.cache = null;
  const ts = [...e.threads().values()];
  assert.strictEqual(ts.length, 1);
  assert.strictEqual(ts[0].raw.length, 2);
});

test('פניות שטר השותפות נכנסות לקטגוריה "שטר שותפות"', async () => {
  const { e, a, chaya } = await setup();
  chaya.labels.add('KOH/cat/inquiry'); chaya.labels.add('KOH/ai'); // סווג קודם ע"י AI
  e.cache = null;
  for (const t of e.threads().values()) if (/שטר/.test(t.subject)) assert.deepStrictEqual(t.categories, ['partnership']);
  const { categorize } = require('../src/categorize');
  assert.deepStrictEqual(categorize('שאלה לגבי שטר השותפות של הבנות'), ['partnership']);
});
