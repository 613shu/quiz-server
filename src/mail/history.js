// שחזור השרשור מתוך ההיסטוריה המצוטטת.
// הודעה שיובאה מאאוטלוק מכילה בתחתיתה את כל ההתכתבות הקודמת ("בתאריך... מאת...", "From: / Sent:" וכו').
// גם כשההודעות הקודמות עצמן לא יובאו (היו בתיקיה אחרת, בפריטים שנשלחו, או שלא נגררו) – אפשר לפרק
// את הציטוט להודעות נפרדות עם שולח ותאריך, ולהציג אותן בשרשור.
// (סריקת שורות בלבד – בלי ביטויים רגולריים עם חזרות מקוננות, כדי שמייל ארוך לא יקפיא את השרת)

const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,6}/;
const FIELD = /^\*?(From|Sent|Date|To|Cc|Subject|Importance|מאת|נשלח|תאריך|אל|עותק|נושא|חשיבות)\*?[ \t]*:/i;
const FROM_FIELD = /^\*?(From|מאת)\*?[ \t]*:\*?[ \t]*(.*)$/i;
const DATE_FIELD = /^\*?(Sent|Date|נשלח|תאריך)\*?[ \t]*:\*?[ \t]*(.*)$/i;
const SEPARATOR = /^(-{2,}[ \t]*(Original Message|הודעה מקורית|Forwarded message|הודעה שהועברה)[ \t]*-{2,}|-{20,}|_{10,})[ \t]*$/i;

const HE_MONTHS = ['ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יונ', 'יול', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// הפרש השעון של ישראל מ-UTC (בדקות) ברגע נתון
function tzOffset(t) {
  const s = new Date(t).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const m = /(\d+)\/(\d+)\/(\d+),? (\d+):(\d+)/.exec(s);
  if (!m) return 0;
  return Math.round((Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5]) - Math.floor(t / 60e3) * 60e3) / 60e3);
}

// שעה מקומית בישראל -> זמן אמיתי
function localToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let t = guess - tzOffset(guess) * 60e3;
  const off2 = tzOffset(t);
  t = guess - off2 * 60e3;
  return t;
}

