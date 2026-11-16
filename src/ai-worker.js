// סיווג AI ברקע: כל פניה מסווגת פעם אחת, והתוצאה נשמרת כתוויות בתיבה – לא בזיכרון.
//   KOH/cat/<key>   – הקטגוריה שה-AI בחר (אותה תווית שהצוות משנה ידנית)
//   KOH/ai          – "כבר סווג". נשאר גם אחרי תיקון ידני, כך שה-AI לא ידרוס את הצוות.
//   KOH/ai-seen     – על הודעת הלקוח האחרונה שנכללה בסיווג. מספר ההודעות עם הסימון = מספר הסבבים.
//   KOH/cat-manual  – הצוות קבע קטגוריה ידנית (engine.setCategories). מכאן ה-AI לא נוגע בפניה.
// מה נשלח: הנושא + כל הודעות הלקוח לפי הסדר (בלי תשובות צוות), אחרי התממה.
// סיווג חוזר: אם ה-AI סיווג "כללי" או "בירור תרומה" והלקוח כתב שוב – מסווגים שוב עם כל ההודעות,
// עד MAX_PASSES סבבים בסך הכול לפניה.
// בהפעלה מחדש התוויות נטענות מהתיבה, ולכן רק פניות שצריך נשלחות. בלי AI_ENABLED=1 – לא רץ בכלל.
// כשל (timeout, שגיאה) → לא מסמנים; הפניה מוצגת לפי מילות מפתח / הסיווג הקודם, וננסה שוב מאוחר יותר.
const config = require('./config');
const { redact } = require('./redact');
const ai = require('./ai-classify');

const AI_LABEL = 'KOH/ai';
const SEEN_LABEL = 'KOH/ai-seen';
const MANUAL_LABEL = 'KOH/cat-manual';
const VAGUE = new Set(['inquiry']);   // + בלי קטגוריה (= כללי)
const MAX_PASSES = 3;                 // סיווג ראשון + עד 2 חוזרים
const BATCH = 20;
const GAP_MS = 300;
const RETRY_AFTER_MS = 30 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const labelsOf = t => new Set(t.raw.flatMap(m => [...m.labels]));
const catsOf = labels => [...labels].filter(l => l.startsWith('KOH/cat/')).map(l => l.slice(8));

class AiWorker {
  constructor(engine) {
    this.e = engine;
    this.busy = false;
    this.again = false;
    this.failedAt = new Map();   // threadId → זמן כשל אחרון (בזיכרון בלבד)
    this.done = 0;
    this.redone = 0;
    const kick = () => setTimeout(() => this.kick(), 2000);
    // המרת קטגוריות שאוחדו – רץ תמיד (גם כש-AI כבוי), פעם בהפעלה, לפני הסיווג
    engine.p.on('ready', () => this.migrateCategories().catch(e => console.error('[ai] migrate:', e.message)).finally(kick));
    engine.p.on('change', kick);
  }

  customerMsgs(t) {
    return (t.raw || []).filter(m => !this.e.isOut(m) && !m.bounce);
  }

  // 'first' = עוד לא סווג, 'again' = סיווג חוזר, null = אין מה לעשות
  need(t) {
    if (t.status === 'ignored' || t.bounceOrphan || t.categories.includes('system')) return null;
    const msgs = this.customerMsgs(t);
    if (!msgs.length) return null;
    const labels = labelsOf(t);
    if (labels.has(MANUAL_LABEL)) return null;
    const cats = catsOf(labels);
    if (!labels.has(AI_LABEL)) {
      if (cats.length) return null;   // קטגוריה ידנית מלפני ה-AI / מייבוא
      const since = config.AI_SINCE ? Date.parse(config.AI_SINCE) : 0;
      return since && Date.parse(msgs[0].date) < since ? null : 'first';
    }
    if (!cats.every(k => VAGUE.has(k))) return null;
    const last = msgs[msgs.length - 1];
    if (last.labels.has(SEEN_LABEL)) return null;
    const passes = msgs.filter(m => m.labels.has(SEEN_LABEL)).length || 1;
    return passes < MAX_PASSES ? 'again' : null;
  }

  pending() {
    const now = Date.now();
    const out = [];
    for (const t of this.e.threads().values()) {
      if (now - (this.failedAt.get(t.id) || 0) < RETRY_AFTER_MS) continue;
      if (this.need(t)) out.push(t);
    }
    // חדשות קודם – כדי שהפניות השוטפות יסווגו מהר גם בזמן הסיווג הרטרואקטיבי
    return out.sort((a, b) => b.lastIncoming.localeCompare(a.lastIncoming));
  }

  kick() {
    if (!ai.isConfigured() || !this.e.p.status || !this.e.p.status.ready) return;
    if (this.busy) { this.again = true; return; }
    this.run().catch(e => console.error('[ai] worker:', e.message));
  }

