// קבצים מצורפים – חיסכון בזיכרון
// כל קובץ דורש להוריד ולפענח את כל המייל. בלי זה, פניה עם 5 תמונות מורידה את אותו מייל 5 פעמים במקביל,
// וכמה מיילים כבדים יחד חורגים מהזיכרון של השרת (Buffers לא נספרים ב-max-old-space-size).
// לכן: (1) לכל מייל – הורדה ופענוח פעם אחת, ובקשות במקביל לאותו מייל מחכות לאותה הורדה;
//      (2) לכל היותר MAX_PARALLEL מיילים בהורדה בו-זמנית;
//      (3) הקבצים המפוענחים נשמרים לזמן קצר, עם תקרת גודל כוללת.

const MAX_PARALLEL = 2;
const MAX_BYTES = 40 * 1024 * 1024;  // תקרה לכל השמירה
const MAX_ONE = 15 * 1024 * 1024;    // מייל גדול מזה – לא נשמר (רק מוגש)
const TTL = 3 * 60e3;

let running = 0;
const waiting = [];
function acquire() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise(r => waiting.push(r));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

const cache = new Map();    // uid -> { list, bytes, at }
const inflight = new Map(); // uid -> Promise<list>
let total = 0;

function drop(uid) {
  const e = cache.get(uid);
  if (e) { total -= e.bytes; cache.delete(uid); }
}
function prune() {
  const now = Date.now();
  for (const [uid, e] of cache) if (now - e.at > TTL) drop(uid);
  // הישן ביותר יוצא ראשון (Map שומר סדר הכנסה; שימוש מחדש מזיז לסוף)
  for (const uid of cache.keys()) { if (total <= MAX_BYTES) break; drop(uid); }
}
setInterval(prune, 60e3).unref();

// load(uid) => Promise<[{name,type,content}]> – הורדה + פענוח של כל הקבצים במייל
async function get(uid, load) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at <= TTL) {
    cache.delete(uid); cache.set(uid, hit); // מזיז לסוף
    return hit.list;
  }
  if (inflight.has(uid)) return inflight.get(uid);
  const p = (async () => {
    await acquire();
    try {
      const list = await load(uid);
      const bytes = list.reduce((s, a) => s + ((a.content && a.content.length) || 0), 0);
      if (bytes <= MAX_ONE) {
        drop(uid);
        cache.set(uid, { list, bytes, at: Date.now() });
        total += bytes;
        prune();
      }
      return list;
    } finally {
      release();
      inflight.delete(uid);
    }
  })();
  inflight.set(uid, p);
  return p;
}

module.exports = { get, _state: () => ({ running, waiting: waiting.length, cached: cache.size, total }) };
