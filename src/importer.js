// ייבוא חד-פעמי של הודעות קיימות מאאוטלוק.
// איך משתמשים: באאוטלוק מסמנים כמה הודעות ← "העבר" (הן מצורפות כקבצים) ← שולחים לתיבת הדשבורד
// עם נושא כמו "ייבוא: טופל" או "ייבוא: אסמכתאות". המערכת מפרקת את המייל ושומרת כל הודעה
// מצורפת כפניה נפרדת – עם השולח, התאריך והקבצים המקוריים – ומסווגת לפי מה שכתוב בנושא.
const config = require('./config');

const LABEL_BOX = 'KOH/import';        // כל ההודעות המיובאות (נוח לאיתור/ביטול)
const DONE_LABEL = 'KOH/imported';     // סימון על מייל הבקשה – כדי שלא ייובא פעמיים

const norm = s => String(s || '').toLowerCase().replace(/["'׳״`‎‏]/g, '').replace(/\s+/g, ' ').trim();

// "FW: ייבוא: טופל, אסמכתאות" -> { words: ['טופל','אסמכתאות'] }
function importSubject(subject) {
  const clean = String(subject || '').replace(/^(\s*(re|fw|fwd|השב|הועבר|תשובה)\s*:\s*)+/i, '');
  const m = /^\s*(ייבוא|יבוא|import)(?=$|[\s:–-])\s*[:\-–]?\s*(.*)$/i.exec(clean);
  if (!m) return null;
  return { words: m[2].split(/[,،/+|;]| ו(?=\S)/).map(s => s.trim()).filter(Boolean) };
}

// תרגום המילים שבנושא לסטטוס + קטגוריות
function classify(words) {
  const res = { done: false, cats: [], unknown: [], labelText: [] };
  for (const w of words) {
    const n = norm(w);
    if (/^(לא טופל|לא טופלו|פתוח|פתוחות|פתוחים|חדש|חדשות|open|new)$/.test(n)) { res.labelText.push('פתוחות'); continue; }
    if (/^(טופל|טופלו|טופלה|מטופל|מטופלות|מטופלים|סגור|סגורות|done|handled)$/.test(n)) { res.done = true; res.labelText.push('טופל'); continue; }
    const cat = config.CATEGORIES.find(c => [c.name, c.key, ...(c.aliases || [])].some(a => {
      const na = norm(a);
      return na === n || (n.length >= 3 && (na.includes(n) || n.includes(na)));
    }));
    if (cat) { if (!res.cats.includes(cat.key)) res.cats.push(cat.key); res.labelText.push(cat.name); }
    else res.unknown.push(w);
  }
  return res;
}

const isMessagePart = a => /^message\/rfc822/i.test(a.type || a.contentType || '') || /\.eml$/i.test(a.name || a.filename || '');

// האם זה מייל בקשת ייבוא: נושא שמתחיל ב"ייבוא", ונשלח מכתובת מורשית או שמצורפות אליו הודעות
function isImportRequest(rec) {
  return !!(importSubject(rec.subject) && (config.IMPORT_SENDERS.includes(rec.from.address) || rec.attachments.some(isMessagePart)));
}

// האם מותר לייבא מהשולח הזה (כתובת מורשית + אימות שהמייל באמת הגיע ממנה)
function authorize(rec, raw, checkAuth) {
  const from = rec.from.address;
  if (!config.IMPORT_SENDERS.includes(from)) return `נשלח מ-${from}, שאינה כתובת מורשית לייבוא (IMPORT_SENDERS)`;
  if (checkAuth && config.IMPORT_REQUIRE_AUTH) {
    const head = raw.toString('latin1', 0, Math.min(raw.length, 64 * 1024)).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
    const ar = (head.match(/^authentication-results:.*$/gim) || []).join(' ').toLowerCase();
    if (!/\b(dmarc|dkim)=pass\b/.test(ar)) return `לא ניתן לאמת שהמייל באמת נשלח מ-${from} (אימות DMARC/DKIM נכשל)`;
  }
  return null;
}

// חילוץ ההודעות המצורפות (כל אחת כמייל גולמי שלם).
// מעבר ישיר על מבנה ה-MIME – כי mailparser "משטיח" הודעות שסומנו inline ואז הן הולכות לאיבוד.
function extractMessages(raw) {
  const out = [];
  walk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), out, 0, true);
  return out;
}

function splitPart(buf) {
  let i = buf.indexOf('\r\n\r\n'), sep = 4;
  const j = buf.indexOf('\n\n');
  if (i < 0 || (j >= 0 && j < i)) { i = j; sep = 2; }
  if (i < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) };
  return { head: buf.slice(0, i).toString('latin1'), body: buf.slice(i + sep) };
}

function header(head, name) {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'im').exec(unfolded);
  return m ? m[1].trim() : '';
}

