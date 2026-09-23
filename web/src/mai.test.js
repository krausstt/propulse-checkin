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
          text_content: 'Nolan Wong',
          ref_id: 'field_bottom_ref',
          state: { type: 'FOCUSED', highlighted: true },
        },
      },
    },
  ],
  time_created: 1789659645191,
};

const NOLAN = { full_name: 'Nolan Wong', host: 'Rohan Wagh', badge_location: 'B-12', status: 'Registered' };

const base = {
  deviceSerial: 'MAIXBEU011089',
  gatewaySerial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  eventId: '89ec1cdd-d74b-41d5-9a9f-9351e180461e',
  now: 1789659645191,
};

test('reproduces the captured known-good payload exactly', () => {
  const out = buildDisplayCommand({ id: '1', visitor: NOLAN, ...base });
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
    () => buildDisplayCommand({ id: '1', visitor: NOLAN, ...base, deviceSerial: undefined }),
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

// ---------------------------------------------------------------------------
// pg_work5_t3 - the second capture's structure (five cells, Company, NO
// forced_orientation) with the cell states Tobias specified on 2026-09-23:
// Full Name FOCUSED+highlighted, ID SUCCESS, Badge Location FOCUSED quiet,
// Company and Host stateless. The SUCCESS type is not yet seen on a device.
// ---------------------------------------------------------------------------

const GOLDEN_T3 = {
  active_screen_view: 'SCREEN_VIEW_1',
  api_version: '3.0',
  device_serial: 'MAIXBEU011089',
  event_id: 'dfa2cf49-6670-418b-92b1-9c251a1735c7',
  event_type: 'display_v2!',
  gateway_serial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  ref_id: 'SCREEN_1',
  screen_views: [
    {
      ref_id: 'SCREEN_VIEW_1',
      pg_work5_t3: {
        title: 'ProPulse 2026 Chicago',
        field_top_left: {
          text_header: 'ID',
          text_content: '1',
          ref_id: 'field_top_left_ref',
          state: { type: 'SUCCESS', highlighted: false },
        },
        field_top_right: {
          text_header: 'Badge Location',
          text_content: 'B-12',
          ref_id: 'field_top_right_ref',
          state: { type: 'FOCUSED', highlighted: false },
        },
        field_middle_left: { text_header: 'Host', text_content: 'Rohan', ref_id: 'field_middle_left_ref' },
        field_middle_right: {
          text_header: 'Company',
          text_content: 'Anonymized Information Technology Inc',
          ref_id: 'field_middle_right_ref',
        },
        field_bottom: {
          text_header: 'Full Name of Visitor',
          text_content: 'Nolan Wong',
          ref_id: 'field_bottom_ref',
          state: { type: 'FOCUSED', highlighted: true },
        },
      },
    },
  ],
  time_created: 1790089547996,
};

const NOLAN_T3 = {
  full_name: 'Nolan Wong',
  host: 'Rohan Wagh',
  badge_location: 'B-12',
  company: 'Anonymized Information Technology Inc',
  status: 'Registered',
};

const baseT3 = {
  deviceSerial: 'MAIXBEU011089',
  gatewaySerial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  eventId: 'dfa2cf49-6670-418b-92b1-9c251a1735c7',
  now: 1790089547996,
  template: 'pg_work5_t3',
};

test('reproduces the captured pg_work5_t3 payload exactly', () => {
  const out = buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3 });
  assert.deepEqual(out, GOLDEN_T3);
});

test('pg_work5_t3 carries no forced_orientation, pg_work4_t4 does', () => {
  // Inventing a key the device has never been observed to receive is how a
  // working template becomes an unexplained rejection at the booth.
  const t3 = buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3 });
  assert.equal('forced_orientation' in t3, false);

  const t4 = buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3, template: 'pg_work4_t4' });
  assert.equal(t4.forced_orientation, 'LANDSCAPE');
});

test('pg_work5_t3 highlights the name, marks ID success and badge location focused', () => {
  const t3 = buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3 }).screen_views[0].pg_work5_t3;
  assert.deepEqual(t3.field_bottom.state, { type: 'FOCUSED', highlighted: true });
  assert.deepEqual(t3.field_top_left.state, { type: 'SUCCESS', highlighted: false });
  assert.deepEqual(t3.field_top_right.state, { type: 'FOCUSED', highlighted: false });
  assert.equal('state' in t3.field_middle_right, false, 'Company carries no state');
  assert.equal('state' in t3.field_middle_left, false, 'Host carries no state');

  const highlighted = Object.values(t3).filter(c => c?.state?.highlighted);
  assert.equal(highlighted.length, 1, 'exactly one cell is emphasised');

  const t4 = buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3, template: 'pg_work4_t4' })
    .screen_views[0].pg_work4_t4;
  assert.deepEqual(t4.field_bottom.state, { type: 'FOCUSED', highlighted: true });
});

test('a miss never shows SUCCESS on the ID', () => {
  // "Not Registered" next to a success marker tells the greeter the opposite
  // of the truth.
  const t = buildDisplayCommand({ id: '4711', visitor: null, ...baseT3 }).screen_views[0].pg_work5_t3;
  assert.equal('state' in t.field_top_left, false);
  assert.deepEqual(t.field_bottom.state, { type: 'FOCUSED', highlighted: true });
});

test('a visitor with no company still renders every cell', () => {
  // build-roster.mjs only started emitting company recently. A roster built
  // before that has the key missing on every record, and the booth must still
  // work rather than showing five blanks.
  const out = buildDisplayCommand({
    id: '9', visitor: { full_name: 'No Company', host: 'Ann Example', badge_location: 'D-01' }, ...baseT3,
  });
  const t = out.screen_views[0].pg_work5_t3;
  assert.equal(t.field_middle_right.text_content, '—');
  assert.equal(t.field_bottom.text_content, 'No Company');
});

test('an unknown ID is loud on pg_work5_t3 too', () => {
  const t = buildDisplayCommand({ id: '4711', visitor: null, ...baseT3 }).screen_views[0].pg_work5_t3;
  assert.equal(t.field_bottom.text_header, 'Not Registered');
  assert.equal(t.field_bottom.text_content, 'ID 4711');
  assert.equal(t.field_top_left.text_content, '4711');
});

test('an unknown template is refused rather than silently sent', () => {
  assert.throws(
    () => buildDisplayCommand({ id: '1', visitor: NOLAN_T3, ...baseT3, template: 'pg_work9_t9' }),
    /unknown template/
  );
});
