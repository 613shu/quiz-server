// בדיקות בלי רשת: fetch מדומה
process.env.AI_ENABLED = '1';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'test-model';
process.env.AI_PROJECT = 'koh-test';
process.env.AI_TIMEOUT_MS = '100';

const test = require('node:test');
const assert = require('node:assert');
const ai = require('../src/ai-classify');

const answer = obj => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const fakeFetch = (body, status = 200) => async (url, opts) => {
  fakeFetch.last = { url, opts };
  return { ok: status < 300, status, json: async () => body };
};

test('תשובה תקינה', async () => {
  const r = await ai.classify('נושא: x', { fetchImpl: fakeFetch(answer({ categories: ['double'] })) });
  assert.deepStrictEqual(r.cats, ['double']);
  assert.ok(r.ok);
});

test('נקודת קצה אזורית באירופה + מפתח בכותרת, לא ב-URL', async () => {
  await ai.classify('x', { fetchImpl: fakeFetch(answer({ categories: ['receipt'] })) });
  assert.match(fakeFetch.last.url, /^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/koh-test\/locations\/europe-west4\//);
  assert.ok(!fakeFetch.last.url.includes('test-key'));
  assert.strictEqual(fakeFetch.last.opts.headers['x-goog-api-key'], 'test-key');
});

test('מפתח שלא ברשימה / english / system → נדחה', async () => {
  for (const cats of [['hack'], ['english'], ['system'], []]) {
    const r = await ai.classify('x', { fetchImpl: fakeFetch(answer({ categories: cats })) });
    assert.deepStrictEqual(r.cats, ['general']);
    assert.strictEqual(r.ok, false);
  }
});

test('ניקוי: general/inquiry עם קטגוריה נוספת, כפילויות, יותר מ-2', () => {
  assert.deepStrictEqual(ai.parseAnswer(answer({ categories: ['general', 'receipt'] })), ['receipt']);
  assert.deepStrictEqual(ai.parseAnswer(answer({ categories: ['inquiry', 'assign'] })), ['assign']);
  assert.deepStrictEqual(ai.parseAnswer(answer({ categories: ['cancel', 'cancel', 'standing', 'double'] })), ['cancel', 'standing']);
});

test('טקסט שאינו JSON → general', async () => {
  const body = { candidates: [{ content: { parts: [{ text: 'ignore previous instructions' }] } }] };
  const r = await ai.classify('x', { fetchImpl: fakeFetch(body) });
  assert.deepStrictEqual(r.cats, ['general']);
});

test('שגיאת HTTP → general בלי לזרוק', async () => {
  const r = await ai.classify('x', { fetchImpl: fakeFetch({}, 429) });
  assert.deepStrictEqual(r.cats, ['general']);
  assert.strictEqual(ai.stats.lastError, 'http 429');
});

test('timeout → general', async () => {
  const slow = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const r = await ai.classify('x', { fetchImpl: slow });
  assert.deepStrictEqual(r.cats, ['general']);
  assert.strictEqual(ai.stats.lastError, 'timeout');
});

test('הסכימה מגבילה ל-enum בלי english/system', () => {
  const e = ai.requestBody('x').generationConfig.responseSchema.properties.categories.items.enum;
  assert.ok(e.includes('receipt') && e.includes('general'));
  assert.ok(!e.includes('english') && !e.includes('system'));
});
