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
  { key: 'inquiry',   name: 'בירור תרומה',        color: '#3b82f6' },
  { key: 'assign',    name: 'שיוך תרומה',         color: '#8b5cf6' },
  { key: 'receipt',   name: 'לא קיבלתי קבלה',     color: '#f59e0b' },
  { key: 'standing',  name: 'הו"ק בנקאית',        color: '#0ea5e9' },
  { key: 'double',    name: 'חיוב כפול / החזר',   color: '#ef4444' },
  { key: 'cancel',    name: 'ביטול / שינוי תרומה', color: '#f97316' },
  { key: 'ambassador',name: 'שגרירות',            color: '#ec4899' },
  { key: 'proof',     name: 'אסמכתאות',           color: '#10b981', aliases: ['אסמכתא', 'אסמכתה', 'אסמכתאות', 'אסמכתות'] },
  { key: 'general',   name: 'כללי',               color: '#64748b' },
];

module.exports = {
  PORT: env.PORT || 3000,
  MAIL_PROVIDER: env.MAIL_PROVIDER || 'gmail',       // gmail | fake (לבדיקות מקומיות בלבד)

  GMAIL_USER: (env.GMAIL_USER || 'lmanhtzibur@gmail.com').toLowerCase(),
  GMAIL_APP_PASSWORD: (env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  FROM_NAME: env.FROM_NAME || 'קרן עולם התורה',
  REPLY_TO: env.REPLY_TO || '',                         // ריק = תשובות הלקוח חוזרות ישירות לתיבה
  // כתובות שמעבירות אלינו מיילים (אם מגיע "Fwd" ידני מהן – נחלץ את הפונה המקורי)
  FORWARDERS: (env.FORWARDERS || 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  // רק מיילים שנשלחו במקור לאחת הכתובות האלה נחשבים פניות (כדי שמיילים פרטיים בתיבה לא ייכנסו).
  // ריק = כל מייל נכנס הוא פניה.
  ACCEPT_TO: (env.ACCEPT_TO ?? 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  // שולחים שאינם פניות (הודעות מערכת של גוגל וכו') – מוסתרים אוטומטית
  IGNORE_SENDERS: (env.IGNORE_SENDERS || 'no-reply@accounts.google.com,forwarding-noreply@google.com,mail-noreply@google.com,mailer-daemon@googlemail.com')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean),

  // ייבוא הודעות קיימות מאאוטלוק: רק מיילים מהכתובות האלה עם נושא "ייבוא: ..." מיובאים
  IMPORT_SENDERS: (env.IMPORT_SENDERS || 'help@koh.org.il').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  IMPORT_REQUIRE_AUTH: env.IMPORT_REQUIRE_AUTH !== '0',   // בדיקת DKIM/DMARC שהמייל באמת הגיע מהכתובת

  MANAGER_EMAIL: env.MANAGER_EMAIL || 'israel@kerenolamhatorah.org',
  TEAM: parseTeam(env.TEAM_USERS),
  SESSION_SECRET: env.SESSION_SECRET || '',
  CATEGORIES,
  SYNC_INTERVAL_MS: +(env.SYNC_INTERVAL_MS || 60000),
};
