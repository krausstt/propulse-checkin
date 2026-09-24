/**
 * ws.js - the single link to INSIGHT Mobile's WebSocket server.
 *
 * INSIGHT Mobile hosts the server inside the app on ws://localhost:9998. We are
 * the client, in the FOREGROUND DOCUMENT. Never move this into a service
 * worker: local network requests from a service worker fail by specification.
 *
 * THE SAFE SUPERSET
 * -----------------
 * Chrome 147 put Local Network Access in front of loopback WebSockets, and
 * whether Android prompts or hard-fails is still unverified. Rather than guess,
 * this manager is built so that it is correct under EVERY outcome:
 *
 *  1. Before the first successful connect, ONLY a user gesture may attempt one.
 *     If the gate prompts, a gesture is required and we have one. If it does
 *     not prompt, a gesture costs nothing. And critically: three dismissals
 *     permanently block the origin with no in-app recovery, so the code must
 *     never be able to spray attempts at a prompt nobody is looking at.
 *  2. After one success, the permission (if any) is granted, so automatic
 *     reconnects are safe and unlimited. This is the state the booth runs in.
 *  3. If an automatic reconnect run fails repeatedly, we stop and ask for a tap
 *     again, rather than looping forever against a revoked grant.
 *
 * Script cannot distinguish "LNA blocked" from "nothing listening" - both fail
 * in milliseconds and the WebSocket API hides the reason. So this file never
 * claims to know which it was. It reports the fact and lets the UI say so.
 */

import { parseFrame, mergeSerials } from './scan.js';

export const DEFAULT_URL = 'ws://localhost:9998';

export const BACKOFF = { baseMs: 500, maxMs: 15_000, jitter: 1.0 };

/** After this many consecutive automatic failures, stop and require a tap.
 *  Six attempts is roughly a minute of backoff: long enough to ride out a
 *  restart of INSIGHT Mobile, short enough that a revoked grant does not
 *  spin silently for the whole show. */
export const AUTO_ATTEMPT_LIMIT = 6;

/** A backgrounded Android tab gets its socket killed without a close event, so
 *  a socket that says OPEN after a long gap may be a zombie. On resume, any gap
 *  longer than this is treated as "reconnect rather than trust it". Cheap,
 *  because by then the permission is already granted. */
export const ZOMBIE_GAP_MS = 20_000;

/** INSIGHT Mobile's command queue is only 5 deep. Displays are coalesced to the
 *  latest, because the visitor standing at the booth is the one on the screen. */
export const SEND_INTERVAL_MS = 300;

/** Full jitter. Five phones losing WiFi together must not reconnect together. */
export function backoffDelay(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (1 - BACKOFF.jitter + BACKOFF.jitter * random()));
}

/**
 * The whole safety rule, in one testable function.
 * @param {object} s {everConnected, autoAttempts, closedByUser}
 */
export function mayAutoConnect(s) {
  if (s.closedByUser) return { ok: false, reason: 'disconnected by user' };
  if (!s.everConnected) return { ok: false, reason: 'needs a tap: no successful connect yet on this origin' };
  if (s.autoAttempts >= AUTO_ATTEMPT_LIMIT) return { ok: false, reason: 'needs a tap: automatic retries exhausted' };
  return { ok: true, reason: '' };
}

/** JSON-stringify with every MAI cell's text replaced. Headers stay, because
 *  "Company" or "Full Name of Visitor" is exactly what makes an error readable. */
export function redactDisplayText(value) {
  return JSON.stringify(value, (k, v) => (k === 'text_content' || k === 'title' ? '[redacted]' : v));
}

/**
 * What an INSIGHT Mobile error code means for the person holding the phone.
 * Only codes actually observed on hardware get specific advice; anything else
 * is passed through verbatim rather than guessed at.
 */
