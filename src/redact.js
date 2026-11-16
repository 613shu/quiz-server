// התממה של פניה לפני שליחה לסיווג AI.
// פונקציה טהורה: בלי רשת, בלי לוגים, בלי תלות בשאר המערכת – קל לבדוק ביחידה.
//
// מה נשלח: נושא + גוף ההודעה האחרונה של הלקוח (אחרי ש-parse.js כבר הוריד ציטוטים וחתימת "-- ").
// מה מוסר כאן: מיילים, קישורים, טלפונים, חשבונות בנק, תאריכים, כל מספר של 3 ספרות ומעלה,
// שם השולח (מכותרות המייל), שמות אחרי מילים כמו "שמי" / "על שם" / "השגרירה", ושורות סיום ("בברכה" ומה שאחריה).
//
// חשוב: כל הביטויים הרגולריים כאן חסומים באורך (בלי כימות פתוח מקונן), והקלט נחתך לפני הבדיקה –
// כדי שלא יחזור מצב של ביטוי שנתקע על מייל מסוים ומקפיא את השרת (ראו הערה ב-mail/parse.js).

const MAX_SUBJECT = 200;
const MAX_BODY = 1500;
const MAX_SCAN = 4000;   // חיתוך ראשוני לפני כל עיבוד

const T = {
  email: '[מייל]', url: '[קישור]', phone: '[טלפון]', bank: '[חשבון]',
  date: '[תאריך]', num: '[מספר]', name: '[שם]',
};

const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g;

// שורות סיום – מהן ועד הסוף נמחק (שם, תפקיד, טלפון של החותם)
const CLOSING = /^[\s,.\-–]{0,3}(בברכה|בברכת|בתודה|תודה רבה|תודה|בכבוד רב|בכבוד|כל טוב|שבוע טוב|שבת שלום|חג שמח|בהוקרה|regards|best regards|kind regards|thanks|thank you|sincerely|cheers)(?![\p{L}])/iu;
const CLOSING_MAX_LINE = 40;     // שורת סיום היא קצרה
const CLOSING_LOOKBACK = 6;      // מחפשים רק בשורות האחרונות

