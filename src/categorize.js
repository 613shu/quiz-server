// סיווג אוטומטי ראשוני לפי מילות מפתח (מחזיר מפתחות קטגוריה). הצוות יכול לשנות ידנית.
const RULES = [
  ['double',     ['פעמיים', 'כפול', 'חויבתי', 'גבו לי', 'החזר', 'זיכוי', 'ירד לי', 'ירדו לי']],
  ['receipt',    ['קבלה', 'קבלות', 'סעיף 46', 'אישור מס', 'אישור תרומה']],
  ['standing',   ['הוראת קבע', 'הו"ק', 'הוק', 'חשבון בנק']],
  ['cancel',     ['לבטל', 'ביטול', 'לשנות', 'להפסיק', 'להקטין', 'להגדיל']],
  ['assign',     ['שיוך', 'לשייך', 'שויך', 'שייכו', 'לא מופיע', 'לא נספר', 'שם השגרירה', 'על שם']],
  ['ambassador', ['שגרירה', 'שגרירות', 'הדף שלי', 'הקישור שלי', 'היעד שלי']],
  ['inquiry',    ['תרומה', 'תרמתי', 'נדרים', 'צריכי', 'אשראי', 'מזומן', 'charidy']],
];

function categorize(text) {
  const t = (text || '').toLowerCase();
  const found = RULES.filter(([, words]) => words.some(w => t.includes(w.toLowerCase()))).map(([k]) => k);
  if (found.length > 1) { const i = found.indexOf('inquiry'); if (i >= 0) found.splice(i, 1); }
  return found.length ? found.slice(0, 2) : ['general'];
}

module.exports = { categorize };