export function adviceFor(code, msg = {}) {
  if (code === 'ERROR_DEVICE_NOT_FOUND') {
    return isPlaceholderSerial(msg.device_serial)
      ? 'INSIGHT Mobile reports NO scanner connected at all. Open INSIGHT Mobile and pair the MAI there (its own pairing barcode), not in Android Bluetooth settings.'
      : 'INSIGHT Mobile has no connected scanner with the serial we addressed. Scan one badge so the app learns the right serial, or check the MAI is paired in INSIGHT Mobile.';
  }
  return '';
}

/** INSIGHT Mobile fills device_serial with a human-readable placeholder when it
 *  has no scanner. Never treat such a value as a serial. */
export function isPlaceholderSerial(v) {
  return typeof v !== 'string' || !v.trim() || /^<.*>$/.test(v.trim()) || /missing/i.test(v);
}

export class ScannerLink {
  /**
   * @param {object} opts
   * @param {string} [opts.url]
   * @param {(url:string)=>WebSocket} [opts.socketFactory] injected for tests
   * @param {()=>number} [opts.now]
   * @param {()=>number} [opts.random]
   * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers]
   */
  constructor({
    url = DEFAULT_URL,
    socketFactory = u => new WebSocket(u),
    now = Date.now,
    random = Math.random,
    // Wrapped, not passed by reference. Pulling setTimeout off the global and
    // calling it as this._timers.setTimeout(...) rebinds the receiver, and
    // Chrome throws "Illegal invocation" for a WindowTimers method called on
    // anything that is not the window. Node does not care, so this only ever
    // fails on the device - which is exactly why tools/e2e.mjs drives a real
    // browser rather than trusting the unit tests.
    timers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id),
    },
  } = {}) {
    this.url = url;
    this._socketFactory = socketFactory;
    this._now = now;
    this._random = random;
    this._timers = timers;

    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | backoff | needs-tap
    this.serials = {};
    this.everConnected = false;
    this.autoAttempts = 0;
    this.closedByUser = false;
    this.lastFrameAt = null;
    this.lastOpenAt = null;

    this._retryTimer = null;
    this._sendTimer = null;
    this._pendingDisplay = null;
    this._lastSentAt = 0;

    /** @type {{status:Function[], scan:Function[], log:Function[], serials:Function[]}} */
    this._handlers = { status: [], scan: [], log: [], serials: [], 'insight-error': [] };
  }

  on(event, fn) {
    this._handlers[event]?.push(fn);
    return this;
  }
  _emit(event, ...args) {
    for (const fn of this._handlers[event] ?? []) {
      // A throwing UI handler must never take the socket down with it.
      try { fn(...args); } catch (e) { console.error('handler threw', e); }
    }
  }
  _log(msg, level = 'info') {
    this._emit('log', { msg, level, at: this._now() });
  }
  _setState(state, detail = '') {
    this.state = state;
    this._emit('status', { state, detail, serials: this.serials, everConnected: this.everConnected });
  }

  // --- connecting --------------------------------------------------------

  /** Call this from a click handler and nowhere else. */
  connectFromUserGesture() {
    this.closedByUser = false;
    this.autoAttempts = 0;
    this._clearRetry();
    this._open('user tap');
  }

  /** Any non-gesture path: resume, online, visibility, retry. Gated. */
  connectIfAllowed(reason) {
    const gate = mayAutoConnect(this);
    if (!gate.ok) {
      this._setState(this.state === 'open' ? 'open' : 'needs-tap', gate.reason);
      return false;
    }
    this._open(reason);
    return true;
  }

  _open(reason) {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return; // already up
    this._setState('connecting', reason);
    this._log(`connecting to ${this.url} (${reason})`);

    let ws;
    try {
      ws = this._socketFactory(this.url);
    } catch (e) {
      // A synchronous throw here is a mixed-content or bad-URL rejection, not
      // a network failure. It will never succeed on retry, so say so loudly.
      this._log(`WebSocket constructor threw ${e.name}: ${e.message}`, 'error');
      this._setState('needs-tap', 'the URL was rejected outright');
      return;
    }
    this.ws = ws;

    // Every handler below checks that it still belongs to the CURRENT socket.
    // On a phone, close() is asynchronous: when a resume replaces a zombie, the
    // old socket's onclose fires after the new one is already connecting, and
    // without this guard it nulled this.ws (orphaning the new socket) and
    // booked a retry that opened a THIRD one. Seen on hardware 2026-09-24:
    // "CLOSE ... OPEN ... connecting (auto retry 0) ... OPEN". Two live sockets
    // means every scan handled twice and every display sent twice into a
    // five-deep queue.
    const current = () => this.ws === ws;

    ws.onopen = () => {
      if (!current()) { try { ws.close(); } catch {} return; }
      this.everConnected = true;
      this.autoAttempts = 0;
      this.lastOpenAt = this._now();
      this.lastFrameAt = this._now();
      this._log('socket OPEN - loopback reachable', 'ok');
      this._setState('open', '');
    };

    ws.onmessage = ev => {
      if (!current()) return;
      this.lastFrameAt = this._now();
      this._handleFrame(ev.data);
    };

    ws.onerror = () => {
      if (!current()) return;
      // Deliberately vague, because the API is. Do not invent a cause.
      this._log('socket error (script cannot tell LNA-blocked from nothing-listening)', 'error');
    };

    ws.onclose = ev => {
      if (!current()) return; // a socket we already replaced; not news
      const wasOpen = this.state === 'open';
      this.ws = null;
      this._log(`socket CLOSE code=${ev.code} clean=${ev.wasClean}`, wasOpen ? 'warn' : 'error');
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    if (this.closedByUser) { this._setState('idle', 'disconnected by user'); return; }
    // Gate on the count so far, not on the incremented one: AUTO_ATTEMPT_LIMIT
    // is the number of retries allowed, so the Nth retry must still be let
    // through and only the N+1th refused.
    const gate = mayAutoConnect(this);
    if (!gate.ok) { this._setState('needs-tap', gate.reason); return; }

    this.autoAttempts += 1;
    const delay = backoffDelay(this.autoAttempts, this._random);
    this._setState('backoff', `retry ${this.autoAttempts}/${AUTO_ATTEMPT_LIMIT} in ${delay}ms`);
    this._clearRetry();
    this._retryTimer = this._timers.setTimeout(() => {
      this._retryTimer = null;
      // The budget was spent when this retry was booked, so open directly.
      // Re-running the gate here would refuse the last retry it just allowed -
      // two gates on one decision is how a retry budget quietly loses a slot.
      // disconnect() cancels this timer, but re-check anyway: it is the one
      // state where continuing would override an explicit user action.
      if (this.closedByUser) return;
      this._open(`auto retry ${this.autoAttempts}`);
    }, delay);
  }

  _clearRetry() {
    if (this._retryTimer !== null) { this._timers.clearTimeout(this._retryTimer); this._retryTimer = null; }
  }

  /**
   * Called on visibilitychange/pageshow/online.
   *
   * Timestamps, not timer ticks: a backgrounded Android tab has its timers
   * frozen and its socket killed without a close event, so on resume the only
   * trustworthy signal is how much wall-clock time has passed.
   */
  resume(reason) {
    const gap = this.lastFrameAt === null ? Infinity : this._now() - this.lastFrameAt;
    if (this.state === 'open' && gap > ZOMBIE_GAP_MS) {
      this._log(`resumed after ${Math.round(gap / 1000)}s - assuming the socket is a zombie`, 'warn');
      this._clearRetry();
      const zombie = this.ws;
      this.ws = null; // first, so the zombie's late onclose is ignored
      try { zombie?.close(); } catch {}
      this.autoAttempts = 0;
      this.connectIfAllowed(`${reason} (zombie)`);
      return;
    }
    if (this.state !== 'open' && this.state !== 'connecting') {
      this.autoAttempts = 0; // a resume is a fresh chance, not a continued run
      this.connectIfAllowed(reason);
    }
  }

  disconnect() {
    this.closedByUser = true;
    this._clearRetry();
    const old = this.ws;
    this.ws = null;
    try { old?.close(); } catch {}
    this._setState('idle', 'disconnected by user');
  }

  // --- inbound -----------------------------------------------------------

  _handleFrame(raw) {
    const frame = parseFrame(raw);

    // Serials are learned from SCAN events only. INSIGHT Mobile's error frames
    // carry device_serial too, but when no scanner is connected that value is
    // the literal placeholder "<Missing Scanner Serial Number Data>" - learning
    // from it (as lna-test.html did on 2026-09-24) addresses every later
    // command to a device that does not exist.
    if (frame.kind === 'scan' && frame.serials && Object.keys(frame.serials).length) {
      const { serials, changed } = mergeSerials(this.serials, frame.serials);
      if (changed) {
        this.serials = serials;
        this._log(`learned serials ${JSON.stringify(serials)}`, 'ok');
        this._emit('serials', serials);
      }
    }

    switch (frame.kind) {
      case 'scan':
        if (frame.code === null) {
          this._log(`scan event with no recognisable barcode field: ${raw}`, 'warn');
          return;
        }
        this._emit('scan', frame);
        return;
      case 'error': {
        // An error frame may echo our display command back, and that command
        // carries a visitor's name and company. The log can be copied off the
        // phone (Copy log), so every displayed text is redacted before logging.
        const e = frame.msg;
        const code = e.error_code ?? '(no code)';
        this._log(
          `INSIGHT Mobile ERROR ${code}: ${e.error_message ?? ''}` +
          `${e.event_reference_id ? ` (for command ${e.event_reference_id})` : ''} :: ${redactDisplayText(frame.errors)}`,
          'error'
        );
        this._emit('insight-error', { code, message: e.error_message ?? '', advice: adviceFor(code, e), msg: e });
        return;
      }
      case 'ack':
        this._log(`ACK from INSIGHT Mobile for ${frame.ackFor}: ${redactDisplayText(frame.msg)}`, 'ok');
        return;
      case 'unparseable':
        this._log(`unparseable frame (${frame.reason})`, 'warn');
        return;
      default:
        // Unknown shapes are logged with displayed text redacted. This is where
        // an ack or an error we did not anticipate would otherwise vanish.
        this._log(`frame ${frame.kind}${frame.eventType ? ` ${frame.eventType}` : ''}: ${redactDisplayText(frame.msg)}`, 'dim');
    }
  }

  // --- outbound ----------------------------------------------------------

  /**
   * Queue a display command. Coalesced to the latest, because the command queue
   * is only five deep and the visitor at the booth is the one on the screen -
   * a backlog of stale greetings is worse than dropping them.
   */
  sendDisplay(command) {
    this._pendingDisplay = command;
    this._flushSoon();
  }

  _flushSoon() {
    if (this._sendTimer !== null) return;
    const since = this._now() - this._lastSentAt;
    const wait = Math.max(0, SEND_INTERVAL_MS - since);
    this._sendTimer = this._timers.setTimeout(() => {
      this._sendTimer = null;
      this._flushNow();
    }, wait);
  }

  /** Immediate send for the diagnostics panel. Bypasses coalescing on
   *  purpose: a bisection probe must go out exactly once, exactly now. */
  sendNow(command) {
    if (!this.ws || this.ws.readyState !== 1) { this._log('probe not sent: socket not open', 'error'); return false; }
    try { this.ws.send(JSON.stringify(command)); return true; }
    catch (e) { this._log(`probe send failed: ${e.message}`, 'error'); return false; }
  }

  _flushNow() {
    const cmd = this._pendingDisplay;
    if (!cmd) return;
    if (!this.ws || this.ws.readyState !== 1) {
      this._log('display dropped: socket not open', 'warn');
      this._pendingDisplay = null;
      return;
    }
    this._pendingDisplay = null;
    this._lastSentAt = this._now();
    try {
      this.ws.send(JSON.stringify(cmd));
      this._log(`-> display_v2! ${cmd.event_id}`, 'dim');
    } catch (e) {
      this._log(`send failed: ${e.message}`, 'error');
    }
  }
}
