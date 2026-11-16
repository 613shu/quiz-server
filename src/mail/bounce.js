// זיהוי "מייל חוזר" (הודעת אי-מסירה / Bounce / DSN) ושיוכו למייל המקורי שנשלח מהדשבורד.
// כשהמייל לא מגיע ליעד (כתובת שגויה, תיבה מלאה, חסימה) – שרת המייל שולח בחזרה הודעה מ-mailer-daemon / postmaster.
// כאן מחלצים ממנה: איזה מייל חזר (Message-ID מקורי), לאיזו כתובת, וקוד הסיבה.
// (בלי ביטויים רגולריים עם חזרות מקוננות – סריקת שורות בלבד)

const DAEMON_RE = /^(mailer-daemon|mail-daemon|mailerdaemon|postmaster|mdaemon|mail\.delivery|maildelivery|bounce|bounces)([+._-][^@]*)?@/i;
const DAEMON_NAME_RE = /mail delivery|mailer-daemon|postmaster|delivery subsystem|מערכת מסירת הדואר/i;
const FAIL_SUBJ_RE = /delivery status notification \(failure\)|undeliverable|undelivered|delivery failure|delivery has failed|failure notice|returned mail|mail delivery failed|could not be delivered|delivery incomplete|message not delivered|not delivered|non[- ]?delivery|rejected|לא ניתן למסור|לא נמסר|לא ניתן היה למסור|המסירה נכשלה/i;
const DELAY_SUBJ_RE = /delivery status notification \(delay\)|delayed mail|delivery delayed|still being retried|warning: message|עיכוב במסירה|ההודעה מתעכבת/i;
const REPORT_TYPES = ['message/rfc822', 'message/delivery-status', 'text/rfc822-headers', 'message/global', 'message/global-headers', 'message/global-delivery-status'];
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,6}/g;

function lines(text) { return String(text || '').slice(0, 200000).replace(/\r\n/g, '\n').split('\n'); }

// p = תוצאת simpleParser, text = טקסט ההודעה
function detect(p, text) {
  const from = ((p.from && p.from.value && p.from.value[0]) || {});
  const fromAddr = String(from.address || '').toLowerCase();
  const fromName = String(from.name || '');
  const ct = p.headers.get('content-type');
  const isReport = !!(ct && ct.value === 'multipart/report' && ct.params && /delivery-status/i.test(ct.params['report-type'] || ''));
  const subject = String(p.subject || '');
  const daemon = DAEMON_RE.test(fromAddr) || DAEMON_NAME_RE.test(fromName);
  const failSubj = FAIL_SUBJ_RE.test(subject), delaySubj = DELAY_SUBJ_RE.test(subject);
  if (!isReport && !(daemon && (failSubj || delaySubj))) return null;

  // מקורות לחיפוש: גוף ההודעה + החלקים המצורפים של הדוח (המייל המקורי / הכותרות שלו / פרטי המסירה)
  const sources = [text || ''];
  for (const a of p.attachments || []) {
    if (REPORT_TYPES.includes(String(a.contentType || '').toLowerCase()) && a.content) sources.push(a.content.slice(0, 200000).toString('utf8'));
  }
  const own = p.messageId || '';
  const mids = new Set(), recipients = new Set(), candidates = new Set();
  let status = null, diag = null, action = null;
  const xf = p.headers.get('x-failed-recipients');
  if (xf) String(xf).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(a => recipients.add(a));
  for (const ref of [p.inReplyTo, ...[].concat(p.references || [])]) if (ref && ref !== own) mids.add(ref);

  for (const src of sources) {
    const ls = lines(src);
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      let m;
      if ((m = /^Message-ID:[ \t]*(<[^>\s]{1,250}>)/i.exec(l)) && m[1] !== own) mids.add(m[1]);
      else if ((m = /^(?:Final|Original)-Recipient:[ \t]*rfc822;[ \t]*<?([^\s;<>]{3,254})/i.exec(l))) recipients.add(m[1].toLowerCase());
      else if (!status && (m = /^Status:[ \t]*([245]\.\d{1,3}\.\d{1,3})/i.exec(l))) status = m[1];
      else if (!action && (m = /^Action:[ \t]*(failed|delayed|delivered|relayed|expanded)/i.exec(l))) action = m[1].toLowerCase();
      else if (!diag && (m = /^Diagnostic-Code:[ \t]*([^\n]{0,300})/i.exec(l))) {
        diag = m[1];
        // שורות המשך (מתחילות ברווח)
        for (let j = i + 1; j < ls.length && j < i + 4 && /^[ \t]/.test(ls[j]); j++) diag += ' ' + ls[j].trim();
        diag = diag.slice(0, 400);
      }
    }
  }
  // כתובות שמופיעות בתחילת הגוף (הודעות בלי דוח מסודר: "Your message to x@y couldn't be delivered")
  const head = String(text || '').slice(0, 3000);
  for (const e of head.match(EMAIL_RE) || []) {
    const a = e.toLowerCase();
    if (!DAEMON_RE.test(a) && a !== fromAddr) candidates.add(a);
  }
  if (!diag) {
    // שורת הסבר קצרה מתוך הגוף (למשל "Address not found")
    const first = lines(text).map(s => s.trim()).filter(s => s.length > 3).slice(0, 6).join(' ');
    if (first) diag = first.slice(0, 400);
  }
  let kind = 'fail';
  if (action === 'delayed' || (status && status[0] === '4') || (delaySubj && !failSubj && action !== 'failed')) kind = 'delay';
  return {
    kind,
    mids: [...mids].slice(0, 20),
    recipients: [...recipients].slice(0, 20),
    candidates: [...candidates].slice(0, 20),
    status, diag,
  };
}

