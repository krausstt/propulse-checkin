import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCheckin, isDuplicateScan, dueForSend, markSent, markFailed,
  applyAck, outboxStats, PENDING, SENT, BACKOFF, DEDUPE_WINDOW_MS,
} from './outbox.js';

const T0 = Date.parse('2026-09-22T09:00:00.000Z');
const base = { id: '1', uuid: 'uuid-1', deviceId: 'phone-07', now: T0, matched: true };

test('a check-in carries its own idempotency key and starts pending', () => {
  const c = createCheckin(base);
  assert.equal(c.idempotency_key, 'uuid-1');
  assert.equal(c.propulse_id, '1');
  assert.equal(c.device_id, 'phone-07');
  assert.equal(c.scanned_at, '2026-09-22T09:00:00.000Z');
  assert.equal(c.matched, true);
  assert.equal(c.status, PENDING);
  assert.equal(c.attempts, 0);
  assert.equal(c.next_attempt_at, T0, 'first attempt is immediate');
});

test('a check-in never silently carries a missing key', () => {
  for (const missing of ['id', 'uuid', 'deviceId']) {
    assert.throws(() => createCheckin({ ...base, [missing]: undefined }), new RegExp(missing));
  }
  assert.throws(() => createCheckin({ ...base, now: 'nope' }), /epoch millis/);
});

test('an unmatched scan is recorded too', () => {
  // These are the evidence that the roster is stale. Dropping them means
  // finding out on day 2 instead of the evening of day 1.
  const c = createCheckin({ ...base, matched: false });
  assert.equal(c.matched, false);
  assert.equal(c.status, PENDING);
});

test('the scanner double-firing the same badge is one visit', () => {
  const first = createCheckin(base);
  assert.equal(isDuplicateScan([first], '1', T0 + 200), true);
  assert.equal(isDuplicateScan([first], '1', T0 + DEDUPE_WINDOW_MS - 1), true);
  assert.equal(isDuplicateScan([first], '1', T0 + DEDUPE_WINDOW_MS), false, 'a deliberate re-scan later is real');
  assert.equal(isDuplicateScan([first], '2', T0 + 200), false, 'a different visitor is never a duplicate');
  assert.equal(isDuplicateScan([], '1', T0), false);
});

test('a clock that jumps backwards does not swallow a real scan', () => {
  // Android phones do adjust their clock. now < scanned_at must not read as
  // "within the window" - that would discard an attendance record.
  const first = createCheckin(base);
  assert.equal(isDuplicateScan([first], '1', T0 - 5000), false);
});

test('only due records are sent, oldest first, and the batch is capped', () => {
  const records = [
    { ...createCheckin({ ...base, uuid: 'c' }), next_attempt_at: T0 + 300 },
    { ...createCheckin({ ...base, uuid: 'a' }), next_attempt_at: T0 + 100 },
    { ...createCheckin({ ...base, uuid: 'b' }), next_attempt_at: T0 + 200 },
    { ...createCheckin({ ...base, uuid: 'future' }), next_attempt_at: T0 + 9999 },
    markSent(createCheckin({ ...base, uuid: 'done' }), T0),
  ];
  const due = dueForSend(records, T0 + 500);
  assert.deepEqual(due.map(r => r.idempotency_key), ['a', 'b', 'c']);
  assert.equal(dueForSend(records, T0 + 500, 2).length, 2);
});

test('transitions never mutate the record they are given', () => {
  const c = createCheckin(base);
  const sent = markSent(c, T0 + 1000);
  assert.equal(c.status, PENDING, 'append-only: the original is untouched');
  assert.equal(sent.status, SENT);
  assert.equal(sent.sent_at, '2026-09-22T09:00:01.000Z');
});

test('backoff grows, is capped, and is jittered', () => {
  let r = createCheckin(base);
  const noJitter = () => 1; // full jitter at its maximum == the plain ceiling

  const delays = [];
  let now = T0;
  for (let i = 0; i < 12; i++) {
    r = markFailed(r, { now, error: 'offline', random: noJitter });
    delays.push(r.next_attempt_at - now);
    now = r.next_attempt_at;
  }

  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.ok(delays.every(d => d <= BACKOFF.maxMs), `capped at ${BACKOFF.maxMs}: ${delays}`);
  assert.equal(delays.at(-1), BACKOFF.maxMs);
  assert.equal(r.attempts, 12);
  assert.equal(r.status, PENDING, 'an undelivered check-in is lost attendance - never abandon it');
});

test('jitter actually spreads the retry across the window', () => {
  const c = createCheckin(base);
  const early = markFailed(c, { now: T0, error: 'x', random: () => 0 });
  const late = markFailed(c, { now: T0, error: 'x', random: () => 1 });
  assert.equal(early.next_attempt_at, T0, 'full jitter can retry immediately');
  assert.equal(late.next_attempt_at, T0 + BACKOFF.baseMs);
  assert.ok(late.next_attempt_at > early.next_attempt_at, 'ten phones must not retry in lockstep');
});

test('a long error message cannot bloat the stored record', () => {
  const r = markFailed(createCheckin(base), { now: T0, error: 'x'.repeat(5000) });
  assert.equal(r.last_error.length, 200);
});

test('the server acking a key we still think is pending settles it', () => {
  // The point of the idempotency key: a response lost on the way back must not
  // turn into a second check-in.
  const records = [
    createCheckin({ ...base, uuid: 'a' }),
    createCheckin({ ...base, uuid: 'b' }),
  ];
  const after = applyAck(records, ['a', 'unknown-key-from-somewhere'], T0 + 50);
  assert.equal(after[0].status, SENT);
  assert.equal(after[1].status, PENDING);
  assert.equal(after.length, 2, 'an unknown key in the response is ignored, never added');
});

test('an ack for an already-sent record does not rewrite its timestamp', () => {
  const sent = markSent(createCheckin(base), T0);
  const [after] = applyAck([sent], ['uuid-1'], T0 + 5000);
  assert.equal(after.sent_at, '2026-09-22T09:00:00.000Z');
});

test('stats tell the technician how much data lives only on this phone', () => {
  const records = [
    markSent(createCheckin({ ...base, uuid: 'a' }), T0),
    createCheckin({ ...base, uuid: 'b', now: T0 - 60_000 }),
    { ...createCheckin({ ...base, uuid: 'c', now: T0 - 600_000 }), attempts: 7 },
  ];
  const s = outboxStats(records, T0);
  assert.equal(s.sent, 1);
  assert.equal(s.pending, 2);
  assert.equal(s.stuck, 1, 'seven failures is not a blip');
  assert.equal(s.oldestPendingMs, 600_000);
});

test('an empty outbox reports cleanly', () => {
  assert.deepEqual(outboxStats([], T0), { pending: 0, sent: 0, oldestPendingMs: null, stuck: 0 });
});
