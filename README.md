# דשבורד ניהול פניות – קרן עולם התורה

המערכת מתחברת לתיבת Gmail שאליה מועברות הפניות מ-help@koh.org.il, מציגה כל שרשרת מייל כ"פניה",
ומאפשרת לצוות לקחת לטיפול, לענות (המייל נשלח ללקוח באותה שרשרת), לסמן כטופל ולהעביר למנהל.

**אין בסיס נתונים נפרד.** כל המצב נשמר בתוך Gmail כתוויות (KOH/...), ולכן שום דבר לא הולך לאיבוד
כשהשרת נרדם או מופעל מחדש. מיילים שהגיעו כשהשרת ישן נקלטים ברגע שהוא מתעורר.

## Render
- Build Command: `npm install`
- Start Command: `npm start`

### משתני סביבה (Environment)
| משתנה | חובה | תיאור |
|---|---|---|
| `GMAIL_APP_PASSWORD` | ✅ | סיסמת אפליקציה של lmanhtzibur@gmail.com (16 תווים) |
| `TEAM_USERS` | ✅ | `shapira:שפירא:סיסמה1,lefkovitz:לפקוביץ:סיסמה2,other:אחר:סיסמה3` |
| `SESSION_SECRET` | ✅ | מחרוזת אקראית ארוכה (ב-Render: Generate) |
| `GMAIL_USER` | | ברירת מחדל: lmanhtzibur@gmail.com |
| `MANAGER_EMAIL` | | ברירת מחדל: israel@kerenolamhatorah.org |
| `FROM_NAME` | | שם השולח במיילים. ברירת מחדל: קרן עולם התורה |
| `REPLY_TO` | | לאן יחזרו תשובות הלקוח. ריק = ישירות לתיבת ה-Gmail |
| `ACCEPT_TO` | | רק מיילים שנשלחו במקור לכתובות אלה נחשבים פניות. ברירת מחדל: help@koh.org.il. ריק = הכול |

## הכנת Gmail (פעם אחת)
1. להפעיל אימות דו-שלבי בחשבון Google: https://myaccount.google.com/security
2. ליצור סיסמת אפליקציה: https://myaccount.google.com/apppasswords
3. להדביק את הסיסמה ב-Render במשתנה `GMAIL_APP_PASSWORD`.

## מעבר לחשבון הארגון בהמשך
- Gmail אחר: לשנות `GMAIL_USER` + `GMAIL_APP_PASSWORD`.
- Outlook / Office 365: להוסיף ספק חדש בתיקייה `src/mail/` (Microsoft Graph) עם אותו ממשק.

## בדיקה מקומית (בלי מייל אמיתי)
`MAIL_PROVIDER=fake TEAM_USERS="a:בדיקה:1" SESSION_SECRET=x npm start`
