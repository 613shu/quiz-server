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
  await p.modifyLabels(t.uids, ['KOH/cat/proof'], ['KOH/cat/receipt']); e2.cache = null;
  await p.incoming({ name: 'א ב', email: 'n@x.com', subject: 'נושא חדש', text: 'גבו פעמיים' });
  e2.cache = null;
  assert.strictEqual(w2.pending().length, 1);
  await w2.run();
  assert.strictEqual(calls, 4);
  assert.deepStrictEqual([...e2.threads().values()].find(x => x.subject.includes('לא קיבלתי')).categories, ['proof']);
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
