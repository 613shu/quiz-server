// העברת כל תוכן תיבת הדשבורד (GMAIL_USER) לתיבה חדשה – כולל תוויות KOH/..., "נשלחו" ויומן הפעולות.
//
// הפעלה (ב-Render → Shell):
//   TO_USER=israel.support@kerenolamhatorah.org node migrate.js
//   (הסקריפט ישאל את סיסמת האפליקציה של התיבה החדשה. אפשר גם TO_PASS=... מראש)
//
// אפשרויות:  --dry-run   רק לספור מה יועתק, בלי לשנות כלום
//            --no-state  לא להעתיק את יומן הפעולות
//            --since=YYYY-MM-DD  רק הודעות שהגיעו לתיבה מהתאריך הזה והלאה, + כל הודעות הייבוא מאאוטלוק
//                                + כל הודעה עם תווית KOH/..., וכל שרשור שיש בו הודעה כזו
//
// בטוח להריץ שוב ושוב: כל הודעה מסומנת בכותרת X-KOH-Migrate-Id, ובהרצה חוזרת מועתקות רק הודעות חדשות
// והתוויות מסונכרנות לפי תיבת המקור. התיבה הישנה לא משתנה בכלל (נפתחת לקריאה בלבד).
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const readline = require('readline');
const config = require('./src/config');

const STATE_BOX = 'KOH-System';
const MIG = 'x-koh-migrate-id';
const KEEP_SYS = ['\\Inbox', '\\Starred', '\\Important'];   // תוויות מערכת שמועתקות (\Sent נקבע לפי תיקיית היעד)
const KEEP_FLAGS = ['\\Seen', '\\Flagged', '\\Answered'];
const log = (...a) => console.log(...a);

function hdr(buf, name) {
  if (!buf) return null;
  const s = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(s);
  return m ? m[1].trim() : null;
}

async function index(c, box, readOnly = false) {
  await c.mailboxOpen(box, { readOnly });
  const out = [];
  if (!c.mailbox.exists) return out;
  for await (const m of c.fetch('1:*', {
    uid: true, labels: true, flags: true, threadId: true, internalDate: true, size: true, envelope: true,
    headers: ['x-koh-import', 'x-koh-system', MIG],
  }, { uid: true })) {
    out.push({
      uid: m.uid, size: m.size || 0, threadId: m.threadId ? String(m.threadId) : null,
      labels: new Set(m.labels || []), flags: new Set(m.flags || []),
      date: m.internalDate ? new Date(m.internalDate) : null,
      messageId: (m.envelope && m.envelope.messageId) || null,
      importTag: hdr(m.headers, 'x-koh-import'), system: hdr(m.headers, 'x-koh-system'), mig: hdr(m.headers, MIG),
    });
  }
  return out;
}

const specialOf = (boxes, flag) => (boxes.find(b => b.specialUse === flag) || {}).path;
const wantedLabels = m => [...m.labels].filter(l => !l.startsWith('\\') || KEEP_SYS.includes(l));
const managed = l => !l.startsWith('\\') || KEEP_SYS.includes(l);

