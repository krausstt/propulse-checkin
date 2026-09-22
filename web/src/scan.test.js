import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, mergeSerials, decodeBase64Url } from './scan.js';

const scanFrame = (over = {}) => JSON.stringify({
  api_version: '1.0',
  event_type: 'scan',
  event_id: 'e-1',
  time_created: 1790089547996,
  scan_code: '1',
  device_serial: 'MAIXBEU011089',
  device_model: 'MAI',
  gateway_serial: 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e',
  ...over,
});

test('a documented scan event yields the barcode and both serials', () => {
  const f = parseFrame(scanFrame());
  assert.equal(f.kind, 'scan');
  assert.equal(f.code, '1');
  assert.equal(f.serials.device_serial, 'MAIXBEU011089');
  assert.equal(f.serials.gateway_serial, 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e');
  assert.equal(f.deviceModel, 'MAI');
});

test('a trailing line feed does not break the parse', () => {
  // Streams API terminates messages with LF on the serial transports. Whether
  // INSIGHT Mobile does the same over WebSocket is unverified.
  assert.equal(parseFrame(scanFrame() + '\n').kind, 'scan');
  assert.equal(parseFrame('  ' + scanFrame() + '\r\n').code, '1');
});

test('the barcode is found even if the key is not the documented one', () => {
  // docs.proglove.com is unreachable from the build environment, so the key
  // name is a search-summary claim. Be generous rather than silent.
  for (const key of ['scan_code', 'scan_data', 'barcode', 'code', 'data', 'content']) {
    const frame = JSON.parse(scanFrame());
    delete frame.scan_code;
    frame[key] = '42';
    assert.equal(parseFrame(JSON.stringify(frame)).code, '42', `key ${key}`);
  }
});

test('a base64 scan_bytes payload is decoded when no text field exists', () => {
  const frame = JSON.parse(scanFrame());
  delete frame.scan_code;
  frame.scan_bytes = Buffer.from('299').toString('base64url');
  assert.equal(parseFrame(JSON.stringify(frame)).code, '299');
});

test('a scan whose shape surprises us is reported, never guessed at', () => {
  const frame = JSON.parse(scanFrame());
  delete frame.scan_code;
  const f = parseFrame(JSON.stringify(frame));
  assert.equal(f.kind, 'scan');
  assert.equal(f.code, null, 'a null code makes the caller log it instead of greeting the wrong person');
});

test('garbage never throws - an onmessage handler that throws stops the booth', () => {
  for (const junk of ['', '   ', 'not json', '[1,2,3]', 'null', '"a string"', undefined, null, 42, {}]) {
    const f = parseFrame(junk);
    assert.ok(typeof f.kind === 'string', `should classify ${JSON.stringify(junk)}`);
  }
  assert.equal(parseFrame('not json').kind, 'unparseable');
  assert.equal(parseFrame('[1,2,3]').kind, 'other', 'an array is an object to JSON, so it falls through');
});

test('error frames are classified', () => {
  assert.equal(parseFrame(JSON.stringify({ event_type: 'errors', errors: [{ message: 'bad ref_id' }] })).kind, 'error');
  assert.equal(parseFrame(JSON.stringify({ errors: [{ message: 'x' }] })).kind, 'error');
});

test('an ack is recognised under any of the plausible key names', () => {
  for (const key of ['ack_event_id', 'acknowledged_event_id', 'ref_event_id']) {
    const f = parseFrame(JSON.stringify({ event_type: 'ping', [key]: 'cmd-1' }));
    assert.equal(f.kind, 'ack');
    assert.equal(f.ackFor, 'cmd-1');
  }
});

test('an unknown event type is kept rather than discarded', () => {
  const f = parseFrame(JSON.stringify({ event_type: 'scanner_state', device_serial: 'X' }));
  assert.equal(f.kind, 'other');
  assert.equal(f.eventType, 'scanner_state');
  assert.equal(f.serials.device_serial, 'X');
});

test('serials merge and never erase each other', () => {
  // If the scan event turns out to carry only device_serial, a later frame
  // must not wipe the gateway_serial we learned earlier.
  let s = {};
  ({ serials: s } = mergeSerials(s, { device_serial: 'A', gateway_serial: 'B' }));
  const after = mergeSerials(s, { device_serial: 'A' });
  assert.deepEqual(after.serials, { device_serial: 'A', gateway_serial: 'B' });
  assert.equal(after.changed, false, 'no change means no log spam on every scan');

  const swapped = mergeSerials(s, { device_serial: 'C' });
  assert.equal(swapped.serials.device_serial, 'C');
  assert.equal(swapped.serials.gateway_serial, 'B');
  assert.equal(swapped.changed, true);
});

test('base64url decoding fails soft', () => {
  assert.equal(decodeBase64Url('!!!not base64!!!'), null);
  assert.equal(decodeBase64Url(''), null);
});
