// סיווג AI ברקע: כל פניה מסווגת פעם אחת, והתוצאה נשמרת כתוויות בתיבה – לא בזיכרון.
//   KOH/cat/<key> – הקטגוריה שה-AI בחר (אותה תווית שהצוות משנה ידנית)
//   KOH/ai        – "כבר סווג". נשאר גם אחרי תיקון ידני, כך שה-AI לא ידרוס את הצוות.
// בהפעלה מחדש התוויות נטענות מהתיבה, ולכן רק פניות בלי סימון נשלחות. בלי AI_ENABLED=1 – לא רץ בכלל.
// כשל (timeout, שגיאה) → לא מסמנים; הפניה מוצגת לפי מילות מפתח וננסה שוב מאוחר יותר.
const config = require('./config');
const { redact } = require('./redact');
const ai = require('./ai-classify');

const AI_LABEL = 'KOH/ai';
const BATCH = 20;               // פניות לכל סבב
const GAP_MS = 300;             // הפסקה בין קריאות
const RETRY_AFTER_MS = 30 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class AiWorker {
  constructor(engine) {
    this.e = engine;
    this.busy = false;
    this.again = false;
    this.failedAt = new Map();   // threadId → זמן כשל אחרון (בזיכרון בלבד)
    this.done = 0;
    const kick = () => setTimeout(() => this.kick(), 2000);
    engine.p.on('ready', kick);
    engine.p.on('change', kick);
  }

  firstIncoming(t) {
    return (t.raw || []).find(m => !this.e.isOut(m) && !m.bounce) || null;
  }

  // פניות שעוד לא סווגו
  pending() {
    const since = config.AI_SINCE ? Date.parse(config.AI_SINCE) : 0;
    const now = Date.now();
    const out = [];
    for (const t of this.e.threads().values()) {
      if (t.status === 'ignored' || t.bounceOrphan || t.categories.includes('system')) continue;
      const labels = new Set(t.raw.flatMap(m => [...m.labels]));
      if (labels.has(AI_LABEL) || [...labels].some(l => l.startsWith('KOH/cat/'))) continue;
      const first = this.firstIncoming(t);
      if (!first) continue;
      if (since && Date.parse(first.date) < since) continue;
      if (now - (this.failedAt.get(t.id) || 0) < RETRY_AFTER_MS) continue;
      out.push(t);
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

  async one(t) {
    const first = this.firstIncoming(t);
    if (!first) return;
    const r = redact({ subject: first.subject, body: first.body, names: [t.fromName, first.from && first.from.name] });
    const res = await ai.classify(r.text);
    if (!res.ok) { this.failedAt.set(t.id, Date.now()); return; }
    this.failedAt.delete(t.id);
    const cats = res.cats.filter(k => k !== 'general').map(k => `KOH/cat/${k}`);
    await this.e.locked(t.id, async () => {
      // בדיקה חוזרת בתוך הנעילה: אולי מישהו מהצוות קבע קטגוריה בזמן שחיכינו לתשובה
      const fresh = this.e.threads().get(t.id);
      if (!fresh) return;
      const labels = new Set(fresh.raw.flatMap(m => [...m.labels]));
      if (labels.has(AI_LABEL) || [...labels].some(l => l.startsWith('KOH/cat/'))) return;
      await this.e.p.modifyLabels([first.uid], [AI_LABEL, ...cats], []);
      first.labels.add(AI_LABEL);
      cats.forEach(l => first.labels.add(l));
      this.e.cache = null;
      this.done++;
    });
  }

  // למסך המנהל: מצב + כמה נשארו
  status() {
    let left = 0;
    try { left = this.pending().length; } catch { /* עוד לא מחובר */ }
    return { enabled: ai.isConfigured(), model: config.AI_MODEL, running: this.busy, left, classifiedNow: this.done, ...ai.stats };
  }

  // הרצה יבשה: מה *היה* נשלח – בלי לשלוח כלום. n הפניות האחרונות.
  preview(n = 100) {
    const list = [...this.e.threads().values()]
      .filter(t => this.firstIncoming(t) && !t.categories.includes('system'))
      .sort((a, b) => b.lastIncoming.localeCompare(a.lastIncoming))
      .slice(0, Math.min(Math.max(+n || 100, 1), 300));
    return list.map(t => {
      const first = this.firstIncoming(t);
      return { id: t.id, date: first.date, text: redact({ subject: first.subject, body: first.body, names: [t.fromName, first.from && first.from.name] }).text };
    });
  }
}

module.exports = { AiWorker, AI_LABEL };