// הסבר בעברית למזכירה – לפי קוד הסטטוס והטקסט הטכני
function reason(b) {
  if (!b) return '';
  if (b.kind === 'delay') return 'עיכוב במסירה – שרת המייל עדיין מנסה לשלוח. אם המסירה תיכשל סופית תופיע כאן הודעה.';
  const s = b.status || '', d = String(b.diag || '').toLowerCase();
  if (s === '5.1.2' || /domain name not found|domain .{0,40}(couldn.t be found|not found|does not exist)|no such domain|host unknown|dns error|nxdomain|unrouteable/.test(d))
    return 'הדומיין של הכתובת לא קיים – כנראה טעות בחלק שאחרי ה-@.';
  if (s === '5.1.1' || s === '5.1.10' || /user unknown|no such user|does not exist|doesn.t exist|address not found|couldn.t be found|recipient not found|unknown recipient|mailbox unavailable|invalid recipient|recipient address rejected|no mailbox|not a valid|mailbox not found|address rejected/.test(d))
    return 'כתובת המייל לא קיימת – כנראה טעות בכתובת.';
  if (s === '5.2.2' || /quota|mailbox (is )?full|over quota|insufficient storage|storage limit|inbox is full/.test(d))
    return 'תיבת המייל של הנמען מלאה – המייל לא נכנס.';
  if (s === '5.3.4' || s === '5.2.3' || /too large|size limit|message size/.test(d))
    return 'המייל גדול מדי עבור שרת הנמען – נסו לשלוח בלי קבצים או עם קבצים קטנים יותר.';
  if (s === '5.2.1' || /disabled|inactive|suspended|deactivated/.test(d))
    return 'תיבת המייל של הנמען מושבתת או לא פעילה.';
  if (/^5\.7\./.test(s) || /blocked|block list|blacklist|spam|policy|denied|prohibited|not authorized|rejected|5\.7\./.test(d))
    return 'שרת הנמען חסם את המייל (סינון דואר / מדיניות חסימה).';
  return 'המייל לא הגיע ליעד.';
}

module.exports = { detect, reason };
