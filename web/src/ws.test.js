import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScannerLink, backoffDelay, mayAutoConnect,
  BACKOFF, AUTO_ATTEMPT_LIMIT, ZOMBIE_GAP_MS, SEND_INTERVAL_MS,
} from './ws.js';

/** A WebSocket stand-in we drive by hand. readyState follows the real enum. */
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.made.push(this); }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }
  _open() { this.readyState = 1; this.onopen?.(); }
  _fail(code = 1006) { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code, wasClean: false }); }
  _message(data) { this.onmessage?.({ data }); }
  static made = [];
}

/** Manual clock and timer queue, so nothing in these tests is time-dependent. */
function harness() {
  FakeSocket.made = [];
  let now = 1_000_000;
  let seq = 0;
  const queued = new Map();
  const timers = {
    setTimeout: (fn, ms) => { const id = ++seq; queued.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => queued.delete(id),
  };
  const advance = ms => {
    now += ms;
    for (const [id, t] of [...queued].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) { queued.delete(id); t.fn(); }
    }
  };
  const link = new ScannerLink({
    socketFactory: u => new FakeSocket(u),
    now: () => now,
    random: () => 1,             // full jitter at maximum == the plain ceiling
    timers,
  });
  return { link, advance, setNow: v => { now = v; }, getNow: () => now, sockets: FakeSocket.made, queued };
}

const scanFrame = code => JSON.stringify({
  event_type: 'scan', event_id: 'e1', scan_code: code,
  device_serial: 'MAIXBEU011089', gateway_serial: 'GW-1',
});

// --- the safety rule -------------------------------------------------------

test('nothing may auto-connect before one successful connect on this origin', () => {
  // Three prompt dismissals permanently block the origin with no in-app
  // recovery. Automatic attempts before a grant exists are the one thing that
  // could burn through them without anybody looking at the screen.
  const r = mayAutoConnect({ everConnected: false, autoAttempts: 0, closedByUser: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /needs a tap/);
});

test('after one success, automatic reconnects are allowed', () => {
  assert.equal(mayAutoConnect({ everConnected: true, autoAttempts: 0, closedByUser: false }).ok, true);
});

test('an exhausted retry run falls back to asking for a tap', () => {
  const r = mayAutoConnect({ everConnected: true, autoAttempts: AUTO_ATTEMPT_LIMIT, closedByUser: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exhausted/);
});

test('an explicit disconnect is not undone by a resume', () => {
  assert.equal(mayAutoConnect({ everConnected: true, autoAttempts: 0, closedByUser: true }).ok, false);
});

test('a first failure does not retry, it asks for a tap', () => {
  const { link, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._fail();
  assert.equal(link.state, 'needs-tap');
  assert.equal(sockets.length, 1, 'exactly one attempt, never a silent second');
});

// --- backoff ---------------------------------------------------------------

test('backoff grows, caps, and is jittered', () => {
  const ceilings = [1, 2, 3, 4, 5, 6, 7, 8].map(a => backoffDelay(a, () => 1));
  assert.deepEqual(ceilings.slice(0, 4), [500, 1000, 2000, 4000]);
  assert.ok(ceilings.every(d => d <= BACKOFF.maxMs));
  assert.equal(ceilings.at(-1), BACKOFF.maxMs);
  assert.equal(backoffDelay(3, () => 0), 0, 'full jitter can retry immediately');
  assert.ok(backoffDelay(3, () => 1) > backoffDelay(3, () => 0), 'five phones must not reconnect in lockstep');
});

// --- the running state -----------------------------------------------------

test('once connected, a drop reconnects automatically', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  assert.equal(link.state, 'open');

  sockets[0]._fail();
  assert.equal(link.state, 'backoff');
  advance(600);
  assert.equal(sockets.length, 2, 'it retried without needing another tap');
});

test('automatic retries stop at the limit instead of spinning all show', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  for (let i = 0; i < AUTO_ATTEMPT_LIMIT + 2; i++) {
    sockets.at(-1)._fail();
    advance(BACKOFF.maxMs + 1);
  }
  assert.equal(link.state, 'needs-tap');
  assert.equal(sockets.length, AUTO_ATTEMPT_LIMIT + 1, 'one tap plus exactly the allowed retries');
});

test('a successful reconnect resets the retry budget', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  sockets[0]._fail();
  advance(600);
  sockets[1]._open();
  assert.equal(link.autoAttempts, 0);
});

// --- resume ----------------------------------------------------------------

