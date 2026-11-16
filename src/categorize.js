// סיווג אוטומטי ראשוני לפי מילות מפתח (מחזיר מפתחות קטגוריה). הצוות יכול לשנות ידנית.
const RULES = [
  ['double',     ['פעמיים', 'כפול', 'חויבתי', 'גבו לי', 'החזר', 'זיכוי', 'ירד לי', 'ירדו לי']],
  ['receipt',    ['קבלה', 'קבלות', 'סעיף 46', 'אישור מס', 'אישור תרומה']],
  ['standing',   ['הוראת קבע', 'הו"ק', 'הוק', 'חשבון בנק']],
  ['cancel',     ['לבטל', 'ביטול', 'לשנות', 'להפסיק', 'להקטין', 'להגדיל']],
  ['collection', ['מזומן', 'מעטפה', 'מעטפות', 'איסוף', 'לאסוף', 'שליח', 'צ\'ק', 'צ׳ק', 'המחאה', 'המחאות', 'להביא', 'להעביר את הכסף', 'רכזת']],
  ['assign',     ['שיוך', 'לשייך', 'שויך', 'שייכו', 'לא נספר', 'שם השגרירה', 'על שם', 'שגרירה', 'שגרירות', 'הדף שלי', 'הקישור שלי', 'היעד שלי']],
  ['inquiry',    ['תרומה', 'תרמתי', 'נדרים', 'צריכי', 'אשראי', 'charidy', 'אסמכתא', 'אסמכתה', 'אסמכתאות', 'לא מופיע']],
];

function categorize(text) {
  const t = (text || '').toLowerCase();
  const found = RULES.filter(([, words]) => words.some(w => t.includes(w.toLowerCase()))).map(([k]) => k);
  if (found.length > 1) { const i = found.indexOf('inquiry'); if (i >= 0) found.splice(i, 1); }
  return found.length ? found.slice(0, 2) : ['general'];
}

// פניה באנגלית: בהודעות הלקוח (בלי ציטוט/חתימה) יש מספיק אותיות לטיניות וכמעט אין עברית
function isEnglish(texts) {
  let he = 0, en = 0;
  for (const t of texts) for (const ch of String(t || '')) {
    if (ch >= '\u05d0' && ch <= '\u05ea') he++;
    else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) en++;
  }
  return en >= 15 && he <= en * 0.1;
}

module.exports = { categorize, isEnglish };
