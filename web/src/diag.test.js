import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, withAck, capture5Command, feedbackCommand } from './diag.js';

const serials = { device_serial: 'MAIXBEU011089', gateway_serial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e' };
const args = { serials, eventId: 'dfa2cf49-6670-418b-92b1-9c251a1735c7', now: 1790089547996 };

test('every probe carries the full Streams API envelope', () => {
  for (const [name, p] of Object.entries(PROBES)) {
    const c = p.build(args);
    for (const k of ['api_version', 'event_type', 'event_id', 'time_created', 'device_serial']) {
      assert.ok(c[k] !== undefined, `${name} missing ${k}`);
    }
    assert.match(c.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(c.event_type.endsWith('!'), 'commands end in !');
  }
});

test('the pg_work5_t3 probe is the capture, not the app states', () => {
  const t = capture5Command(args).screen_views[0].pg_work5_t3;
  assert.deepEqual(t.field_middle_right.state, { type: 'FOCUSED', highlighted: true });
  for (const k of ['field_top_left', 'field_top_right', 'field_middle_left', 'field_bottom']) {
    assert.equal('state' in t[k], false, `${k} is stateless in the capture`);
  }
  assert.equal('forced_orientation' in capture5Command(args), false);
});

test('a missing gateway serial is omitted, not sent as null', () => {
  const c = feedbackCommand({ ...args, serials: { device_serial: 'X' } });
  assert.equal('gateway_serial' in c, false);
});

test('ack is opt-in and does not mutate the probe', () => {
  const base = PROBES.app.build(args);
  assert.equal('ack_required' in base, false);
  assert.equal(withAck(base, 'ON_HANDLED').ack_required, 'ON_HANDLED');
  assert.equal('ack_required' in base, false);
  assert.equal(withAck(base, '').ack_required, undefined);
});