const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,6}/g;
// קישור עד סוף המילה (בלי מגבלת 500 – אחרת שארית ארוכה ומקודדת נשלחת). הקלט כבר חתוך ל-MAX_SCAN.
const URL = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// כתובת בלי http/www (למשל wa.me/?text=..., bit.ly/xyz, koh.org.il/page)
const BARE_URL = /(?<![\w@.])[\w-]{1,63}(?:\.[\w-]{1,63}){0,4}\.(?:com|org|net|il|me|ly|io|co|info|link|app|to)(?:\/[^\s<>"']*)(?![\w])/gi;
// טקסט מקודד (%d7%90...) – 3 קידודים ומעלה ברצף, עם מה שצמוד אליהם
const ENCODED = /[^\s<>"']*(?:%[0-9a-f]{2}){3}[^\s<>"']*/gi;
// "מילה" ארוכה מאוד בלי רווחים (base64, מזהים, שאריות קישורים) – לא תורמת לסיווג
const LONG_TOKEN = /[^\s]{60,}/g;
const IBAN = /\bIL\d{2}(?:[ -]?\d){10,30}/gi;
const DATE = /(?<!\d)\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?(?!\d)/g;
const PHONE = /(?<!\d)(?:\+?972[-\s]?|0)(?:[-\s]?\d){8,9}(?!\d)/g;
// רצף ספרות (אפשר עם רווחים/מקפים/נקודות באמצע), עד 40 תווים
const DIGITS = /\d(?:[\d \-.,]{0,38}\d)?/g;

// מילים שאחריהן בא בדרך כלל שם
const NAME_CUES = ['שמי', 'קוראים לי', 'על שם', 'ע"ש', 'ע״ש', 'בשם', 'השגרירה', 'שגרירה', 'התלמידה', 'my name is', 'name is'];
// מילים שמדלגים עליהן בין הרמז לשם ("על שם השגרירה רחל" → "על שם השגרירה [שם]")
const SKIP = new Set(['השגרירה', 'שגרירה', 'התלמידה', 'תלמידה', 'הבת', 'בתי', 'הבן', 'בני', 'מר', 'גב\'', 'גברת', 'הרב', 'ר\'', 'משפחת', 'בת', 'בן']);
// מילים נפוצות – אם אחרי הרמז באה אחת מהן, זה לא שם ("השגרירה שלי לא קיבלה")
const COMMON = new Set([
  'שלי', 'שלנו', 'שלו', 'שלה', 'של', 'לא', 'כן', 'היא', 'הוא', 'אני', 'זה', 'זו', 'את', 'אותה', 'אותו', 'עם', 'גם', 'רק', 'כבר',
  'עוד', 'אמרה', 'ביקשה', 'קיבלה', 'שלחה', 'כתבה', 'טענה', 'אומרת', 'צריכה', 'רוצה', 'יכולה', 'לא?', 'הזו', 'הזאת', 'שלכם',
  'מה', 'מי', 'איך', 'למה', 'כי', 'אבל', 'ש', 'אם', 'על', 'אל', 'מ', 'ב', 'ל', 'ה', 'ו', 'אחרת', 'אחת', 'הנ"ל', 'הנל',
  'the', 'is', 'a', 'my', 'not',
]);
const WORD = /^[\p{L}"'׳״\-]{2,20}$/u;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function normalize(s, max) {
  return String(s || '').slice(0, max).replace(/\r\n?/g, '\n').replace(BIDI, '');
}

// מחיקת שורת סיום ומה שאחריה (רק אם היא קצרה ובסוף ההודעה)
function cutClosing(text) {
  const lines = text.split('\n');
  const from = Math.max(1, lines.length - CLOSING_LOOKBACK);
  for (let i = from; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l && l.length <= CLOSING_MAX_LINE && CLOSING.test(l)) return lines.slice(0, i).join('\n');
  }
  return text;
}

// שם השולח מהכותרות ("Moshe Cohen", "משה כהן") – כל מילה בשם מוחלפת, גם עם אותיות שימוש (ו/ה/ב/ל/מ/ש/כ)
function nameWords(names) {
  const out = new Set();
  for (const n of names || []) {
    for (const w of String(n || '').split(/[\s,.<>"()]+/)) {
      const t = w.trim();
      if (t.length >= 2 && t.length <= 30 && !/[@\d]/.test(t) && !COMMON.has(t.toLowerCase())) out.add(t);
    }
  }
  return [...out];
}

function replaceKnownNames(text, words) {
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}])([והבלמשכ]{0,2})${escapeRe(w)}(?![\\p{L}])`, 'giu');
    text = text.replace(re, `$1${T.name}`);
  }
  return text;
}

// שם אחרי רמז: עד 2 מילים, אחרי דילוג על מילות תואר ("השגרירה", "מר" וכו')
function replaceCuedNames(text) {
  for (const cue of NAME_CUES) {
    const re = new RegExp(`(?<![\\p{L}])(${escapeRe(cue)})((?:[ \\t]+[^\\s]{1,25}){1,4})`, 'giu');
    text = text.replace(re, (all, c, rest) => {
      const parts = rest.match(/[ \t]+[^\s]{1,25}/g) || [];
      let i = 0, kept = '';
      while (i < parts.length && SKIP.has(parts[i].trim())) kept += parts[i++];
      const first = parts[i] && parts[i].trim().replace(/[,.:;!?]+$/, '');
      if (!first || !WORD.test(first) || COMMON.has(first.toLowerCase()) || first.startsWith('[')) return all;
      let n = 1;
      const second = parts[i + 1] && parts[i + 1].trim().replace(/[,.:;!?]+$/, '');
      if (second && WORD.test(second) && !COMMON.has(second.toLowerCase()) && !/[,.:;!?]$/.test(parts[i].trim())) n = 2;
      const last = parts[i + n - 1].trim();
      const punct = (last.match(/[,.:;!?]+$/) || [''])[0];
      return c + kept + ' ' + T.name + punct + parts.slice(i + n).join('');
    });
  }
  return text;
}

function replaceDigits(text) {
  return text.replace(DIGITS, m => ((m.match(/\d/g) || []).length >= 3 ? T.num : m));
}

// התממה של קטע טקסט אחד
function redactText(text, { names = [], max = MAX_BODY, closing = true } = {}) {
  let t = normalize(text, MAX_SCAN);
  if (closing) t = cutClosing(t);
  t = t.replace(EMAIL, T.email)
    .replace(URL, T.url)
    .replace(BARE_URL, T.url)
    .replace(ENCODED, T.url)
    .replace(LONG_TOKEN, '')
    .replace(IBAN, T.bank)
    .replace(PHONE, T.phone)
    .replace(DATE, T.date);
  t = replaceDigits(t);
  t = replaceKnownNames(t, nameWords(names));
  t = replaceCuedNames(t);
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// נושא בלי קידומות תשובה/העברה
function cleanSubject(s) {
  let t = normalize(s, MAX_SCAN).replace(/\n/g, ' ');
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/^\s*(re|fw|fwd|השב|תשובה|הועבר|העבר|ייבוא)\s*:\s*/i, '');
    if (n === t) break;
    t = n;
  }
  return t;
}

// כמה הודעות לקוח באותה פניה: הראשונה (בדרך כלל מסבירה את הבעיה) עד FIRST_SHARE תווים,
// והשאר מהאחרונה אחורה עד שנגמר התקציב. כל הודעה מותממת בנפרד (כולל חיתוך שורת הסיום שלה).
const FIRST_SHARE = 700;
const SEP = '\n---\n';
function joinBodies(bodies, names) {
  const parts = bodies.map(b => redactText(b, { names, max: MAX_BODY })).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const all = parts.join(SEP);
  if (all.length <= MAX_BODY) return all;
  const first = parts[0].length > FIRST_SHARE ? parts[0].slice(0, FIRST_SHARE) + '…' : parts[0];
  let budget = MAX_BODY - first.length - SEP.length;
  const tail = [];
  for (let i = parts.length - 1; i >= 1 && budget > 40; i--) {
    const p = parts[i].length > budget ? parts[i].slice(0, budget) + '…' : parts[i];
    tail.unshift(p);
    budget -= p.length + SEP.length;
  }
  return [first, ...tail].join(SEP);
}

// הפונקציה הראשית: מחזירה את הטקסט היחיד שמותר לשלוח ל-AI
// body – הודעה אחת; bodies – כל הודעות הלקוח בפניה לפי הסדר (בלי תשובות צוות)
// names – שמות שידועים לנו מהכותרות (שם השולח), כדי להסיר אותם גם מתוך הגוף
function redact({ subject = '', body = '', bodies = null, names = [] } = {}) {
  const s = redactText(cleanSubject(subject), { names, max: MAX_SUBJECT, closing: false });
  const b = Array.isArray(bodies) ? joinBodies(bodies, names) : redactText(body, { names, max: MAX_BODY });
  return { subject: s, body: b, text: `נושא: ${s || '(ללא)'}\n\nתוכן:\n${b || '(ריק)'}` };
}

module.exports = { redact, redactText, cleanSubject, T, MAX_SUBJECT, MAX_BODY };
