/**
 * scan.js - reading what INSIGHT Mobile sends us.
 *
 * INSIGHT Mobile hosts the WebSocket server; we are the client. Everything
 * inbound is a Streams API JSON message. The one we care about is the scan
 * event, which per the docs carries:
 *
 *   event_type "scan", event_id, time_created, api_version,
 *   scan_code    the decoded barcode, as text
 *   scan_bytes   the same thing base64 (URL-safe alphabet)
 *   device_serial, device_model, gateway_serial
 *
 * That field list came from a search summary, NOT from the documentation
 * itself - docs.proglove.com is unreachable from the build environment. So
 * this parser does not trust it. It looks for the barcode under several
 * plausible keys, keeps the raw frame either way, and never throws. A booth
 * that logs "unrecognised frame" is debuggable; one that throws inside an
 * onmessage handler silently stops greeting people.
 *
 * Pure functions. No socket, no clock.
 */

/**
 * Streams API messages over the Gateway's serial transports are terminated
 * with a line feed. Whether INSIGHT Mobile does the same over WebSocket is
 * unverified, so trim rather than find out at the booth.
 */
export function parseFrame(raw) {
  if (typeof raw !== 'string') {
    return { kind: 'unparseable', reason: `frame was ${typeof raw}, not text`, raw };
  }
  const text = raw.trim();
  if (!text) return { kind: 'unparseable', reason: 'empty frame', raw };

  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    return { kind: 'unparseable', reason: `not JSON: ${e.message}`, raw: text };
  }
  if (!msg || typeof msg !== 'object') {
    return { kind: 'unparseable', reason: 'JSON was not an object', raw: text };
  }

  const type = typeof msg.event_type === 'string' ? msg.event_type : '';
  const serials = readSerials(msg);

  // "scan" is documented; "scan!" would follow the command naming convention
  // and costs nothing to accept. Anything starting with scan_ is ours too.
  if (type === 'scan' || type === 'scan!' || type.startsWith('scan_')) {
    const code = readScanCode(msg);
    return {
      kind: 'scan',
      code,                       // may be null if the shape surprised us
      serials,
      eventId: msg.event_id ?? null,
      timeCreated: msg.time_created ?? null,
      deviceModel: msg.device_model ?? null,
      msg,
    };
  }

  if (type === 'errors' || type === 'error' || Array.isArray(msg.errors)) {
    return { kind: 'error', errors: msg.errors ?? [msg], serials, msg };
  }

  // Display acks come back referencing the command's event_id. Which key
  // carries it is unverified, so accept the obvious candidates.
  const ackFor = msg.ack_event_id ?? msg.acknowledged_event_id ?? msg.ref_event_id ?? null;
  if (ackFor) return { kind: 'ack', ackFor, serials, msg };

  if (type === 'ping' || type === 'pong') return { kind: type, serials, msg };

  return { kind: 'other', eventType: type || '(none)', serials, msg };
}

/**
 * The barcode. scan_code is the documented key; the rest are cheap insurance.
 * scan_bytes is base64 and is only used if no text field turned up, because
 * decoding it costs a guess about the alphabet.
 */
function readScanCode(msg) {
  for (const key of ['scan_code', 'scan_data', 'barcode', 'code', 'data', 'content']) {
    const v = msg[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // scan_data_base64 is the Streams API 3.6.6 name; scan_bytes is what an
  // earlier search summary claimed. Accept both.
  for (const key of ['scan_data_base64', 'scan_bytes']) {
    if (typeof msg[key] === 'string' && msg[key].trim()) {
      const decoded = decodeBase64Url(msg[key].trim());
      if (decoded) return decoded;
    }
  }
  return null;
}

/**
 * URL-safe base64, per the docs. Returns null rather than throwing: a barcode
 * we cannot decode is a logged oddity, not a crash.
 */
export function decodeBase64Url(s) {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim() || null;
  } catch {
    return null;
  }
}

/**
 * This is the whole point of learning serials at runtime.
 *
 * CLAUDE.md lists "does the scan event really carry BOTH serials?" as open. If
 * it does, nothing is hardcoded per phone and five SureMDM devices run one
 * identical build. If it turns out to carry only device_serial, we find out
 * here, in the log, rather than by shipping a config file per phone.
 */
function readSerials(msg) {
  const out = {};
  for (const k of ['device_serial', 'gateway_serial']) {
    const v = msg[k];
    // "<Missing Scanner Serial Number Data>" is what INSIGHT Mobile puts in
    // device_serial when no scanner is connected (observed 2026-09-24).
    if (typeof v === 'string' && v.trim() && !/^<.*>$/.test(v.trim()) && !/missing/i.test(v)) out[k] = v.trim();
  }
  return out;
}

/**
 * Remember serials across frames.
 *
 * A display command needs device_serial, and the scan event is where we learn
 * it. Merge rather than replace, because a later frame carrying only one of
 * the two must not erase the other.
 */
export function mergeSerials(known, incoming) {
  const merged = { ...known };
  let changed = false;
  for (const k of ['device_serial', 'gateway_serial']) {
    if (incoming[k] && merged[k] !== incoming[k]) { merged[k] = incoming[k]; changed = true; }
  }
  return { serials: merged, changed };
}
