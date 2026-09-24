import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { makeHandler } = createRequire(import.meta.url)('./lambda.cjs');

const KEY = 'k'.repeat(32);
/** An in-memory DynamoDB with real conditional-put semantics. */
function fakeDb({ failOn = new Set() } = {}) {
  const items = new Map();
  return {
    items,
    async put(input) {
      const k = input.Item.idempotency_key.S;
      if (failOn.has(k)) throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
      if (items.has(k)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      items.set(k, input.Item);
    },
  };
}
const good = (n = 1) => ({
  idempotency_key: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`,
  propulse_id: String(n),
  scanned_at: '2026-10-01T15:00:00.000Z',
  device_id: 'dev-0a1b2c3d',
});
const call = (h, body, key = KEY) => h({ headers: { 'x-event-key': key }, body: JSON.stringify(body) })
  .then(r => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test('a valid batch is stored with exactly the four fields plus received_at', async () => {
  const db = fakeDb();
  const h = makeHandler(db, { table: 't', key: KEY, now: () => '2026-10-01T15:00:01.000Z' });
  const r = await call(h, { checkins: [good(1), good(2)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accepted.sort(), [good(1).idempotency_key, good(2).idempotency_key].sort());
  assert.deepEqual(Object.keys(db.items.get(good(1).idempotency_key)).sort(),
    ['device_id', 'idempotency_key', 'propulse_id', 'received_at', 'scanned_at']);
});

test('THE FIREWALL: any extra field rejects the whole request and stores nothing', async () => {
  const db = fakeDb();
  const h = makeHandler(db, { table: 't', key: KEY });
  for (const extra of [{ full_name: 'Nolan Wong' }, { company: 'X' }, { email: 'a@example.com' }, { matched: true }, { status: 'pending' }]) {
    const r = await call(h, { checkins: [good(1), { ...good(2), ...extra }] });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(db.items.size, 0, 'not even the valid item of a rejected batch');
});

test('extra top-level keys are rejected too', async () => {
  const h = makeHandler(fakeDb(), { table: 't', key: KEY });
  assert.equal((await call(h, { checkins: [good()], device_id: 'dev-0a1b2c3d' })).status, 400);
  assert.equal((await call(h, { checkins: [good()], visitor: { name: 'x' } })).status, 400);
});

test('error messages never echo a value', async () => {
  const h = makeHandler(fakeDb(), { table: 't', key: KEY });
  const r = await call(h, { checkins: [{ ...good(), propulse_id: 'Nolan Wong' }] });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.body.error, /Nolan/);
  assert.match(r.body.error, /propulse_id invalid/);
});

test('a resend after a WiFi drop is accepted and never duplicated', async () => {
  const db = fakeDb();
  const h = makeHandler(db, { table: 't', key: KEY });
  await call(h, { checkins: [good(1)] });
  const again = await call(h, { checkins: [good(1)] });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.accepted, [good(1).idempotency_key], 'confirmed, so the phone stops retrying');
  assert.equal(db.items.size, 1);
});

test('two scanners scanning different badges at the same moment both land', async () => {
  const db = fakeDb();
  const h = makeHandler(db, { table: 't', key: KEY });
  const a = { ...good(1), device_id: 'dev-aaaaaaaa' };
  const b = { ...good(2), device_id: 'dev-bbbbbbbb' };
  const [ra, rb] = await Promise.all([call(h, { checkins: [a] }), call(h, { checkins: [b] })]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal(db.items.size, 2);
});

test('a failed write is NOT reported as accepted, so the phone retries it', async () => {
  const db = fakeDb({ failOn: new Set([good(2).idempotency_key]) });
  const h = makeHandler(db, { table: 't', key: KEY });
  const r = await call(h, { checkins: [good(1), good(2)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accepted, [good(1).idempotency_key]);
  assert.equal(r.body.failed, 1);
});

test('a wrong or missing event key is refused before anything is parsed', async () => {
  const db = fakeDb();
  const h = makeHandler(db, { table: 't', key: KEY });
  assert.equal((await call(h, { checkins: [good()] }, 'wrong')).status, 401);
  assert.equal((await h({ headers: {}, body: '{}' })).statusCode, 401);
  const unset = makeHandler(db, { table: 't', key: '' });
  assert.equal((await call(unset, { checkins: [good()] }, '')).status, 401, 'no configured key means closed, not open');
  assert.equal(db.items.size, 0);
});

test('malformed, oversized and out-of-range bodies are refused', async () => {
  const h = makeHandler(fakeDb(), { table: 't', key: KEY });
  assert.equal((await h({ headers: { 'x-event-key': KEY }, body: 'not json' })).statusCode, 400);
  assert.equal((await call(h, { checkins: [] })).status, 400);
  assert.equal((await call(h, { checkins: Array.from({ length: 26 }, (_, i) => good(i + 1)) })).status, 400);
  assert.equal((await h({ headers: { 'x-event-key': KEY }, body: 'x'.repeat(20001) })).statusCode, 413);
  const b64 = Buffer.from(JSON.stringify({ checkins: [good()] })).toString('base64');
  assert.equal((await h({ headers: { 'x-event-key': KEY }, body: b64, isBase64Encoded: true })).statusCode, 200);
});
