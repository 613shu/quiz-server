// בדיקת אינטגרציה: ספק מדומה + fetch מדומה. סיווג פעם אחת, שמירה בתוויות, אין סיווג חוזר אחרי "הפעלה מחדש".
process.env.MAIL_PROVIDER = 'fake';
process.env.AI_ENABLED = '1';
process.env.AI_BACKEND = 'studio';
process.env.AI_API_KEY = 'k';
process.env.AI_MODEL = 'm';
const test = require('node:test');
const assert = require('node:assert');

let calls = 0, sent = [];
const answers = { 'לא קיבלתי קבלה': ['receipt'], 'התרומות לא מופיעות בדף שלי': ['general'] };
global.fetch = async (url, opts) => {
  calls++;
  const text = JSON.parse(opts.body).contents[0].parts[0].text;
  sent.push(text);
  const subj = text.split('\n')[0].replace('נושא: ', '');
  const cats = answers[subj] || ['double'];
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ categories: cats }) }] } }] }) };
};

const FakeProvider = require('../src/mail/fake');
const { Engine } = require('../src/engine');
const { Users } = require('../src/users');
const { AiWorker } = require('../src/ai-worker');

test('סיווג, שמירה, ואין סיווג חוזר', async () => {
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e);
  w.kick = () => {};             // שליטה ידנית בהרצה
  await p.start();
  assert.strictEqual(w.pending().length, 3);
  await w.run();
  assert.strictEqual(calls, 3);
  const bySubj = s => [...e.threads().values()].find(t => t.subject.includes(s));
  assert.deepStrictEqual(bySubj('לא קיבלתי קבלה').categories, ['receipt']);
  assert.deepStrictEqual(bySubj('לא מופיעות').categories, ['general']);   // KOH/ai בלי קטגוריה → כללי, לא מילות מפתח
  assert.deepStrictEqual(bySubj('שמנו לב').categories, ['double']);
  // שום פרט מזהה לא נשלח
  for (const s of sent) for (const x of ['רחל', 'גולדברג', '1,800', 'example.com', 'charidy.com', 'יוסף']) assert.ok(!s.includes(x), `${x} נשלח:\n${s}`);

  // "הפעלה מחדש": מנוע ועובד חדשים על אותן תוויות
  const e2 = new Engine(p, new Users());
  const w2 = new AiWorker(e2);
  w2.kick = () => {};
  assert.strictEqual(w2.pending().length, 0);
  await w2.run();
  assert.strictEqual(calls, 3);

  // תיקון ידני לא נדרס, ופניה חדשה מסווגת לבד
  const t = bySubj('לא קיבלתי קבלה');
  await p.modifyLabels(t.uids, ['KOH/cat/cancel'], ['KOH/cat/receipt']); e2.cache = null;
  await p.incoming({ name: 'א ב', email: 'n@x.com', subject: 'נושא חדש', text: 'גבו פעמיים' });
  e2.cache = null;
  assert.strictEqual(w2.pending().length, 1);
  await w2.run();
  assert.strictEqual(calls, 4);
  assert.deepStrictEqual([...e2.threads().values()].find(x => x.subject.includes('לא קיבלתי')).categories, ['cancel']);
});

test('כשל → לא מסומן, מוצג לפי מילות מפתח', async () => {
  const save = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e); w.kick = () => {};
  await p.start();
  await w.run();
  const t = [...e.threads().values()].find(x => x.subject.includes('לא קיבלתי קבלה'));
  assert.deepStrictEqual(t.categories, ['receipt']);           // מילות מפתח
  assert.ok(!t.raw.some(m => m.labels.has('KOH/ai')));
  assert.strictEqual(w.pending().length, 0);                   // לא מנסים שוב מיד (30 דק')
  global.fetch = save;
});

test('כל הודעות הלקוח נשלחות (בלי תשובות צוות), וסיווג חוזר לפניה "כללית" כשהלקוח כותב שוב', async () => {
  const save = global.fetch;
  const seen = [];
  let reply = ['general'];
  global.fetch = async (url, opts) => {
    seen.push(JSON.parse(opts.body).contents[0].parts[0].text);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ categories: reply }) }] } }] }) };
  };
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e); w.kick = () => {};
  await p.start();
  await w.run();
  const find = () => { e.cache = null; return [...e.threads().values()].find(x => x.subject.includes('לא מופיעות')); };
  let t = find();
  assert.deepStrictEqual(t.categories, ['general']);
  assert.strictEqual(w.pending().length, 0);
  const m0 = t.raw[0];

  // הלקוח כותב שוב → סיווג חוזר עם שתי ההודעות
  seen.length = 0; reply = ['assign'];
  await p.incoming({ name: 'שירה לוי', email: 'shira@example.com', subject: 'Re: התרומות לא מופיעות בדף שלי', text: 'שכחתי לציין: זה על שם השגרירה נועה, צריך לשייך', inReplyTo: m0.messageId, references: [m0.messageId] });
  t = find();
  assert.strictEqual(w.pending().length, 1);
  await w.run();
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].includes('---'), 'שתי ההודעות נשלחו');
  assert.ok(seen[0].includes('לשייך'));
  for (const x of ['שירה', 'לוי', 'נועה']) assert.ok(!seen[0].includes(x), `${x} נשלח`);
  assert.deepStrictEqual(find().categories, ['assign']);

  // עכשיו הקטגוריה ספציפית – הודעה נוספת לא גורמת לסיווג חוזר
  await p.incoming({ name: 'שירה לוי', email: 'shira@example.com', subject: 'Re: x', text: 'נו?', inReplyTo: m0.messageId, references: [m0.messageId] });
  find();
  assert.strictEqual(w.pending().length, 0);
  global.fetch = save;
});