function decode(body, cte) {
  cte = (cte || '').toLowerCase();
  if (cte === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (cte === 'quoted-printable') {
    const s = body.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return body;
}

function walk(buf, out, depth, top) {
  if (depth > 8) return;
  const { head, body } = splitPart(buf);
  const ct = header(head, 'content-type').toLowerCase();
  const disp = header(head, 'content-disposition');
  const fname = (/filename\*?=\s*"?([^";]+)"?/i.exec(disp) || /name\*?=\s*"?([^";]+)"?/i.exec(header(head, 'content-type')) || [])[1] || '';
  if (!top && (ct.startsWith('message/rfc822') || /\.eml$/i.test(fname))) {
    out.push({ name: fname, raw: decode(body, header(head, 'content-transfer-encoding')) });
    return;
  }
  if (ct.startsWith('multipart/')) {
    const b = /boundary\s*=\s*"?([^";]+)"?/i.exec(header(head, 'content-type'));
    if (!b) return;
    const parts = body.toString('latin1').split('--' + b[1]);
    for (const part of parts.slice(1)) {
      if (part.startsWith('--')) break;
      walk(Buffer.from(part.replace(/^\r?\n/, ''), 'latin1'), out, depth + 1, false);
    }
  }
}

// מוסיף כותרת שמסמנת את ההודעה כמיובאת
function markRaw(raw, reqId) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return Buffer.concat([Buffer.from(`X-KOH-Import: ${reqId}\r\n`), buf]);
}

const keyOf = r => r.messageId || `${r.date}|${r.from.address}|${r.subject}`;

// הרצת ייבוא אחד. provider צריך: messages, getRaw, appendRaw(raw, box, date), sync(), modifyLabels, status
async function runImport(provider, rec, { checkAuth = true } = {}) {
  const { parseRaw } = require('./mail/parse');
  const raw = await provider.getRaw(rec.uid);
  const report = { at: new Date().toISOString(), subject: rec.subject, from: rec.from.address, added: 0, dup: 0, failed: 0, labels: [], unknown: [], error: null };
  const reject = authorize(rec, raw, checkAuth);
  if (reject) { report.error = reject; return report; }

  const cls = classify(importSubject(rec.subject).words);
  report.labels = cls.labelText; report.unknown = cls.unknown;
  const existing = new Set([...provider.messages.values()].filter(m => !m.system).map(keyOf));
  const addedKeys = [];

  const parts = extractMessages(raw);
  if (!parts.length) { report.error = 'לא נמצאו הודעות מצורפות במייל. באאוטלוק: מסמנים כמה הודעות ולוחצים "העבר", כדי שיצורפו כקבצים.'; await provider.modifyLabels([rec.uid], [DONE_LABEL], []); return report; }
  for (const part of parts) {
    try {
      const r = await parseRaw(part.raw, {});
      const k = keyOf(r);
      if (existing.has(k)) { report.dup++; continue; }
      existing.add(k);
      await provider.appendRaw(markRaw(part.raw, rec.uid), LABEL_BOX, new Date(r.date));
      addedKeys.push(k);
      report.added++;
    } catch (e) {
      report.failed++;
      console.error('[import] הודעה לא יובאה:', part.name, e.message);
    }
  }

  // סיווג ההודעות שנוספו (תוויות "טופל" / קטגוריות)
  const add = [...(cls.done ? ['KOH/done'] : []), ...cls.cats.map(k => `KOH/cat/${k}`)];
  await provider.sync();
  await provider.sync();   // סנכרון נוסף – למקרה שהראשון כבר רץ לפני שההודעות נשמרו
  if (add.length && addedKeys.length) {
    const want = new Set(addedKeys);
    const uids = [...provider.messages.values()].filter(m => m.imported && want.has(keyOf(m))).map(m => m.uid);
    if (uids.length) await provider.modifyLabels(uids, add, []);
  }
  await provider.modifyLabels([rec.uid], [DONE_LABEL], []);
  return report;
}

// מעבר על כל בקשות הייבוא שעוד לא טופלו (נקרא אחרי כל סנכרון)
async function processImports(provider, opts) {
  if (provider.importing) { provider.importAgain = true; return; }
  provider.importing = true;
  provider.importSeen = provider.importSeen || new Set();
  try {
    do {
      provider.importAgain = false;
      const reqs = [...provider.messages.values()].filter(m => m.system === 'import-request' && !m.labels.has(DONE_LABEL) && !provider.importSeen.has(m.uid));
      for (const rec of reqs) {
        provider.importSeen.add(rec.uid);
        let report;
        try { report = await runImport(provider, rec, opts); }
        catch (e) { report = { at: new Date().toISOString(), subject: rec.subject, from: rec.from.address, added: 0, dup: 0, failed: 0, labels: [], unknown: [], error: `הייבוא נכשל: ${e.message}` }; }
        console.log('[import]', JSON.stringify(report));
        provider.status.imports = [report, ...(provider.status.imports || [])].slice(0, 20);
        provider.emit('change');
      }
    } while (provider.importAgain);
  } finally { provider.importing = false; }
}

module.exports = { importSubject, classify, isImportRequest, processImports, LABEL_BOX, DONE_LABEL };
