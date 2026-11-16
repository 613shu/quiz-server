// הרצה: npm test
const test = require('node:test');
const assert = require('node:assert');
const { redact, redactText, cleanSubject } = require('../src/redact');

const has = (s, sub) => assert.ok(s.includes(sub), `expected "${sub}" in:\n${s}`);
const not = (s, sub) => assert.ok(!s.includes(sub), `did not expect "${sub}" in:\n${s}`);

test('מיילים וקישורים', () => {
  const r = redactText('כתבו לי ל-moshe.cohen+1@gmail.com או היכנסו ל https://www.charidy.com/koh/rachel?x=1 תודה');
  not(r, 'moshe'); not(r, 'charidy.com'); has(r, '[מייל]'); has(r, '[קישור]');
});

test('טלפונים בפורמטים שונים', () => {
  for (const p of ['050-1234567', '0501234567', '+972-50-123-4567', '02 5371234', '972501234567']) {
    const r = redactText(`הטלפון שלי ${p} אשמח לחזרה`);
    not(r, '1234'); not(r, '5371234');
  }
});

test('ת"ז, אשראי, אסמכתא, IBAN, סכומים', () => {
  const r = redactText('ת.ז 012345678, כרטיס 4580 1234 5678 9012, אסמכתא 98765, חשבון IL62 0108 0000 0009 9999 999, חויבתי 180 ש"ח');
  for (const d of ['012345678', '4580', '9012', '98765', '0108', '180']) not(r, d);
  has(r, '[חשבון]'); has(r, 'ש"ח');
});

test('מספרים קטנים נשארים (חשובים לסיווג)', () => {
  const r = redactText('ירד לי 2 פעמים החודש');
  has(r, '2 פעמים');
});

test('תאריכים', () => {
  const r = redactText('תרמתי ב-12/03/2025 ושוב ב 5.4');
  not(r, '12/03'); not(r, '5.4'); has(r, '[תאריך]');
});

test('שם השולח מהכותרות מוסר גם עם אותיות שימוש', () => {
  const r = redactText('שלום, כאן משה כהן. התרומה של כהן לא מופיעה, ולמשה לא הגיעה קבלה', { names: ['משה כהן'] });
  not(r, 'משה'); not(r, 'כהן'); has(r, 'ל[שם]'); has(r, 'קבלה');
});

test('שם באנגלית מהכותרות', () => {
  const r = redactText('Hi, this is David Levi, I did not get a receipt', { names: ['David Levi <d@x.com>'] });
  not(r, 'David'); not(r, 'Levi'); has(r, 'receipt');
});

test('שם אחרי "על שם" / "השגרירה" / "שמי"', () => {
  const r = redactText('תרמתי על שם השגרירה רחל לוי, וגם שמי יעקב. השגרירה שלי לא קיבלה את זה');
  not(r, 'רחל'); not(r, 'לוי'); not(r, 'יעקב');
  has(r, 'על שם השגרירה [שם]');
  has(r, 'השגרירה שלי לא קיבלה');   // "שלי" אינו שם – לא נמחק
});

test('שורת סיום ומה שאחריה נמחקים', () => {
  const r = redactText('לא קיבלתי קבלה על התרומה.\nאשמח לעזרה\n\nבברכה,\nשרה כץ\nמנהלת חשבונות');
  has(r, 'לא קיבלתי קבלה'); not(r, 'שרה'); not(r, 'מנהלת'); not(r, 'בברכה');
});

test('"תודה" באמצע ההודעה לא חותך את התוכן', () => {
  const text = 'תודה על המענה הקודם\nאבל עדיין יש חיוב כפול\nאשמח שתבדקו\nשורה\nשורה\nשורה\nשורה\nשורה';
  has(redactText(text), 'חיוב כפול');
});

test('נושא: הסרת קידומות', () => {
  assert.strictEqual(cleanSubject('RE: Fwd: השב: בקשה לקבלה'), 'בקשה לקבלה');
});

test('חיתוך אורך', () => {
  const r = redact({ subject: 'א'.repeat(500), body: 'ב '.repeat(5000) });
  assert.ok(r.subject.length <= 201);
  assert.ok(r.body.length <= 1501);
  has(r.text, 'נושא:'); has(r.text, 'תוכן:');
});

test('ביצועים: קלט זדוני לא תוקע (פחות מ-200ms)', () => {
  const evil = ('a'.repeat(60) + '@' + 'b-'.repeat(60) + ' ' + '1 '.repeat(200) + 'www.' + 'x'.repeat(600) + ' ').repeat(20);
  const t0 = Date.now();
  redact({ subject: evil, body: evil, names: ['א ב'] });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0}ms`);
});

test('פלט מלא לדוגמה', () => {
  const r = redact({
    subject: 'Re: חיוב כפול בכרטיס',
    body: 'שלום,\nשמי מירי אברהם, ת"ז 123456789.\nחויבתי פעמיים על תרומה של 360 ש"ח ב-01/11/2026 דרך נדרים פלוס.\nאפשר לחזור אליי ל-052-7654321 או miri@walla.co.il\nבתודה,\nמירי',
    names: ['Miri Avraham', 'מירי אברהם'],
  });
  for (const x of ['מירי', 'אברהם', '123456789', '360', '01/11', '7654321', 'walla']) not(r.text, x);
  has(r.text, 'חויבתי פעמיים'); has(r.text, 'נדרים פלוס'); has(r.text, 'חיוב כפול');
});
