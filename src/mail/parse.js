// המרת מייל גולמי (MIME) לרשומה שהמערכת עובדת איתה.
const { simpleParser } = require('mailparser');

// מפריד בין הטקסט החדש לבין ההודעה המצוטטת (תשובה על מייל קודם)
const QUOTE_MARKERS = [
  /^\s*(בתאריך|ב-?\s?\d).{0,120}(מאת|כתב\/ה|כתבה|כתב|<[^>]+@[^>]+>)\s*:?\s*$/m,
  /^\s*On .{0,200}wrote:\s*$/m,
  /^\s*-{2,}\s*(Original Message|הודעה מקורית|Forwarded message|הודעה שהועברה)\s*-{2,}/mi,
  /^\s*(From|מאת)\s*:\s*.+\n\s*(Sent|Date|נשלח|תאריך)\s*:/mi,
  /^_{10,}\s*$/m,
];

function splitQuoted(text) {
  text = (text || '').replace(/\r\n/g, '\n').replace(/‏|‎|‫|‬|‪/g, '');
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  // שורות שמתחילות ב-> ברצף עד הסוף
  const gt = text.search(/\n(>.*\n?)+\s*$/);
  if (gt >= 0 && (cut < 0 || gt < cut)) cut = gt;
  if (cut <= 0) return { body: text.trim(), quoted: null };
  const body = text.slice(0, cut).trim();
  const quoted = text.slice(cut).trim();
  if (!body) return { body: text.trim(), quoted: null };
  return { body, quoted };
}

// אם מייל הועבר ידנית (Fwd) מכתובת מעבירה – חילוץ הפונה המקורי מתוך הגוף
function extractForwardedSender(text) {
  const m = /(?:^|\n)\s*(?:From|מאת)\s*:\s*(?:"?([^"<\n]*?)"?\s*)?<?([\w.+-]+@[\w.-]+\.\w+)>?/i.exec(text || '');
  if (!m) return null;
  return { name: (m[1] || '').trim() || m[2], address: m[2].toLowerCase() };
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
