const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const config = require('./src/config');
const { Engine, AppError } = require('./src/engine');

const Provider = config.MAIL_PROVIDER === 'fake' ? require('./src/mail/fake') : require('./src/mail/gmail');
const provider = new Provider();
const engine = new Engine(provider);

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

function readSession(req) {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!c) return null;
  const [key, exp, sig] = decodeURIComponent(c.slice(COOKIE.length + 1)).split('.');
  if (!key || !exp || !sig || sign(`${key}.${exp}`) !== sig || +exp < Date.now()) return null;
  return config.TEAM.find(u => u.key === key) || null;
}

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' });
  const u = config.TEAM.find(x => x.key === req.body.key);
  const ok = u && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(req.body.password || '')).digest(),
    crypto.createHash('sha256').update(u.password).digest());
  if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'סיסמה שגויה' }); }
  attempts.delete(ip);
  const exp = Date.now() + MAX_AGE;
  const val = `${u.key}.${exp}.${sign(`${u.key}.${exp}`)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ key: u.key, name: u.name });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// מידע ציבורי: רק שמות הצוות (לבחירה במסך הכניסה)
app.get('/api/public', (req, res) => {
  res.json({ team: config.TEAM.map(u => ({ key: u.key, name: u.name })), me: readSession(req) && { key: readSession(req).key, name: readSession(req).name } });
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

app.get('/api/config', h(req => ({
  me: { key: req.user.key, name: req.user.name },
  team: config.TEAM.map(u => ({ key: u.key, name: u.name })),
  categories: config.CATEGORIES,
  inbox: provider.address, manager: config.MANAGER_EMAIL,
})));

app.get('/api/status', h(() => ({ ...provider.status, provider: provider.name, configured: provider.configured() })));

app.get('/api/inquiries', h(req => ({
  items: engine.list(req.query, req.user), counts: engine.counts(req.user), status: provider.status,
})));

app.get('/api/inquiries/:id', h(req => engine.detail(engine.get(req.params.id))));
app.post('/api/inquiries/:id/take', h(req => engine.take(req.params.id, req.user)));
app.post('/api/inquiries/:id/release', h(req => engine.release(req.params.id, req.user)));
app.post('/api/inquiries/:id/handled', h(req => engine.markHandled(req.params.id, req.user)));
app.post('/api/inquiries/:id/reopen', h(req => engine.reopen(req.params.id, req.user)));
app.post('/api/inquiries/:id/ignore', h(req => engine.ignore(req.params.id, req.user)));
app.post('/api/inquiries/:id/categories', h(req => engine.setCategories(req.params.id, req.body.categories || [], req.user)));
app.post('/api/inquiries/:id/escalate', h(req => engine.escalate(req.params.id, req.user, (req.body.note || '').trim())));
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

app.post('/api/inquiries/:id/reply', uploadFiles, h(req => {
  const body = (req.body.body || '').trim();
  if (!body) throw new AppError(400, 'אי אפשר לשלוח מענה ריק');
  const files = (req.files || []).map(f => ({
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'), type: f.mimetype, size: f.size, buffer: f.buffer,
  }));
  return engine.reply(req.params.id, req.user, body, files);
}));

app.get('/api/attachments/:id', async (req, res) => {
  try {
    const a = await engine.attachment(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    res.type(a.type || 'application/octet-stream').send(a.content);
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
  console.log(`דשבורד הפניות רץ על פורט ${config.PORT} (ספק: ${provider.name}, צוות: ${config.TEAM.map(u => u.name).join(', ') || 'לא הוגדר'})`);
  provider.start().catch(e => console.error('[start]', e));
});