test('מקסימום 3 סבבים, ותיקון ידני עוצר סיווג חוזר', async () => {
  const save = global.fetch;
  let n = 0;
  global.fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"categories":["inquiry"]}' }] } }] }) }; };
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e); w.kick = () => {};
  await p.start();
  await w.run();
  const base = n;
  const t0 = () => { e.cache = null; return [...e.threads().values()].find(x => x.subject.includes('לא מופיעות')); };
  const m0 = t0().raw[0];
  for (let i = 0; i < 4; i++) {
    await p.incoming({ name: 'ש', email: 'shira@example.com', subject: 'Re: x', text: 'עוד שאלה ' + i, inReplyTo: m0.messageId, references: [m0.messageId] });
    t0(); await w.run();
  }
  assert.strictEqual(n - base, 2);   // רק 2 סבבים חוזרים

  // תיקון ידני בפניה אחרת → לא מסווג שוב גם כשהלקוח כותב
  const other = [...e.threads().values()].find(x => x.subject.includes('לא קיבלתי'));
  await e.setCategories(other.id, ['inquiry'], { key: 'x' }).catch(() => {});
  await p.modifyLabels(other.uids, ['KOH/cat-manual', 'KOH/cat/inquiry'], []);   // למקרה שההרשאה חסמה את setCategories בבדיקה
  const r0 = other.raw[0];
  await p.incoming({ name: 'ר', email: 'rachel@example.com', subject: 'Re: x', text: 'עדיין לא', inReplyTo: r0.messageId, references: [r0.messageId] });
  e.cache = null;
  assert.ok(!w.pending().some(x => x.id === other.id));
  global.fetch = save;
});

test('סיווג מחדש: מוחק רק תוויות AI, לא נוגע בתיקון ידני', async () => {
  const save = global.fetch;
  let reply = ['assign'];
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ categories: reply }) }] } }] }) });
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e); w.kick = () => {};
  await p.start();
  await w.run();
  const get = s => { e.cache = null; return [...e.threads().values()].find(x => x.subject.includes(s)); };
  const manual = get('לא קיבלתי');
  await p.modifyLabels(manual.uids, ['KOH/cat/receipt', 'KOH/cat-manual'], ['KOH/cat/assign']);
  const r = await w.resetAi();
  assert.strictEqual(r.threads, 2);
  assert.deepStrictEqual(get('לא קיבלתי').categories, ['receipt']);
  reply = ['inquiry'];
  await w.run();
  assert.deepStrictEqual(get('לא מופיעות').categories, ['inquiry']);
  assert.deepStrictEqual(get('לא קיבלתי').categories, ['receipt']);
  global.fetch = save;
});

test('המרת קטגוריות שאוחדו: שגרירות→שיוך, אסמכתאות→בירור', async () => {
  const p = new FakeProvider();
  const e = new Engine(p, new Users());
  const w = new AiWorker(e); w.kick = () => {};
  await p.start();
  const [a, b] = [...e.threads().values()];
  await p.modifyLabels(a.uids, ['KOH/cat/ambassador', 'KOH/cat-manual'], []);
  await p.modifyLabels(b.uids, ['KOH/cat/proof'], []);
  assert.ok(await w.migrateCategories() >= 2);
  e.cache = null;
  const t = id => e.threads().get(id);
  assert.deepStrictEqual(t(a.id).categories, ['assign']);
  assert.ok(t(b.id).categories.includes('inquiry'));
  assert.ok(!t(a.id).raw.some(m => m.labels.has('KOH/cat/ambassador')));
});

test('מילות מפתח: איסוף ומזומן, ושגרירה → שיוך', () => {
  const { categorize } = require('../src/categorize');
  assert.deepStrictEqual(categorize('יש אצלי מעטפות עם מזומן, מתי אפשר לאסוף?'), ['collection']);
  assert.deepStrictEqual(categorize('אני שגרירה והקישור שלי לא עובד'), ['assign']);
});
