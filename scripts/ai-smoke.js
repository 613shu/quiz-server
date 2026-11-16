// בדיקת חיבור חד-פעמית למפתח Gemini – על פניה מומצאת בלבד (לא על מידע אמיתי).
// הרצה מהמחשב (בתיקיית הפרויקט):
//   AI_ENABLED=1 AI_API_KEY=... AI_PROJECT=... AI_MODEL=... node scripts/ai-smoke.js
// ב-Windows PowerShell:
//   $env:AI_ENABLED="1"; $env:AI_API_KEY="..."; $env:AI_PROJECT="..."; $env:AI_MODEL="..."; node scripts/ai-smoke.js
const { redact } = require('../src/redact');
const ai = require('../src/ai-classify');

const samples = [
  { subject: 'לא קיבלתי קבלה', body: 'שלום, תרמתי 500 ש"ח לפני חודש ועדיין לא קיבלתי קבלה לצורך מס. יוסי לוי 050-1112223', names: ['יוסי לוי'] },
  { subject: 'חיוב', body: 'ירד לי מהכרטיס פעמיים אותו סכום, אבקש החזר', names: [] },
  { subject: 'בקשה', body: 'אני רוצה להפסיק את הוראת הקבע החודשית', names: [] },
];

(async () => {
  if (!ai.isConfigured()) { console.log('חסרים משתנים: AI_ENABLED=1, AI_API_KEY, AI_MODEL, AI_PROJECT (ל-vertex)'); process.exit(1); }
  console.log('נקודת קצה:', ai.endpoint());
  for (const s of samples) {
    const r = redact(s);
    const out = await ai.classify(r.text);
    console.log('\n---\n' + r.text + '\n→', out.cats.join(', '), out.ok ? '' : '(נכשל – ' + ai.stats.lastError + ')');
  }
})();
