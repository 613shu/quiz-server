// הגדרות המערכת – הכול דרך משתני סביבה (ב-Render: Environment).
const env = process.env;

// TEAM_USERS: רשימת צוות בפורמט  key:שם:סיסמה  מופרדת בפסיקים
// לדוגמה: shapira:שפירא:Pass1,lefkovitz:לפקוביץ:Pass2
function parseTeam(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [key, name, ...pw] = x.split(':');
    return { key: (key || '').trim().toLowerCase(), name: (name || key || '').trim(), password: pw.join(':') };
  }).filter(u => /^[a-z0-9_-]+$/.test(u.key) && u.password);
}

const CATEGORIES = [
  { key: 'inquiry',   name: 'בירור תרומה',        color: '#3b82f6', aliases: ['אסמכתא', 'אסמכתה', 'אסמכתאות', 'אסמכתות'] },
  { key: 'assign',    name: 'שיוך תרומה ושגרירות', color: '#8b5cf6', aliases: ['שיוך', 'שגרירות', 'שגרירה'] },
  { key: 'receipt',   name: 'לא קיבלתי קבלה',     color: '#f59e0b' },
  { key: 'standing',  name: 'הו"ק בנקאית',        color: '#0ea5e9' },
  { key: 'double',    name: 'חיוב כפול / החזר',   color: '#ef4444' },
  { key: 'cancel',    name: 'ביטול / שינוי תרומה', color: '#f97316', aliases: ['ביטולים', 'ביטול', 'שינויים'] },
  { key: 'collection',name: 'איסוף ומזומן',       color: '#10b981', aliases: ['איסוף', 'מזומן', 'מעטפות'] },
  { key: 'english',   name: 'אנגלית',             color: '#0f766e', aliases: ['english', 'אנגלית'] },
  { key: 'system',    name: 'הודעות מערכת',       color: '#a16207', aliases: ['מערכת', 'הודעות מערכת', 'system'] },
  { key: 'general',   name: 'כללי',               color: '#64748b' },
];

// קטגוריות שאוחדו (2026-11-16): תוויות ישנות מומרות אוטומטית בהפעלה (ראו ai-worker.js → migrateCategories)
const MERGED_CATEGORIES = { ambassador: 'assign', proof: 'inquiry' };

module.exports = {
  PORT: env.PORT || 3000,
  MAIL_PROVIDER: env.MAIL_PROVIDER || 'gmail',       // gmail | fake (לבדיקות מקומיות בלבד)

  GMAIL_USER: (env.GMAIL_USER || 'lmanhtzibur@gmail.com').toLowerCase(),
  GMAIL_APP_PASSWORD: (env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  FROM_NAME: env.FROM_NAME || 'KOH Help',
  REPLY_TO: env.REPLY_TO || '',                         // ריק = תשובות הלקוח חוזרות ישירות לתיבה
  // כתובות שמעבירות אלינו מיילים (אם מגיע "Fwd" ידני מהן – נחלץ את הפונה המקורי)
  FORWARDERS: (env.FORWARDERS || 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  // רק מיילים שנשלחו במקור לאחת הכתובות האלה נחשבים פניות (כדי שמיילים פרטיים בתיבה לא ייכנסו).
  // ריק = כל מייל נכנס הוא פניה.
  // ACCEPT_ALL (ברירת מחדל): כל מייל שמגיע לתיבה נכנס לדשבורד, מכל כתובת. ACCEPT_ALL=0 = רק מה שנשלח במקור ל-ACCEPT_TO.
  ACCEPT_ALL: env.ACCEPT_ALL !== '0',
  ACCEPT_TO: (env.ACCEPT_TO ?? 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  // שולחים שאינם פניות (הודעות מערכת של גוגל וכו') – מוסתרים אוטומטית
  IGNORE_SENDERS: (env.IGNORE_SENDERS || 'no-reply@accounts.google.com,forwarding-noreply@google.com,mail-noreply@google.com,mailer-daemon@googlemail.com')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean),

  // שולחים שההודעות שלהם הן "הודעות מערכת" – נכנסות אוטומטית לקטגוריה הזו.
  // מזוהים לפי שם השולח או הכתובת (מספיק חלק מהשם, בלי הבדל בין אותיות גדולות לקטנות).
  SYSTEM_SENDERS: (env.SYSTEM_SENDERS || 'Synchroline,MailAdmin,Charidy Support')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean),

  // ייבוא הודעות קיימות מאאוטלוק: רק מיילים מהכתובות האלה עם נושא "ייבוא: ..." מיובאים
  IMPORT_SENDERS: (env.IMPORT_SENDERS || 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  IMPORT_REQUIRE_AUTH: env.IMPORT_REQUIRE_AUTH !== '0',   // בדיקת DKIM/DMARC שהמייל באמת הגיע מהכתובת

  // דומיינים של הארגון – בהיסטוריה המצוטטת, הודעה מכתובת בדומיין הזה מוצגת כתשובת צוות
  TEAM_DOMAINS: (env.TEAM_DOMAINS || 'koh.org.il,kerenolamhatorah.org').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),

  TEAM: parseTeam(env.TEAM_USERS),
  // מנהלים (לפי ה-key ב-TEAM_USERS). משמש באתחול הראשון ולכניסת חירום; אחר כך מנהלים את התפקידים במסך "ניהול צוות".
  MANAGERS: (env.MANAGERS || 'manager').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  SEED_EMAILS: { maimon: 'mmaimon11@gmail.com' },
  // אחרי כמה שעות בלי מענה פניה מסומנת "ממתינה זמן רב"
  OVERDUE_HOURS: +(env.OVERDUE_HOURS || 48),
  SESSION_SECRET: env.SESSION_SECRET || '',
  CATEGORIES,
  MERGED_CATEGORIES,
  SYNC_INTERVAL_MS: +(env.SYNC_INTERVAL_MS || 60000),

  // סיווג AI (Gemini). כבוי כברירת מחדל – נדלק רק עם AI_ENABLED=1 ומפתח.
  AI_ENABLED: env.AI_ENABLED === '1',                      // מתג כיבוי
  AI_BACKEND: (env.AI_BACKEND || 'vertex').toLowerCase(),  // vertex (Google Cloud, אזור באירופה) | studio (Google AI Studio)
  AI_API_KEY: env.AI_API_KEY || '',
  AI_MODEL: env.AI_MODEL || '',                            // מזהה המודל כפי שמופיע ב-Vertex (למשל משפחת Flash-Lite)
  AI_PROJECT: env.AI_PROJECT || '',                        // Project ID ב-Google Cloud (רק ל-vertex)
  AI_REGION: env.AI_REGION || 'europe-west4',
  AI_TIMEOUT_MS: +(env.AI_TIMEOUT_MS || 8000),
  // רק פניות שנפתחו מהתאריך הזה מסווגות ב-AI (בלי סיווג רטרואקטיבי של כל ההיסטוריה)
  AI_SINCE: env.AI_SINCE || '',
};
