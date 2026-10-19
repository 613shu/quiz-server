// משתמשי הצוות: שם, תפקיד (מנהל / חבר צוות), מייל, סיסמה מוצפנת.
// נשמרים יחד עם יומן הפעולות בהודעת המערכת שבתיבה (KOH-System) – בלי מסד נתונים.
// TEAM_USERS במשתני הסביבה משמש רק לאתחול הראשון, וככניסת חירום למנהלים (MANAGERS).
const crypto = require('crypto');
const config = require('./config');

const ROLES = { manager: 'מנהל', member: 'חבר צוות' };
const KEY_RE = /^[a-z0-9_-]{1,32}$/;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/;

class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }

function hashPw(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
function checkPw(u, password) {
  if (!u || !u.hash || !u.salt) return false;
  const h = crypto.scryptSync(String(password || ''), u.salt, 32);
  const want = Buffer.from(u.hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

class Users {
  constructor() {
    this.list = [];
    this.loaded = false;      // עד שהמצב נטען מהתיבה – עובדים לפי TEAM_USERS
  }

  // seeded=true אם נוצרו משתמשים מ-TEAM_USERS ויש לשמור מיד
  load(arr) {
    if (Array.isArray(arr) && arr.length) {
      this.list = arr.map(u => ({ ...u }));
      // משתמש חדש שנוסף ל-TEAM_USERS (key שלא קיים עדיין, גם לא כמחוק) – מתווסף אוטומטית
      const fresh = config.TEAM.filter(t => !this.list.some(u => u.key === t.key));
      for (const t of fresh) this.list.push(this.fromEnv(t));
      const fixed = this.demoteOldManagers();
      this.loaded = true;
      return fresh.length > 0 || fixed;
    }
    this.list = config.TEAM.map(u => this.fromEnv(u));
    this.loaded = true;
    return true;
  }

  // חד-פעמי: מיימון היה המנהל לפי ברירת המחדל הקודמת. עכשיו המנהל הוא משתמש נפרד ("מנהל"),
  // ולכן מיימון חוזר להיות חבר צוות – רק אם יש מנהל פעיל אחר. אחרי זה (roleFix) לא נוגעים יותר בתפקיד שלו.
  demoteOldManagers() {
    const u = this.list.find(x => x.key === 'maimon');
    if (!u || u.roleFix || u.role !== 'manager' || config.MANAGERS.includes('maimon')) return false;
    if (!this.list.some(x => x.key !== 'maimon' && !x.deleted && x.role === 'manager')) return false;
    u.role = 'member'; u.roleFix = 1; u.ver = (u.ver || 1) + 1;
    return true;
  }

  fromEnv(u) {
    return {
      key: u.key, name: u.name, role: config.MANAGERS.includes(u.key) ? 'manager' : 'member',
      email: config.SEED_EMAILS[u.key] || '', ver: 1, deleted: false, createdAt: new Date().toISOString(),
      ...hashPw(u.password),
    };
  }

  toJSON() { return this.list; }

  // כל המשתמשים, כולל מחוקים (לשמות בהיסטוריה ובסטטיסטיקה)
  all() {
    if (this.loaded) return this.list;
    return config.TEAM.map(u => ({ key: u.key, name: u.name, role: config.MANAGERS.includes(u.key) ? 'manager' : 'member', ver: 0, deleted: false }));
  }
  active() { return this.all().filter(u => !u.deleted); }
  get(key) { return this.all().find(u => u.key === key) || null; }
  isActive(key) { const u = this.get(key); return !!u && !u.deleted; }
  managers() { return this.active().filter(u => u.role === 'manager'); }

  // בדיקת סיסמה. לפני טעינת המצב – לפי TEAM_USERS. מנהל שמופיע ב-TEAM_USERS תמיד יכול להיכנס עם הסיסמה משם (כניסת חירום).
  verify(key, password) {
    const env = config.TEAM.find(u => u.key === key);
    // השוואה על גיבוב באורך קבוע – לא נכשלת גם כשהסיסמה הוקלדה במקלדת עברית (אורך בבתים שונה)
    const dig = v => crypto.createHash('sha256').update(String(v || '')).digest();
    const envOk = !!env && crypto.timingSafeEqual(dig(env.password), dig(password));
    if (!this.loaded) return envOk ? this.get(key) : null;
    const u = this.get(key);
    if (!u || u.deleted) return null;
    if (checkPw(u, password)) return u;
    if (envOk && config.MANAGERS.includes(key) && u.role === 'manager') return u;
    return null;
  }

  public(u) { return u && { key: u.key, name: u.name, role: u.role || 'member', email: u.email || '', phone: u.phone || '', deleted: !!u.deleted, createdAt: u.createdAt || null }; }

  _need() { if (!this.loaded) throw new AppError(503, 'המערכת עדיין נטענת מהתיבה. נסו שוב בעוד דקה.'); }
  _clean({ name, role, email, phone }, partial) {
    const out = {};
    if (name !== undefined || !partial) {
      name = String(name || '').trim().replace(/\s+/g, ' ');
      if (!name) throw new AppError(400, 'חסר שם');
      if (name.length > 40) throw new AppError(400, 'השם ארוך מדי');
      out.name = name;
    }
    if (role !== undefined || !partial) {
      if (!ROLES[role || 'member']) throw new AppError(400, 'תפקיד לא מוכר');
      out.role = role || 'member';
    }
    if (email !== undefined || !partial) {
      email = String(email || '').trim().toLowerCase();
      if (email && !EMAIL_RE.test(email)) throw new AppError(400, 'כתובת המייל לא תקינה');
      out.email = email;
    }
    if (phone !== undefined || !partial) {
      phone = String(phone || '').trim().replace(/\s+/g, ' ');
      if (phone && !/^[+\d][\d\s\-()]{5,19}$/.test(phone)) throw new AppError(400, 'מספר הטלפון לא תקין');
      out.phone = phone;
    }
    return out;
  }
  _pw(password) {
    password = String(password || '');
    if (password.length < 6) throw new AppError(400, 'הסיסמה צריכה להיות באורך 6 תווים לפחות');
    return hashPw(password);
  }

  create(data) {
    this._need();
    const fields = this._clean(data);
    if (this.active().some(u => u.name === fields.name)) throw new AppError(409, 'כבר יש חבר/ת צוות בשם הזה');
    let key;
    do key = 'u' + crypto.randomBytes(3).toString('hex'); while (this.get(key));
    const u = { key, ...fields, ver: 1, deleted: false, createdAt: new Date().toISOString(), ...this._pw(data.password) };
    this.list.push(u);
    return u;
  }

  update(key, data, actor) {
    this._need();
    const u = this.get(key);
    if (!u || u.deleted) throw new AppError(404, 'המשתמש לא נמצא');
    const fields = this._clean(data, true);
    if (fields.name && this.active().some(x => x.key !== key && x.name === fields.name)) throw new AppError(409, 'כבר יש חבר/ת צוות בשם הזה');
    if (fields.role && fields.role !== 'manager' && u.role === 'manager' && this.managers().length <= 1) throw new AppError(400, 'חייב להישאר לפחות מנהל אחד');
    if (actor && actor.key === key && fields.role && fields.role !== u.role) throw new AppError(400, 'אי אפשר לשנות את התפקיד של עצמך');
    Object.assign(u, fields);
    if (data.password) { Object.assign(u, this._pw(data.password)); u.ver = (u.ver || 1) + 1; }   // סיסמה חדשה מנתקת חיבורים קיימים
    return u;
  }

  setPassword(key, oldPw, newPw) {
    this._need();
    const u = this.get(key);
    if (!u || u.deleted) throw new AppError(404, 'המשתמש לא נמצא');
    if (!checkPw(u, oldPw)) throw new AppError(400, 'הסיסמה הנוכחית שגויה');
    Object.assign(u, this._pw(newPw));
    u.ver = (u.ver || 1) + 1;
    return u;
  }

  remove(key, actor) {
    this._need();
    const u = this.get(key);
    if (!u || u.deleted) throw new AppError(404, 'המשתמש לא נמצא');
    if (actor && actor.key === key) throw new AppError(400, 'אי אפשר למחוק את עצמך');
    if (u.role === 'manager' && this.managers().length <= 1) throw new AppError(400, 'חייב להישאר לפחות מנהל אחד');
    u.deleted = true; u.deletedAt = new Date().toISOString(); u.ver = (u.ver || 1) + 1;
    return u;
  }

  restore(key) {
    this._need();
    const u = this.get(key);
    if (!u || !u.deleted) throw new AppError(404, 'המשתמש לא נמצא');
    if (this.active().some(x => x.name === u.name)) throw new AppError(409, 'כבר יש חבר/ת צוות פעיל/ה בשם הזה');
    u.deleted = false; delete u.deletedAt; u.ver = (u.ver || 1) + 1;
    return u;
  }
}

module.exports = { Users, ROLES, KEY_RE };