function monthOf(tok) {
  let s = tok.toLowerCase().replace(/[׳'".]/g, '');
  let i = EN_MONTHS.findIndex(m => s.startsWith(m));
  if (i >= 0 && s.length >= 3) return i;
  if (s === 'מרס') return 2;
  i = HE_MONTHS.findIndex(m => s.startsWith(m));
  if (i >= 0) return i;
  if (s.startsWith('ב')) { s = s.slice(1); if (s === 'מרס') return 2; i = HE_MONTHS.findIndex(m => s.startsWith(m)); }
  return i;
}

// "יום ג׳, 22 בספט׳ 2026 ב-23:30" / "Tue, Sep 22, 2026 at 11:30 PM" / "22.9.2026, 23:21" / "9/22/2026 11:21 PM"
function parseQuoteDate(s) {
  s = String(s || '').replace(/[‎‏‪-‮]/g, '').slice(0, 300);
  const tm = /(\d{1,2}):(\d{2})(?::\d{2})?/.exec(s);
  if (!tm) return null;
  let h = +tm[1];
  const mi = +tm[2];
  const after = s.slice(tm.index + tm[0].length, tm.index + tm[0].length + 12).toLowerCase();
  if (/^\s*(pm|p\.m|אחה)/.test(after) && h < 12) h += 12;
  if (/^\s*(am|a\.m|לפנה)/.test(after) && h === 12) h = 0;
  const before = s.slice(0, tm.index);

  let y, mo, d;
  const num = /(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})/.exec(before);
  if (num) {
    let [a, b, c] = [+num[1], +num[2], +num[3]];
    if (num[1].length === 4) { y = a; mo = b - 1; d = c; }
    else {
      y = c < 100 ? 2000 + c : c;
      if (b > 12 && a <= 12) { mo = a - 1; d = b; }     // אמריקאי: חודש/יום
      else { d = a; mo = b - 1; }                         // ישראלי: יום.חודש
    }
  } else {
    const toks = before.split(/[\s,]+/).filter(Boolean);
    const mIdx = toks.findIndex(t => monthOf(t) >= 0 && !/^\d/.test(t));
    if (mIdx < 0) return null;
    mo = monthOf(toks[mIdx]);
    const yTok = toks.find(t => /^\d{4}$/.test(t));
    if (!yTok) return null;
    y = +yTok;
    const dayTok = [toks[mIdx - 1], toks[mIdx + 1]].find(t => t && /^\d{1,2}(st|nd|rd|th)?$/i.test(t));
    if (!dayTok) return null;
    d = parseInt(dayTok, 10);
  }
  if (!(y >= 2000 && y <= 2100 && mo >= 0 && mo < 12 && d >= 1 && d <= 31 && h < 24 && mi < 60)) return null;
  const t = localToUtc(y, mo, d, h, mi);
  if (t > Date.now() + 36 * 3600e3) return null;
  return new Date(t).toISOString();
}

function nameBefore(text, em) {
  let n = em ? text.slice(0, text.indexOf(em)) : text;
  n = n.replace(/[<"'\[(:\s]+$/, '').replace(/^[\s"'*]+/, '').replace(/mailto$/i, '').trim();
  return n.length > 80 ? '' : n;
}

// זיהוי כותרת של הודעה מצוטטת בשורה i. מחזיר { end, name, address, date } או null
function headerAt(lines, i) {
  const line = lines[i];
  if (!line) return null;

  // Gmail/הדשבורד בעברית: "בתאריך ... מאת שם <כתובת>:" / "בתאריך 22.9.2026, 23:21, שם כתב/ה:" (לפעמים נשבר לכמה שורות)
  // Gmail באנגלית: "On Tue, Sep 22, 2026 at 11:30 PM Name <x@y> wrote:"
  const he = /^(בתאריך|ב-?[ \t]?\d)/.test(line), en = /^On[ \t]/.test(line);
  if (he || en) {
    let text = line, j = i;
    while (j < i + 3 && !/:[ \t]*$/.test(text) && j + 1 < lines.length) text += ' ' + lines[++j];
    if (!/:[ \t]*$/.test(text)) return null;
    if (he && !/(מאת|כתב)/.test(text)) return null;
    if (en && !/wrote:[ \t]*$/i.test(text)) return null;
    const em = (EMAIL.exec(text) || [])[0] || null;
    const date = parseQuoteDate(text);
    if (!em && !date) return null;
    let name = '';
    if (he) {
      const k = text.indexOf('מאת');
      if (k >= 0) name = nameBefore(text.slice(k + 3), em);
      else name = (text.slice(0, text.indexOf('כתב')).split(',').pop() || '').trim();
    } else if (em) {
      name = (nameBefore(text, em).split(/\b(AM|PM)\b|,/i).pop() || '').trim();
    }
    return { end: j + 1, name, address: em ? em.toLowerCase() : null, date };
  }

  // Outlook: "From: שם <כתובת>" ואחריה "Sent: ..." (או בעברית "מאת:" / "נשלח:")
  const fm = FROM_FIELD.exec(line);
  if (fm) {
    let j = i + 1, dateText = null;
    for (; j < lines.length && j < i + 8; j++) {
      const l = lines[j];
      if (!l) { if (dateText) break; continue; }
      const dm = DATE_FIELD.exec(l);
      if (dm) { dateText = dm[2]; continue; }
      if (FIELD.test(l)) continue;
      if (dateText && (EMAIL.test(l) || /;[ \t]*$/.test(l)) && l.length < 300) continue;   // רשימת נמענים שנשברה לשורה נוספת
      break;
    }
    if (!dateText) return null;
    const em = (EMAIL.exec(fm[2]) || [])[0] || null;
    return { end: j, name: nameBefore(fm[2], em), address: em ? em.toLowerCase() : null, date: parseQuoteDate(dateText) };
  }
  return null;
}

// מפרק טקסט מצוטט להודעות: [{ name, address, date, body }], מהחדשה לישנה (כמו שהן מופיעות בציטוט).
// complete=true אם כל הטקסט פורק (התחיל בכותרת מזוהה)
function splitHistory(quoted) {
  if (!quoted) return { parts: [], complete: false };
  const lines = String(quoted).replace(/\r\n/g, '\n').replace(/[‎‏‪-‮]/g, '').slice(0, 200000).split('\n')
    .map(l => { let k = 0; while (k < l.length && (l[k] === '>' || l[k] === ' ' || l[k] === '\t')) k++; return l.slice(k).trimEnd(); });

  const parts = [];
  let cur = null, lead = [];
  const close = () => {
    if (!cur) return;
    const body = cur.lines;
    while (body.length && (!body[body.length - 1].trim() || SEPARATOR.test(body[body.length - 1].trim()))) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    const sig = body.findIndex(l => l === '--' || l === '-- ');
    cur.body = (sig >= 0 ? body.slice(0, sig) : body).join('\n').trim();
    delete cur.lines;
    parts.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length;) {
    const h = headerAt(lines, i);
    if (h) {
      close();
      cur = { name: h.name, address: h.address, date: h.date, lines: [] };
      i = h.end;
      continue;
    }
    if (cur) cur.lines.push(lines[i]); else lead.push(lines[i]);
    i++;
  }
  close();
  const complete = parts.length > 0 && lead.every(l => !l.trim() || SEPARATOR.test(l.trim()));
  return { parts, complete };
}

// מפתח להשוואת תוכן (האם זו אותה הודעה)
const bodyKey = s => String(s || '').toLowerCase().replace(/[\s\u200e\u200f>*_"'׳״`]+/g, '').slice(0, 160);

module.exports = { splitHistory, parseQuoteDate, bodyKey };