async function run(src, dst, opts = {}) {
  const dry = !!opts.dryRun;
  const srcBoxes = await src.list(), dstBoxes = await dst.list();
  const srcAll = specialOf(srcBoxes, '\\All');
  const dstAll = specialOf(dstBoxes, '\\All'), dstSent = specialOf(dstBoxes, '\\Sent'), dstTrash = specialOf(dstBoxes, '\\Trash');
  if (!srcAll || !dstAll) throw new Error('לא נמצאה תיקיית "כל הדואר" – ודאו ש-IMAP מופעל בשתי התיבות');

  log('סורק את התיבה הישנה...');
  const srcMsgs = await index(src, srcAll, true);
  const srcValidity = String(src.mailbox.uidValidity);
  const migId = m => `${srcValidity}-${m.uid}`;
  const stateMsgs = srcMsgs.filter(m => m.system === 'state');
  const skipped = { state: stateMsgs.length, importDone: 0, draft: 0 };
  let todo = srcMsgs.filter(m => {
    if (m.system === 'state') return false;
    if (m.labels.has('KOH/imported')) { skipped.importDone++; return false; }   // מיילי בקשת ייבוא שכבר עובדו
    if (m.labels.has('\\Draft')) { skipped.draft++; return false; }
    return true;
  });
  let oldNote = '';
  if (opts.since) {
    // הודעה רלוונטית: הגיעה מאז התאריך, או יובאה מאאוטלוק, או מסומנת KOH/... – ואיתה כל השרשור שלה
    const rel = m => m.importTag || (m.date && m.date >= opts.since) || [...m.labels].some(l => l.startsWith('KOH'));
    const threads = new Set(todo.filter(rel).map(m => m.threadId).filter(Boolean));
    const before = todo.length;
    todo = todo.filter(m => rel(m) || (m.threadId && threads.has(m.threadId)));
    oldNote = `, ${before - todo.length} הודעות ישנות שלא קשורות לקרן`;
    log(`מסנן: רק מ-${opts.since.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })} + ייבוא מאאוטלוק + תוויות KOH`);
  }
  log(`בתיבה הישנה: ${srcMsgs.length} הודעות (${todo.length} להעברה; דולגו: ${skipped.importDone} בקשות ייבוא שכבר עובדו, ${skipped.state} יומן, ${skipped.draft} טיוטות${oldNote})`);

  // התאמה בין הודעת מקור להודעה ביעד: לפי הכותרת שהסקריפט מוסיף, או הודעה שהגיעה ליעד בעצמה (אותו Message-ID)
  const match = dstMsgs => {
    const byMig = new Map(), native = new Map();
    for (const d of dstMsgs) {
      if (d.mig) byMig.set(d.mig, d);
      else if (d.messageId && !d.system) {
        const k = `${d.messageId}|${d.importTag || ''}`;
        if (!native.has(k)) native.set(k, []);
        native.get(k).push(d);
      }
    }
    const res = new Map();
    for (const m of todo) {
      let d = byMig.get(migId(m));
      if (!d && m.messageId) { const l = native.get(`${m.messageId}|${m.importTag || ''}`); if (l && l.length) d = l.shift(); }
      if (d) res.set(m.uid, d);
    }
    return res;
  };

  log('סורק את התיבה החדשה...');
  let dstMsgs = await index(dst, dstAll);
  let found = match(dstMsgs);
  const missing = todo.filter(m => !found.has(m.uid));
  const mb = n => (n / 1048576).toFixed(1);
  log(`בתיבה החדשה כבר קיימות ${found.size}. להעתקה: ${missing.length} הודעות (${mb(missing.reduce((s, m) => s + m.size, 0))}MB)`);

  // שלב 1: העתקת הודעות חסרות
  let copied = 0, failed = 0, inARow = 0;
  if (!dry && missing.length) {
    const queue = [...missing];
    while (queue.length) {
      const batch = [];
      let bytes = 0;
      while (queue.length && batch.length < 25 && (!batch.length || bytes + queue[0].size <= 20 * 1048576)) { bytes += queue[0].size; batch.push(queue.shift()); }
      const raws = new Map();
      for await (const f of src.fetch(batch.map(m => m.uid).join(','), { uid: true, source: true }, { uid: true })) raws.set(f.uid, f.source);
      for (const m of batch) {
        const raw = raws.get(m.uid);
        if (!raw) { failed++; log(`  ✗ הודעה ${m.uid}: לא ירדה מהתיבה הישנה`); continue; }
        const box = m.labels.has('\\Sent') && dstSent ? dstSent : m.labels.has('\\Inbox') ? 'INBOX' : dstAll;
        try {
          await dst.append(box, Buffer.concat([Buffer.from(`X-KOH-Migrate-Id: ${migId(m)}\r\n`), raw]),
            [...m.flags].filter(f => KEEP_FLAGS.includes(f)), m.date || undefined);
          copied++; inARow = 0;
        } catch (e) {
          failed++; inARow++;
          log(`  ✗ הודעה ${m.uid}: ${e.responseText || e.message}`);
          if (inARow >= 5) throw new Error('5 כשלונות ברצף – עוצרים. ייתכן שג׳ימייל הגביל את כמות ההעלאה היומית; אפשר להריץ שוב מאוחר יותר והסקריפט ימשיך מאיפה שעצר.');
        }
      }
      log(`  הועתקו ${copied}/${missing.length}${failed ? ` (נכשלו ${failed})` : ''}`);
    }
  }

  // שלב 2: סנכרון תוויות וסימונים לפי תיבת המקור
  if (!dry && copied) { dstMsgs = await index(dst, dstAll); found = match(dstMsgs); }
  else await dst.mailboxOpen(dstAll);
  const add = new Map(), rem = new Map(), push = (map, key, uid) => { if (!map.has(key)) map.set(key, []); map.get(key).push(uid); };
  for (const m of todo) {
    const d = found.get(m.uid);
    if (!d) continue;
    const want = new Set(wantedLabels(m));
    for (const l of want) if (!d.labels.has(l)) push(add, 'L' + l, d.uid);
    for (const l of d.labels) if (managed(l) && !want.has(l) && (l.startsWith('KOH') || KEEP_SYS.includes(l))) push(rem, 'L' + l, d.uid);
    for (const f of KEEP_FLAGS) {
      if (m.flags.has(f) && !d.flags.has(f)) push(add, 'F' + f, d.uid);
      if (!m.flags.has(f) && d.flags.has(f)) push(rem, 'F' + f, d.uid);
    }
  }
  const changes = [...add.values(), ...rem.values()].reduce((s, l) => s + l.length, 0);
  log(`סנכרון תוויות: ${changes} שינויים`);
  if (!dry && changes) {
    const existing = new Set((await dst.list()).map(b => b.path));
    for (const k of add.keys()) if (k[0] === 'L' && !k.startsWith('L\\') && !existing.has(k.slice(1))) await dst.mailboxCreate(k.slice(1)).catch(() => {});
    const apply = async (map, fn) => {
      for (const [k, uids] of map) {
        for (let i = 0; i < uids.length; i += 300) {
          const range = uids.slice(i, i + 300).join(',');
          await fn(range, [k.slice(1)], k[0] === 'L' ? { uid: true, useLabels: true } : { uid: true });
        }
      }
    };
    await apply(add, (r, v, o) => dst.messageFlagsAdd(r, v, o));
    await apply(rem, (r, v, o) => dst.messageFlagsRemove(r, v, o));
  }

  // שלב 3: יומן הפעולות – מזהי השרשורים משתנים בתיבה חדשה, אז ממירים אותם
  let stateNote = 'לא הועתק';
  if (!opts.noState && stateMsgs.length) {
    const newest = stateMsgs.sort((a, b) => b.uid - a.uid)[0];
    const f = await src.fetchOne(String(newest.uid), { source: true }, { uid: true });
    let state = null;
    try { state = JSON.parse((await simpleParser(f.source)).text); } catch { /* */ }
    const dstState = dstMsgs.filter(d => d.system === 'state').sort((a, b) => b.uid - a.uid);
    let dstOwn = true;       // אם הדשבורד כבר כתב יומן בתיבה החדשה – לא דורסים אותו
    if (dstState.length) {
      const g = await dst.fetchOne(String(dstState[0].uid), { source: true }, { uid: true });
      try { dstOwn = !!JSON.parse((await simpleParser(g.source)).text).migratedFrom; } catch { dstOwn = false; }
    }
    if (!state || !Array.isArray(state.log)) stateNote = 'היומן בתיבה הישנה לא נקרא – דולג';
    else if (!dstOwn) stateNote = 'בתיבה החדשה כבר יש יומן של הדשבורד – לא נדרס';
    else {
      const tmap = new Map();   // מזהה שרשור ישן -> חדש, לפי ההודעה החיה הראשונה בשרשור
      const sorted = todo.filter(m => m.threadId && found.get(m.uid)).sort((a, b) => (!!a.importTag - !!b.importTag) || (a.date - b.date));
      for (const m of sorted) if (!tmap.has(m.threadId) && found.get(m.uid).threadId) tmap.set(m.threadId, found.get(m.uid).threadId);
      let mapped = 0;
      const newLog = state.log.map(e => { const t = tmap.get(String(e.t)); if (t) mapped++; return t ? { ...e, t } : e; });
      const obj = { ...state, log: newLog, migratedFrom: config.GMAIL_USER, migratedAt: new Date().toISOString() };
      stateNote = `${newLog.length} רשומות (${mapped} הומרו לשרשורים החדשים)`;
      if (!dry) {
        const raw = [
          `From: "KOH System" <${opts.toUser}>`, `To: <${opts.toUser}>`,
          'Subject: KOH dashboard state (do not delete)', 'X-KOH-System: state',
          `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
          Buffer.from(JSON.stringify(obj)).toString('base64').replace(/.{76}/g, '$&\r\n'),
        ].join('\r\n');
        if (!(await dst.list()).some(b => b.path === STATE_BOX)) await dst.mailboxCreate(STATE_BOX).catch(() => {});
        await dst.append(STATE_BOX, raw, ['\\Seen']);
        if (dstState.length && dstTrash) { await dst.mailboxOpen(dstAll); await dst.messageMove(dstState.map(d => d.uid).join(','), dstTrash, { uid: true }).catch(() => {}); }
      }
    }
  }

  const summary = { total: todo.length, alreadyThere: todo.length - missing.length, copied, failed, labelChanges: changes, state: stateNote, dry };
  log('\n=== סיכום ===');
  log(`${dry ? '(בדיקה בלבד – לא שונה כלום)\n' : ''}הודעות להעברה: ${todo.length}\nכבר היו בתיבה החדשה: ${summary.alreadyThere}\nהועתקו עכשיו: ${copied}\nנכשלו: ${failed}\nשינויי תוויות: ${changes}\nיומן פעולות: ${stateNote}`);
  if (failed) log('יש הודעות שנכשלו – הריצו שוב את אותה פקודה, הסקריפט ינסה רק אותן.');
  else if (!dry) log('✔ הכול הועבר. אפשר להריץ שוב בכל זמן כדי להשלים הודעות חדשות.');
  return summary;
}

const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a); }); });

async function main() {
  const argv = process.argv.slice(2);
  const toUser = (process.env.TO_USER || '').trim().toLowerCase();
  if (!toUser) throw new Error('חסר TO_USER. לדוגמה:  TO_USER=israel.support@kerenolamhatorah.org node migrate.js');
  if (!config.GMAIL_APP_PASSWORD) throw new Error('חסרה GMAIL_APP_PASSWORD של התיבה הישנה');
  if (toUser === config.GMAIL_USER) throw new Error(`התיבה החדשה זהה לישנה (${toUser}) – האם GMAIL_USER כבר שונה ב-Render? הריצו לפני השינוי.`);
  const toPass = (process.env.TO_PASS || await ask(`סיסמת האפליקציה של ${toUser}: `)).replace(/\s+/g, '');
  log(`מעתיק מ-${config.GMAIL_USER}  ←  אל ${toUser}`);
  const mk = (user, pass) => new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  const src = mk(config.GMAIL_USER, config.GMAIL_APP_PASSWORD), dst = mk(toUser, toPass);
  try {
    await src.connect().catch(e => { throw new Error(`ההתחברות לתיבה הישנה נכשלה: ${e.responseText || e.message}`); });
    await dst.connect().catch(e => { throw new Error(`ההתחברות ל-${toUser} נכשלה – בדקו את סיסמת האפליקציה ושה-IMAP מופעל: ${e.responseText || e.message}`); });
    const sinceArg = (argv.find(a => a.startsWith('--since=')) || '').slice(8) || process.env.MIGRATE_SINCE || '';
    let since = null;
    if (sinceArg) { since = new Date(sinceArg + 'T00:00:00+03:00'); if (isNaN(since)) throw new Error(`תאריך לא תקין: ${sinceArg} (צריך YYYY-MM-DD)`); }
    await run(src, dst, { dryRun: argv.includes('--dry-run'), noState: argv.includes('--no-state'), toUser, since });
  } finally {
    await src.logout().catch(() => {}); await dst.logout().catch(() => {});
  }
}

if (require.main === module) main().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
module.exports = { run };
