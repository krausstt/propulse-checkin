import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayCommand, parseScannedId, formatHost } from './mai.js';

// The exact payload captured from the customer's INSIGHT Mobile installation.
// If this test fails, we have drifted from a known-good message.
const GOLDEN = {
  active_screen_view: 'SCREEN_VIEW_1',
  api_version: '3.0',
  device_serial: 'MAIXBEU011089',
  event_id: '89ec1cdd-d74b-41d5-9a9f-9351e180461e',
  event_type: 'display_v2!',
  forced_orientation: 'LANDSCAPE',
  gateway_serial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  ref_id: 'SCREEN_1',
  screen_views: [
    {
      ref_id: 'SCREEN_VIEW_1',
      pg_work4_t4: {
        title: 'ProPulse 2026 Chicago',
        field_top_left: { text_header: 'ID', text_content: '1', ref_id: 'field_top_left_ref' },
        field_top_right: { text_header: 'Host', text_content: 'Rohan', ref_id: 'field_top_right_ref' },
        field_middle_left: { text_header: 'Badge Location', text_content: 'B-12', ref_id: 'field_middle_left_ref' },
        field_bottom: {
          text_header: 'Full Name of Visitor',
          text_content: 'Norman Wang',
          ref_id: 'field_bottom_ref',
          state: { type: 'FOCUSED', highlighted: true },
        },
      },
    },
  ],
  time_created: 1789659645191,
};

const NORMAN = { full_name: 'Norman Wang', host: 'Rohan Wagh', badge_location: 'B-12', status: 'Registered' };

const base = {
  deviceSerial: 'MAIXBEU011089',
  gatewaySerial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  eventId: '89ec1cdd-d74b-41d5-9a9f-9351e180461e',
  now: 1789659645191,
};

test('reproduces the captured known-good payload exactly', () => {
  const out = buildDisplayCommand({ id: '1', visitor: NORMAN, ...base });
  assert.deepEqual(out, GOLDEN);
});

test('an unknown ID produces a loud NOT REGISTERED screen, not a blank one', () => {
  const out = buildDisplayCommand({ id: '4711', visitor: null, ...base });
  const t = out.screen_views[0].pg_work4_t4;
  assert.equal(t.field_bottom.text_header, 'Not Registered');
  assert.equal(t.field_bottom.text_content, 'ID 4711');
  assert.equal(t.field_top_left.text_content, '4711', 'greeter still needs the scanned ID');
  assert.equal(t.field_bottom.state.highlighted, true);
});

test('empty roster fields render as an em dash, never as blank', () => {
  const out = buildDisplayCommand({
    id: '5', visitor: { full_name: 'No Badge', host: '', badge_location: '' }, ...base,
  });
  const t = out.screen_views[0].pg_work4_t4;
  assert.equal(t.field_top_right.text_content, '—');
  assert.equal(t.field_middle_left.text_content, '—');
});

test('long values are clipped with an ellipsis rather than overflowing the 2in display', () => {
  const out = buildDisplayCommand({
    id: '6',
    visitor: { full_name: 'Bartholomew Maximilian Wolfeschlegelsteinhausenberger', host: 'X', badge_location: 'A-1' },
    ...base,
  });
  const name = out.screen_views[0].pg_work4_t4.field_bottom.text_content;
  assert.ok(name.length <= 28, `got ${name.length} chars`);
  assert.ok(name.endsWith('…'));
});

test('non-ASCII names survive intact', () => {
  const out = buildDisplayCommand({
    id: '3', visitor: { full_name: 'Jonas Öberg', host: 'Tobias Krauss', badge_location: 'C-21' }, ...base,
  });
  assert.equal(out.screen_views[0].pg_work4_t4.field_bottom.text_content, 'Jonas Öberg');
});

test('formatHost takes the given name but can be told not to', () => {
  assert.equal(formatHost('Rohan Wagh'), 'Rohan');
  assert.equal(formatHost('Rohan Wagh', { givenNameOnly: false }), 'Rohan Wagh');
  assert.equal(formatHost(''), '—');
  assert.equal(formatHost(undefined), '—');
});

test('missing deviceSerial fails fast instead of sending a junk command', () => {
  assert.throws(
    () => buildDisplayCommand({ id: '1', visitor: NORMAN, ...base, deviceSerial: undefined }),
    /deviceSerial missing/
  );
});

test('parseScannedId accepts badge IDs and rejects everything else', () => {
  assert.equal(parseScannedId('1'), '1');
  assert.equal(parseScannedId(' 299 '), '299');
  assert.equal(parseScannedId('007'), '7', 'leading zeros must not split one visitor into two');

  // Things that will genuinely get scanned at a trade-fair booth.
  for (const junk of [
    '4006381333931',            // an EAN on some giveaway
    'https://proglove.com',     // a poster QR
    'Max;Mustermann;...',       // last year's badge format
    '',
    '   ',
    'ABC123',
    '12345678',                 // too long to be a ProPulse ID
    null,
    undefined,
  ]) {
    assert.equal(parseScannedId(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});
