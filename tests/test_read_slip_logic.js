/* Run: node tests/test_read_slip_logic.js   (Node >= 22.18 imports the .ts directly; exit code 1 on failure) */
import assert from 'node:assert/strict';
const L = await import('../supabase/functions/read-slip/logic.ts');
let n = 0;
const t = async (name, fn) => { await fn(); n++; };

await t('parseModels', () => {
  assert.deepEqual(L.parseModels(undefined), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.deepEqual(L.parseModels(' a , ,b '), ['a', 'b']);
});
await t('parseJsonText strips fences', () => {
  assert.deepEqual(L.parseJsonText('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.throws(() => L.parseJsonText('nope'));
});
await t('geminiText', () => {
  assert.equal(L.geminiText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.equal(L.geminiText({ promptFeedback: {} }), '');
});
await t('normalizeBets shapes', () => {
  assert.deepEqual(L.normalizeBets([{ a: 1 }, 3, null]), [{ a: 1 }]);
  assert.deepEqual(L.normalizeBets({ bets: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(L.normalizeBets({ rows: [{ a: 1 }] }), [{ a: 1 }]);
  assert.equal(L.normalizeBets({ x: 1 }), null);
  assert.equal(L.normalizeBets('s'), null);
  assert.equal(L.normalizeBets(Array.from({ length: 50 }, () => ({}))).length, 30);
});
await t('fallback moves on after failures', async () => {
  const calls = [];
  const r = await L.readWithFallback(['m1', 'm2', 'm3'], async (m) => {
    calls.push(m);
    if (m === 'm1') throw new Error('model busy (HTTP 429)');
    if (m === 'm2') return 'not json';
    return '{"bets":[{"pick":"x"}]}';
  });
  assert.deepEqual(calls, ['m1', 'm2', 'm3']);
  assert.equal(r.ok, true); assert.equal(r.model, 'm3'); assert.deepEqual(r.rows, [{ pick: 'x' }]);
});
await t('empty array is a valid answer', async () => {
  const calls = [];
  const r = await L.readWithFallback(['m1', 'm2'], async (m) => { calls.push(m); return '[]'; });
  assert.deepEqual(calls, ['m1']); assert.deepEqual(r.rows, []);
});
await t('total failure gives short error', async () => {
  const e = new Error('x'); e.name = 'TimeoutError';
  const r = await L.readWithFallback(['m1'], async () => { throw e; });
  assert.equal(r.ok, false); assert.match(r.error, /timeout/);
});
console.log('ok ' + n + ' tests');
