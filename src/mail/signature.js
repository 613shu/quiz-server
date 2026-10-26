// חתימה (תמונה) בתחתית כל מייל שיוצא ללקוח מהדשבורד – תשובה ומייל חדש.
// התמונה מוטבעת בגוף המייל (cid), לא כקובץ מצורף. בדשבורד עצמו היא לא מוצגת כקובץ.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'assets', 'signature.png');
const CID = 'koh-signature@koh.org.il';
const NAME = 'koh-signature.png';

let content = null;
let hash = null;
try {
  content = fs.readFileSync(FILE);
  hash = crypto.createHash('sha256').update(content).digest('hex');
} catch (e) {
  console.error('[signature] קובץ החתימה לא נמצא – המיילים יישלחו בלי חתימה:', e.message);
}

// HTML להוספה אחרי גוף ההודעה (לפני הציטוט)
function html() {
  if (!content) return '';
  return `<br><div dir="rtl" style="text-align:right"><img src="cid:${CID}" alt="קרן עולם התורה" width="500" style="width:500px;max-width:100%;height:auto;border:0;display:block"></div>`;
}

function attachment() {
  if (!content) return [];
  return [{ filename: NAME, content, contentType: 'image/png', cid: CID, contentDisposition: 'inline' }];
}

// האם חלק בהודעה הוא תמונת החתימה (גם כשהלקוח משיב וג'ימייל/אאוטלוק מצטטים אותה)
function isSignature(a) {
  if (!a) return false;
  const cid = String(a.cid || a.contentId || '').replace(/[<>]/g, '').toLowerCase();
  if (cid === CID) return true;
  if ((a.filename || '').toLowerCase() === NAME) return true;
  if (hash && a.content && Buffer.isBuffer(a.content) && a.content.length === content.length) {
    return crypto.createHash('sha256').update(a.content).digest('hex') === hash;
  }
  return false;
}

module.exports = { html, attachment, isSignature };
