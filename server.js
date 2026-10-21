const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const config = require('./src/config');
const { Engine, AppError } = require('./src/engine');
const { Users } = require('./src/users');

const Provider = config.MAIL_PROVIDER === 'fake' ? require('./src/mail/fake') : require('./src/mail/gmail');
const provider = new Provider();
const users = new Users();
const engine = new Engine(provider, users);

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

// ---------- התחברות צוות ----------
const SECRET = config.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!config.SESSION_SECRET) console.warn('SESSION_SECRET לא הוגדר – המשתמשים יתנתקו בכל הפעלה מחדש');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const COOKIE = 'koh_s';
const MAX_AGE = 30 * 24 * 3600 * 1000;

// עוגייה: key.ver.exp.sig – ver משתנה בהחלפת סיסמה/מחיקה, וכך מנתק חיבורים ישנים
function readSession(req) {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!c) return null;
  const [key, ver, exp, sig] = decodeURIComponent(c.slice(COOKIE.length + 1)).split('.');
  if (!key || !ver || !exp || !sig || sign(`${key}.${ver}.${exp}`) !== sig || +exp < Date.now()) return null;
  const u = users.get(key);
  if (!u || u.deleted) return null;
  // לפני טעינת המצב ver=0; אחרי הטעינה הגרסה חייבת להתאים
  if (users.loaded && String(u.ver || 0) !== ver && ver !== '0') return null;
  return u;
}
const meOf = u => ({ key: u.key, name: u.name, role: u.role || 'member', manager: engine.isManager(u) });

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' });
  let u = null;
  try { u = users.verify(String((req.body && req.body.key) || ''), req.body && req.body.password); }
  catch (e) { console.error('[login]', e); return res.status(500).json({ error: 'שגיאה בבדיקת הסיסמה. נסו שוב.' }); }
  if (!u) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'סיסמה שגויה' }); }
  attempts.delete(ip);
  const exp = Date.now() + MAX_AGE, ver = String(users.loaded ? (u.ver || 0) : 0);
  const val = `${u.key}.${ver}.${exp}.${sign(`${u.key}.${ver}.${exp}`)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}${req.secure ? '; Secure' : ''}`);
  res.json(meOf(u));
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// מידע ציבורי: רק שמות הצוות (לבחירה במסך הכניסה)
app.get('/api/public', (req, res) => {
  const me = readSession(req);
  res.json({ team: users.active().map(u => ({ key: u.key, name: u.name })), me: me && meOf(me) });
});

// מכאן והלאה – רק למחוברים
app.use('/api', (req, res, next) => {
  const u = readSession(req);
  if (!u) return res.status(401).json({ error: 'יש להתחבר' });
  req.user = u;
  next();
});

const h = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : `שגיאה: ${e.message}` });
  }
};
const managerOnly = (req, res, next) => engine.isManager(req.user) ? next() : res.status(403).json({ error: 'רק למנהל' });

app.get('/api/config', h(req => ({
  me: meOf(req.user),
  team: users.all().map(u => ({ key: u.key, name: u.name, role: u.role || 'member', deleted: !!u.deleted })),
  categories: config.CATEGORIES,
  inbox: provider.address,
  overdueHours: config.OVERDUE_HOURS,
})));

app.get('/api/status', h(() => ({ ...provider.status, provider: provider.name, configured: provider.configured() })));

app.get('/api/inquiries', h(req => ({
  ...engine.list(req.query, req.user), counts: engine.counts(req.user), status: provider.status,
})));

app.get('/api/inquiries/:id', h(req => engine.detail(engine.get(req.params.id, req.user), req.user)));
app.post('/api/inquiries/:id/take', h(req => engine.take(req.params.id, req.user)));
app.post('/api/inquiries/:id/release', h(req => engine.release(req.params.id, req.user)));
app.post('/api/inquiries/:id/handled', h(req => engine.markHandled(req.params.id, req.user, !!(req.body && req.body.track))));
app.post('/api/inquiries/:id/tracking', h(req => engine.setTracking(req.params.id, req.user, !!(req.body && req.body.on))));
app.post('/api/inquiries/:id/reopen', h(req => engine.reopen(req.params.id, req.user)));
app.post('/api/inquiries/:id/ignore', h(req => engine.ignore(req.params.id, req.user)));
app.post('/api/inquiries/:id/categories', h(req => engine.setCategories(req.params.id, req.body.categories || [], req.user)));

app.post('/api/inquiries/:id/assign', h(req => engine.assign(req.params.id, req.user, String(req.body.to || ''))));
app.post('/api/inquiries/:id/notes', h(req => engine.addNote(req.params.id, req.user, req.body.text)));
app.delete('/api/inquiries/:id/notes/:noteId', h(req => engine.deleteNote(req.params.id, req.params.noteId, req.user)));

// ---------- סטטיסטיקה וניהול צוות (מנהל) ----------
app.get('/api/stats', managerOnly, h(req => engine.stats(req.query, req.user)));