  async run() {
    this.busy = true;
    try {
      do {
        this.again = false;
        const todo = this.pending().slice(0, BATCH);
        for (const t of todo) {
          if (!ai.isConfigured()) return;
          await this.one(t);
          await sleep(GAP_MS);
        }
        if (todo.length === BATCH) this.again = true;
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  textFor(t) {
    const msgs = this.customerMsgs(t);
    return redact({
      subject: msgs[0].subject,
      bodies: msgs.map(m => m.body),
      names: [t.fromName, ...msgs.map(m => m.from && m.from.name)],
    });
  }

  async one(t) {
    const kind = this.need(t);
    if (!kind) return;
    const msgs = this.customerMsgs(t);
    const first = msgs[0], last = msgs[msgs.length - 1];
    const res = await ai.classify(this.textFor(t).text);
    if (!res.ok) { this.failedAt.set(t.id, Date.now()); return; }
    this.failedAt.delete(t.id);
    const newCats = res.cats.filter(k => k !== 'general').map(k => `KOH/cat/${k}`);
    await this.e.locked(t.id, async () => {
      // בדיקה חוזרת בתוך הנעילה: אולי מישהו מהצוות קבע קטגוריה בזמן שחיכינו לתשובה
      const fresh = this.e.threads().get(t.id);
      if (!fresh || this.need(fresh) !== kind) return;
      if (kind === 'again') {
        const old = catsOf(labelsOf(fresh)).map(k => `KOH/cat/${k}`).filter(l => !newCats.includes(l));
        if (old.length) {
          await this.e.p.modifyLabels(fresh.uids, [], old);
          for (const m of fresh.raw) old.forEach(l => m.labels.delete(l));
        }
      }
      const add = [...(kind === 'first' ? [AI_LABEL] : []), ...newCats];
      if (add.length) await this.e.p.modifyLabels([first.uid], add, []);
      await this.e.p.modifyLabels([last.uid], [SEEN_LABEL], []);
      add.forEach(l => first.labels.add(l));
      last.labels.add(SEEN_LABEL);
      this.e.cache = null;
      if (kind === 'first') this.done++; else this.redone++;
    });
  }

  // קטגוריות שאוחדו (config.MERGED_CATEGORIES): KOH/cat/ambassador → KOH/cat/assign, KOH/cat/proof → KOH/cat/inquiry
  async migrateCategories() {
    const map = config.MERGED_CATEGORIES || {};
    let moved = 0;
    for (const [from, to] of Object.entries(map)) {
      const oldL = `KOH/cat/${from}`, newL = `KOH/cat/${to}`;
      const uids = [...this.e.p.messages.values()].filter(m => m.labels.has(oldL)).map(m => m.uid);
      for (let i = 0; i < uids.length; i += 200) {
        const part = uids.slice(i, i + 200);
        await this.e.p.modifyLabels(part, [newL], []);
        await this.e.p.modifyLabels(part, [], [oldL]);
      }
      for (const uid of uids) { const m = this.e.p.messages.get(uid); if (m) { m.labels.add(newL); m.labels.delete(oldL); } }
      moved += uids.length;
    }
    if (moved) { this.e.cache = null; console.log(`[ai] הומרו ${moved} תוויות קטגוריה שאוחדו`); }
    return moved;
  }

  // סיווג מחדש של כל מה שה-AI סיווג (למשל אחרי שיפור ההסברים): מוחק את תוויות ה-AI
  // מפניות שהצוות לא תיקן ידנית (בלי KOH/cat-manual), והעובד מסווג אותן שוב.
  async resetAi() {
    const uids = new Set(), labelSet = new Set([AI_LABEL, SEEN_LABEL]);
    let threads = 0;
    for (const t of this.e.threads().values()) {
      const labels = labelsOf(t);
      if (!labels.has(AI_LABEL) || labels.has(MANUAL_LABEL)) continue;
      threads++;
      t.uids.forEach(u => uids.add(u));
      catsOf(labels).forEach(k => labelSet.add(`KOH/cat/${k}`));
    }
    const list = [...uids], remove = [...labelSet];
    for (let i = 0; i < list.length; i += 200) await this.e.p.modifyLabels(list.slice(i, i + 200), [], remove);
    for (const uid of list) { const m = this.e.p.messages.get(uid); if (m) remove.forEach(l => m.labels.delete(l)); }
    this.failedAt.clear();
    this.e.cache = null;
    this.kick();
    return { threads };
  }

  // למסך המנהל: מצב + כמה נשארו
  status() {
    let left = 0;
    try { left = this.pending().length; } catch { /* עוד לא מחובר */ }
    return { enabled: ai.isConfigured(), model: config.AI_MODEL, running: this.busy, left, classifiedNow: this.done, reclassifiedNow: this.redone, ...ai.stats };
  }

  // הרצה יבשה: מה *היה* נשלח – בלי לשלוח כלום. n הפניות האחרונות.
  preview(n = 100) {
    return [...this.e.threads().values()]
      .filter(t => this.customerMsgs(t).length && !t.categories.includes('system'))
      .sort((a, b) => b.lastIncoming.localeCompare(a.lastIncoming))
      .slice(0, Math.min(Math.max(+n || 100, 1), 300))
      .map(t => ({ id: t.id, date: this.customerMsgs(t)[0].date, text: this.textFor(t).text }));
  }
}

module.exports = { AiWorker, AI_LABEL, SEEN_LABEL, MANUAL_LABEL };