test('a resume after a long gap replaces a socket that still claims to be open', () => {
  // Android kills a backgrounded tab's socket without a close event, so
  // readyState OPEN is not evidence of anything after a long absence. Only
  // wall-clock time is, which is why liveness is measured on timestamps and
  // not on timer ticks that were frozen along with the tab.
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();

  advance(ZOMBIE_GAP_MS + 1000);
  link.resume('visibilitychange');
  assert.equal(sockets.length, 2, 'the zombie was replaced');
});

test('a resume after a short gap leaves a healthy socket alone', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  advance(1000);
  link.resume('visibilitychange');
  assert.equal(sockets.length, 1);
  assert.equal(link.state, 'open');
});

test('a resume before any successful connect still does not auto-connect', () => {
  const { link, sockets } = harness();
  link.resume('pageshow');
  assert.equal(sockets.length, 0, 'the prompt is never fired at a phone nobody is looking at');
  assert.equal(link.state, 'needs-tap');
});

test('a resume revives a link that had given up', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  for (let i = 0; i < AUTO_ATTEMPT_LIMIT + 1; i++) { sockets.at(-1)._fail(); advance(BACKOFF.maxMs + 1); }
  assert.equal(link.state, 'needs-tap');

  const before = sockets.length;
  link.resume('online');
  assert.equal(sockets.length, before + 1, 'coming back online is a fresh chance');
});

// --- inbound ---------------------------------------------------------------

test('serials are learned from the scan event, never hardcoded per phone', () => {
  // This is what lets five SureMDM devices run one identical build.
  const { link, sockets } = harness();
  const learned = [];
  link.on('serials', s => learned.push(s));
  link.connectFromUserGesture();
  sockets[0]._open();
  sockets[0]._message(scanFrame('1'));

  assert.deepEqual(link.serials, { device_serial: 'MAIXBEU011089', gateway_serial: 'GW-1' });
  assert.equal(learned.length, 1);
  sockets[0]._message(scanFrame('2'));
  assert.equal(learned.length, 1, 'unchanged serials do not re-emit on every scan');
});

test('scans are emitted, junk is logged and swallowed', () => {
  const { link, sockets } = harness();
  const scans = [];
  const logs = [];
  link.on('scan', f => scans.push(f.code)).on('log', l => logs.push(l));
  link.connectFromUserGesture();
  sockets[0]._open();

  sockets[0]._message(scanFrame('1'));
  sockets[0]._message('this is not json');
  sockets[0]._message(JSON.stringify({ event_type: 'scan', device_serial: 'X' })); // no barcode

  assert.deepEqual(scans, ['1'], 'only the real scan reached the app');
  assert.ok(logs.some(l => /unparseable/.test(l.msg)));
  assert.ok(logs.some(l => /no recognisable barcode/.test(l.msg)));
});

test('a throwing UI handler does not take the socket down', () => {
  const { link, sockets } = harness();
  link.on('scan', () => { throw new Error('UI bug'); });
  link.connectFromUserGesture();
  sockets[0]._open();
  sockets[0]._message(scanFrame('1'));
  assert.equal(link.state, 'open');
});

// --- outbound --------------------------------------------------------------

test('display sends are coalesced to the latest - the queue is only 5 deep', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();

  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) link.sendDisplay({ event_id: id });
  advance(SEND_INTERVAL_MS + 1);

  assert.equal(sockets[0].sent.length, 1, 'seven scans must not become seven queued commands');
  assert.equal(JSON.parse(sockets[0].sent[0]).event_id, 'g', 'the visitor at the booth is the one on screen');
});

test('sends are spaced by at least the debounce interval', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();

  link.sendDisplay({ event_id: '1' });
  advance(SEND_INTERVAL_MS + 1);
  link.sendDisplay({ event_id: '2' });
  advance(1);
  assert.equal(sockets[0].sent.length, 1, 'the second is held back, not fired immediately');
  advance(SEND_INTERVAL_MS);
  assert.equal(sockets[0].sent.length, 2);
});

test('a display sent while the socket is down is dropped, not queued forever', () => {
  // A greeting is only meaningful while the visitor is standing there. The
  // check-in outbox is what must survive an outage; the display is not.
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  sockets[0]._fail();

  link.sendDisplay({ event_id: 'stale' });
  advance(SEND_INTERVAL_MS + 1);
  assert.equal(sockets[0].sent.length, 0);
});

test('disconnecting is sticky until the next tap', () => {
  const { link, advance, sockets } = harness();
  link.connectFromUserGesture();
  sockets[0]._open();
  link.disconnect();
  assert.equal(link.state, 'idle');

  link.resume('visibilitychange');
  advance(60_000);
  assert.equal(sockets.length, 1, 'a user who turned it off stays off');

  link.connectFromUserGesture();
  assert.equal(sockets.length, 2);
});