const needSave = () => {
  if (!users.loaded || engine.stateBroken) throw new AppError(503, 'המערכת עדיין נטענת מהתיבה. נסו שוב בעוד דקה.');
  if (!provider.status.connected) throw new AppError(503, 'אין חיבור לתיבת המייל, ולכן אי אפשר לשמור שינויים בצוות כרגע.');
};
const teamList = () => users.all().map(u => users.public(u));
app.get('/api/team', managerOnly, h(() => ({ users: teamList() })));
app.post('/api/team', managerOnly, h(async req => {
  needSave();
  const u = users.create(req.body || {});
  await engine.saveStateNow();
  engine.addLog(null, req.user, 'team', `הוסיף/ה את ${u.name} לצוות`);
  return { user: users.public(u), users: teamList() };
}));
app.patch('/api/team/:key', managerOnly, h(async req => {
  needSave();
  const u = users.update(req.params.key, req.body || {}, req.user);
  await engine.saveStateNow();
  engine.cache = null;
  return { user: users.public(u), users: teamList() };
}));
app.delete('/api/team/:key', managerOnly, h(async req => {
  needSave();
  const r = await engine.removeUser(req.params.key, req.user, req.body && req.body.transferTo ? String(req.body.transferTo) : null);
  return { ...r, users: teamList() };
}));
app.post('/api/team/:key/restore', managerOnly, h(async req => {
  needSave();
  users.restore(req.params.key);
  await engine.saveStateNow();
  engine.cache = null;
  return { users: teamList() };
}));
// כל אחד יכול להחליף את הסיסמה של עצמו
app.post('/api/me/password', h(async (req, res) => {
  needSave();
  const u = users.setPassword(req.user.key, req.body.old, req.body.password);
  await engine.saveStateNow();
  // חיבור חדש עם הגרסה המעודכנת, כדי שהמשתמש לא יתנתק
  const exp = Date.now() + MAX_AGE, ver = String(u.ver);
  const val = `${u.key}.${ver}.${exp}.${sign(`${u.key}.${ver}.${exp}`)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}${req.secure ? '; Secure' : ''}`);
  return { ok: true };
}));

// העלאת קבצים עם הודעות שגיאה ברורות (במקום דף שגיאה כללי)
const MAX_TOTAL = 24 * 1024 * 1024;
const uploadFiles = (req, res, next) => upload.array('files', 10)(req, res, err => {
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'אחד הקבצים גדול מ-20MB. אי אפשר לצרף אותו למייל.'
      : err.code === 'LIMIT_FILE_COUNT' ? 'אפשר לצרף עד 10 קבצים למייל אחד.'
      : `העלאת הקבצים נכשלה: ${err.message}`;
    return res.status(413).json({ error: msg });
  }
  const total = (req.files || []).reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL) return res.status(413).json({ error: 'הקבצים גדולים מדי יחד (מעל 24MB). Gmail לא יאפשר לשלוח אותם במייל אחד.' });
  next();
});

// העברה למנהל – עם הערה ומסמכים (אופציונלי)
app.post('/api/inquiries/:id/escalate', uploadFiles, h(req => engine.escalate(req.params.id, req.user, String(req.body.note || '').trim(), (req.files || []).map(f => ({
  name: Buffer.from(f.originalname, 'latin1').toString('utf8'), type: f.mimetype, size: f.size, buffer: f.buffer,
})))));
app.post('/api/inquiries/:id/reply', uploadFiles, h(req => {
  const body = (req.body.body || '').trim();
  if (!body) throw new AppError(400, 'אי אפשר לשלוח מענה ריק');
  const files = (req.files || []).map(f => ({
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'), type: f.mimetype, size: f.size, buffer: f.buffer,
  }));
  return engine.reply(req.params.id, req.user, body, files, req.body.to, req.body.track === '1');
}));

app.get('/api/attachments/:id', async (req, res) => {
  try {
    const a = await engine.attachment(req.params.id, req.user);
    // ?view=1 – פתיחה בדפדפן בלי הורדה. רק סוגים בטוחים (תמונות, PDF, טקסט); השאר תמיד כהורדה.
    const type = String(a.type || 'application/octet-stream').toLowerCase();
    const viewable = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/.test(type);
    const mode = req.query.view && viewable ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${mode}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (type !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(type === 'text/plain' ? 'text/plain; charset=utf-8' : type).send(a.content);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// כלי בדיקה – רק במצב fake מקומי
if (provider.name === 'fake') {
  app.post('/api/test/incoming', h(async req => {
    const { threadId, name, email, subject, text } = req.body;
    if (threadId) {
      const t = engine.get(threadId);
      const li = t.lastIn;
      return provider.incoming({ name: t.fromName, email: t.fromEmail, subject: 'Re: ' + t.subject, text: text || 'תודה!', inReplyTo: li.messageId, references: [...li.references, li.messageId] });
    }
    return provider.incoming({ name, email, subject, text });
  }));
  // מייל גולמי (base64) – לבדיקת ייבוא
  app.post('/api/test/raw', h(async req => { await provider.add(Buffer.from(req.body.raw, 'base64'), ['\\Inbox']); return { ok: true }; }));
}

app.listen(config.PORT, () => {
  console.log(`דשבורד הפניות רץ על פורט ${config.PORT} (ספק: ${provider.name}, צוות מ-TEAM_USERS: ${config.TEAM.map(u => u.name).join(', ') || 'לא הוגדר'})`);
  provider.start().catch(e => console.error('[start]', e));
});
