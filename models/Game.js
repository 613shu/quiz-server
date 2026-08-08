const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  // קוד מספרי בן 4 ספרות - זה מה שהמתקשר מקיש בשלוחה כדי להצטרף למשחק הספציפי
  // הזה (שלב 4: כמה משחקים יכולים להיות חיים בו-זמנית, אותה שלוחה משותפת).
  // ייחודי גלובלית (לא רק בין משחקים פעילים) - פשוט יותר, ואין סיכון שקוד ישן
  // ממשחק לא-פעיל "יתפוס" בטעות שיחה שמיועדת למשחק אחר.
  code: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // בעל המשחק - הגישה נשלטת דרך ההתחברות שלו, אין יותר סיסמה נפרדת למשחק
  isActive: { type: Boolean, default: false }, // כמה משחקים יכולים להיות פעילים (חיים) בו-זמנית - ניתוב לפי code
  // שלב 5: גישה מלאה בתשלום - per-game (לא per-user/per-account כפי שהיה בהתחלה).
  // מתעדכן ע"י routes/paymentRoutes.js אחרי אימות תשלום מוצלח מול נדרים פלוס
  // (CallBack מאומת בלבד, לא תגובת לקוח). זהו המקור היחיד לגישה מורחבת - ראו
  // הערה על adminActivated למטה.
  paidUntil: { type: Date, default: null },
  // החלטה עסקית (8.8.2026): מנהל-על אינו מקבל יותר גישה מלאה חינם בשום מצב.
  // השדה הזה נשאר **לתיעוד/דיבוג בלבד** - true אם ההפעלה (activate) האחרונה
  // בוצעה ע"י מנהל-על - ואינו משפיע יותר על hasExtendedAccess באף route
  // (ראו routes/gamesRoutes.js). לא נמחק כדי לשמר היסטוריה קיימת ב-DB.
  adminActivated: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Game', gameSchema);