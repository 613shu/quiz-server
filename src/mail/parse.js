// המרת מייל גולמי (MIME) לרשומה שהמערכת עובדת איתה.
const { simpleParser } = require('mailparser');

// מפריד בין הטקסט החדש לבין ההודעה המצוטטת (תשובה על מייל קודם)
// (בלי \s שחוצה שורות ובלי חזרות מקוננות – כדי שמייל ארוך לא יקפיא את השרת)
const QUOTE_MARKERS = [
  /^[ \t]*(בתאריך|ב-?[ \t]?\d).{0,120}(מאת|כתב\/ה|כתבה|כתב|<[^>\n]{1,200}@[^>\n]{1,200}>)[ \t]*:?[ \t]*$/m,
  /^[ \t]*On .{0,200}wrote:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*(Original Message|הודעה מקורית|Forwarded message|הודעה שהועברה)[ \t]*-{2,}/mi,
  /^[ \t]*(From|מאת)[ \t]*:[^\n]+\n[ \t]*(Sent|Date|נשלח|תאריך)[ \t]*:/mi,
  /^_{10,}[ \t]*$/m,
];

// מיקום ה-\n שלפני גוש השורות המצוטטות (>) שבסוף הטקסט, או -1
function trailingQuoteIndex(text) {
  const lines = text.split('\n');
  let i = lines.length;
  while (i > 0 && !lines[i - 1].trim()) i--;
  let j = i;
  while (j > 0 && lines[j - 1].startsWith('>')) j--;
  if (j === i) return -1;
  if (j === 0) return i >= 2 ? lines[0].length : -1;   // הכול מצוטט – כמו ההתנהגות הקודמת
  let pos = -1;
  for (let k = 0; k < j; k++) pos += lines[k].length + 1;
  return pos;
}

function splitQuoted(text) {
  text = (text || '').replace(/\r\n/g, '\n').replace(/[\u200e\u200f\u202a\u202b\u202c]/g, '');
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  // שורות שמתחילות ב-> ברצף עד הסוף (סריקת שורות – ביטוי רגולרי כאן נתקע על מיילים מסוימים ומקפיא את השרת)
  const gt = trailingQuoteIndex(text);
  if (gt >= 0 && (cut < 0 || gt < cut)) cut = gt;
  if (cut <= 0) return { body: text.trim(), quoted: null };
  const body = text.slice(0, cut).trim();
  const quoted = text.slice(cut).trim();
  if (!body) return { body: text.trim(), quoted: null };
  return { body, quoted };
}

// אם מייל הועבר ידנית (Fwd) מכתובת מעבירה – חילוץ הפונה המקורי מתוך הגוף
function extractForwardedSender(text) {
  // שורת From/מאת הראשונה, ואז חילוץ הכתובת מתוכה (בשלבים – בלי ביטוי רגולרי שיכול להיתקע)
  const line = /^[ \t]*(?:From|מאת)[ \t]*:([^\n]*)/im.exec(text || '');
  if (!line) return null;
  const rest = line[1].slice(0, 400);
  const em = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,6}/.exec(rest);
  if (!em) return null;
  const name = rest.slice(0, em.index).replace(/[<"\s]+$/, '').replace(/^[\s"]+/, '').trim();
  if (/[<"]/.test(name)) return null;
  return { name: name || em[0], address: em[0].toLowerCase() };
}

const addr = a => (a && a.value && a.value[0]) ? { name: a.value[0].name || a.value[0].address, address: (a.value[0].address || '').toLowerCase() } : { name: '', address: '' };

async function parseRaw(raw, meta = {}) {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  let text = p.text || '';
  if (!text && p.html) text = String(p.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const { body, quoted } = splitQuoted(text);
  const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
  const h = k => { const v = p.headers.get(k); return v == null ? null : String(v); };
  return {
    uid: meta.uid,
    threadId: meta.threadId ? String(meta.threadId) : null,
    labels: new Set(meta.labels || []),
    date: (p.date || meta.internalDate || new Date()).toISOString(),
    messageId: p.messageId || null,
    inReplyTo: p.inReplyTo || null,
    references: refs,
    from: addr(p.from),
    replyTo: p.replyTo ? addr(p.replyTo) : null,
    to: [p.to, p.cc].filter(Boolean).flatMap(x => [].concat(x)).flatMap(t => t.value).map(v => (v.address || '').toLowerCase()),
    subject: p.subject || '(ללא נושא)',
    body, quoted, fullText: text,
    route: [h('return-path'), h('x-forwarded-for'), h('x-forwarded-to'), h('x-original-to'), h('delivered-to')].filter(Boolean).join(' ').toLowerCase(),
    author: h('x-koh-author'),
    system: h('x-koh-system'),
    imported: !!h('x-koh-import'),
    attachments: (p.attachments || []).filter(a => !a.related || a.contentDisposition === 'attachment').map((a, i) => ({
      index: i, name: a.filename || `קובץ-${i + 1}`, type: a.contentType, size: a.size,
    })),
  };
}

async function extractAttachment(raw, index) {
  const p = await simpleParser(raw);
  const list = (p.attachments || []).filter(a => !a.related || a.contentDisposition === 'attachment');
  const a = list[index];
  if (!a) return null;
  return { name: a.filename || `קובץ-${index + 1}`, type: a.contentType, content: a.content };
}

async function allAttachments(raw) {
  const p = await simpleParser(raw);
  return (p.attachments || []).filter(a => !a.related || a.contentDisposition === 'attachment')
    .map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content }));
}

module.exports = { parseRaw, splitQuoted, extractForwardedSender, extractAttachment, allAttachments };
