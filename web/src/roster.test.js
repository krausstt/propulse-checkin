import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  normalizeId, validateRoster, indexVisitors, lookup,
  verifyChecksum, isStale, rosterAge, acceptReplacement, ROSTER_MAX_AGE_MS,
} from './roster.js';

const payload = () => ({
  schema: 'propulse-roster/1',
  event: 'ProPulse 2026 Chicago',
  generated_at: '2026-09-22T08:00:00.000Z',
  source_file: 'registrants.sample.csv',
  count: 3,
  checksum: 'deadbeefdeadbeef',
  visitors: {
    1: { full_name: 'Norman Wang', host: 'Rohan Wagh', badge_location: 'B-12', status: 'Registered' },
    2: { full_name: 'Maria Santos', host: 'Eileen Example', badge_location: 'A-04', status: 'Registered' },
    3: { full_name: 'Jonas Öberg', host: 'Tobias Krauss', badge_location: 'C-21', status: 'Registered' },
  },
});

test('normalizeId matches what the scanner produces, including leading zeros', () => {
  assert.equal(normalizeId('1'), '1');
  assert.equal(normalizeId(' 42 '), '42');
  assert.equal(normalizeId('007'), '7', 'the roster builder does not strip these - we must');
  assert.equal(normalizeId(1), '1', 'JSON object keys arrive as strings, but be forgiving');
  for (const junk of ['', '  ', 'ABC', '12345678', 'https://x', null, undefined]) {
    assert.equal(normalizeId(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('a leading-zero roster key is still reachable from a scan', () => {
  // The exact gap between build-roster.mjs and parseScannedId. If this breaks,
  // a real visitor stands at the booth and gets NOT REGISTERED.
  const p = payload();
  p.visitors = { '007': { full_name: 'Zero Padded', host: 'H', badge_location: 'Z-1' } };
  p.count = 1;
  const { index, collisions } = indexVisitors(p);
  assert.deepEqual(collisions, []);
  assert.equal(lookup(index, '7').full_name, 'Zero Padded');
  assert.equal(lookup(index, '007').full_name, 'Zero Padded');
});

test('two rows that normalise to one key are reported, not silently merged', () => {
  const p = payload();
  p.visitors = {
    7: { full_name: 'Seven', host: 'A', badge_location: 'A-1' },
    '007': { full_name: 'Oh Oh Seven', host: 'B', badge_location: 'B-2' },
  };
  p.count = 2;
  const { collisions } = indexVisitors(p);
  assert.equal(collisions.length, 1, 'greeting one visitor with another name is worse than a miss');
  assert.equal(collisions[0].id, '7');
});

test('roster keys that no scan could ever produce are flagged, not indexed', () => {
  const p = payload();
  p.visitors = { 'N/A': { full_name: 'Broken Row', host: '', badge_location: '' } };
  p.count = 1;
  const { index, unusable } = indexVisitors(p);
  assert.equal(index.size, 0);
  assert.deepEqual(unusable, ['N/A']);
});

test('lookup returns null for unknown and malformed IDs', () => {
  const { index } = indexVisitors(payload());
  assert.equal(lookup(index, '4711'), null);
  assert.equal(lookup(index, 'ABC'), null);
  assert.equal(lookup(index, ''), null);
  assert.equal(lookup(index, '2').full_name, 'Maria Santos');
});

test('a captive-portal login page is rejected instead of wiping the cache', () => {
  assert.ok(validateRoster('<!doctype html><title>Sign in</title>').length > 0);
  assert.ok(validateRoster(null).length > 0);
  assert.ok(validateRoster({ schema: 'something-else', visitors: { 1: {} } }).length > 0);
});

test('an empty roster is never accepted', () => {
  const p = payload();
  p.visitors = {};
  p.count = 0;
  const errors = validateRoster(p);
  assert.ok(errors.some(e => /empty/.test(e)));
});

test('a truncated roster is caught by the count cross-check', () => {
  const p = payload();
  delete p.visitors[3];
  const errors = validateRoster(p);
  assert.ok(errors.some(e => /count says 3/.test(e)), errors.join('; '));
});

test('a valid roster produces no errors', () => {
  assert.deepEqual(validateRoster(payload()), []);
});

test('checksum verification agrees with build-roster.mjs', async () => {
  // Reproduce the builder's own computation, then confirm we agree with it.
  const p = payload();
  const { createHash } = await import('node:crypto');
  p.checksum = createHash('sha256').update(JSON.stringify(p.visitors)).digest('hex').slice(0, 16);

  const good = await verifyChecksum(p, webcrypto.subtle);
  assert.equal(good.ok, true, `expected ${p.checksum}, got ${good.actual}`);

  p.visitors[1].full_name = 'Tampered';
  const bad = await verifyChecksum(p, webcrypto.subtle);
  assert.equal(bad.ok, false);
});

test('a payload with no checksum verifies rather than failing shut', async () => {
  const p = payload();
  delete p.checksum;
  assert.equal((await verifyChecksum(p, webcrypto.subtle)).ok, true);
});

test('staleness is advisory and a missing timestamp counts as stale', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const fresh = { fetched_at: '2026-09-22T11:00:00.000Z' };
  const old = { fetched_at: '2026-09-21T12:00:00.000Z' };

  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
  assert.equal(isStale(null, now), true);
  assert.equal(isStale({ fetched_at: 'not a date' }, now), true);
  assert.equal(rosterAge(fresh, now), 60 * 60 * 1000);
  assert.equal(ROSTER_MAX_AGE_MS, 6 * 60 * 60 * 1000);
});

test('a bad download never replaces a good cache', () => {
  const current = payload();
  assert.equal(acceptReplacement(current, '<html>portal</html>').accept, false);
  assert.equal(acceptReplacement(current, { schema: 'propulse-roster/1', visitors: {}, count: 0 }).accept, false);
});

test('an unchanged roster is not rewritten', () => {
  const current = payload();
  const incoming = payload();
  const r = acceptReplacement(current, incoming);
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'unchanged');
});

test('a genuinely newer roster is accepted', () => {
  const current = payload();
  const incoming = payload();
  incoming.visitors[4] = { full_name: 'Late Registrant', host: 'H', badge_location: 'D-01' };
  incoming.count = 4;
  incoming.checksum = 'newchecksum00000';
  assert.equal(acceptReplacement(current, incoming).accept, true);
});
