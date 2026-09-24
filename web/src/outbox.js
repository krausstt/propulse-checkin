/**
 * outbox.js - append-only check-in log with a local queue.
 *
 * Every badge scan produces exactly one immutable check-in record with a
 * client-generated idempotency key. The record is written locally FIRST and
 * uploaded whenever the network allows. A scan is never blocked on the network:
 * on a trade-fair floor the WiFi is the least reliable component in the system,
 * and a greeter waiting on a spinner is a worse failure than a late upload.
 *
 * Append-only means nothing here ever edits or deletes a check-in. The only
 * mutable state is delivery bookkeeping (attempts, next_attempt_at), kept
 * beside the record rather than inside it.
 *
 * Pure functions, injected clock and randomness - same contract as mai.js.
 */

/** Delivery states. The check-in itself is immutable; only this moves. */
export const PENDING = 'pending';
export const SENT = 'sent';

/**
 * Backoff. Capped at 60s because the realistic outage is a 30-second WiFi
 * roam between booth and hall, not an hour-long outage - waiting 15 minutes to
 * retry after a blip would leave check-ins unsent until someone noticed.
 */
export const BACKOFF = {
  baseMs: 1000,
  maxMs: 60_000,
  /** Full jitter. Ten phones all losing WiFi at the same moment must not all
   *  retry at the same moment; that is how you turn an outage into a stampede. */
  jitter: 1.0,
};

/**
 * @param {object} p
 * @param {string} p.id            normalised ProPulse ID, as scanned
 * @param {string} p.uuid          client-generated idempotency key (crypto.randomUUID)
 * @param {string} p.deviceId      which phone recorded it
 * @param {number} p.now           epoch millis
 * @param {boolean} p.matched      did the roster know this ID?
 */
export function createCheckin({ id, uuid, deviceId, now, matched }) {
  if (!id) throw new Error('createCheckin: id required');
  if (!uuid) throw new Error('createCheckin: uuid required - it is the idempotency key');
  if (!deviceId) throw new Error('createCheckin: deviceId required');
  if (!Number.isFinite(now)) throw new Error('createCheckin: now must be epoch millis');

  return {
    // --- immutable check-in ---
    idempotency_key: uuid,
    propulse_id: id,
    device_id: deviceId,
    scanned_at: new Date(now).toISOString(),
    // Recorded because an unmatched scan is the signal that the roster is stale
    // or the badge is a walk-in. Counting them at the end of day 1 is how we
    // find out whether a re-export is needed before day 2.
    matched: Boolean(matched),

    // --- delivery bookkeeping ---
    status: PENDING,
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
  };
}

/**
 * Suppress the scanner's own double-fire.
 *
 * A ProGlove scanner can emit the same barcode twice in quick succession, and a
 * greeter waving a badge can genuinely re-scan. Both look identical to us, so
 * the rule is time-based: the same ID inside the window is one visit.
 *
 * Deliberately NOT done in the outbox transitions - this decides whether a
 * check-in exists at all, and the outbox must never drop one it has accepted.
 */
export const DEDUPE_WINDOW_MS = 10_000;

export function isDuplicateScan(recent, id, now, windowMs = DEDUPE_WINDOW_MS) {
  for (const r of recent) {
    if (r.propulse_id !== id) continue;
    const at = Date.parse(r.scanned_at);
    if (Number.isFinite(at) && now - at < windowMs && now >= at) return true;
  }
  return false;
}

/**
 * Which records are due for an upload attempt right now.
 *
 * Sorted oldest-first so that a long offline stretch drains in the order it
 * happened, and capped so one flush cannot build a 900-item request that the
 * venue WiFi will time out halfway through.
 */
export function dueForSend(records, now, max = 25) {
  return records
    .filter(r => r.status === PENDING && r.next_attempt_at <= now)
    .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
    .slice(0, max);
}

/** Returns a NEW record - callers persist the result. Never mutates. */
export function markSent(record, now) {
  return { ...record, status: SENT, sent_at: new Date(now).toISOString(), last_error: null };
}

/**
 * @param {() => number} random - injected so the jitter is testable
 */
export function markFailed(record, { now, error, random = Math.random }) {
  const attempts = record.attempts + 1;
  const ceiling = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** (attempts - 1));
  const delay = Math.round(ceiling * (1 - BACKOFF.jitter + BACKOFF.jitter * random()));
  return {
    ...record,
    status: PENDING, // never abandoned: an undelivered check-in is lost attendance
    attempts,
    next_attempt_at: now + delay,
    last_error: String(error ?? 'unknown').slice(0, 200),
  };
}

/**
 * Merge a server response back in.
 *
 * The server is authoritative on which keys it has, and it is allowed to report
 * success for a key we still think is pending - that is the whole point of the
 * idempotency key. Unknown keys in the response are ignored rather than trusted.
 */
export function applyAck(records, acceptedKeys, now) {
  const accepted = new Set(acceptedKeys);
  return records.map(r => (accepted.has(r.idempotency_key) && r.status !== SENT ? markSent(r, now) : r));
}

/**
 * What the technician's status line shows. Unsent count is the number that
 * matters at end of day: it is exactly how much attendance data is sitting on
 * one phone and nowhere else.
 */
export function outboxStats(records, now) {
  let pending = 0;
  let sent = 0;
  let oldestPendingMs = null;
  let stuck = 0;

  for (const r of records) {
    if (r.status === SENT) { sent++; continue; }
    pending++;
    const at = Date.parse(r.scanned_at);
    if (Number.isFinite(at)) {
      const age = now - at;
      if (oldestPendingMs === null || age > oldestPendingMs) oldestPendingMs = age;
    }
    // Five failed attempts is roughly a minute of backoff. Past that it is not
    // a blip, and the technician needs to know before the phone goes home.
    if (r.attempts >= 5) stuck++;
  }

  return { pending, sent, oldestPendingMs, stuck };
}

// --- attendance export ---------------------------------------------------

/** Columns of the per-phone attendance export. No name, no company: this file
 *  is safe to send over Teams or e-mail, and it is joined with the registrant
 *  export only on the laptop, by tools/merge-attendance.mjs. */
export const ATTENDANCE_COLUMNS = ['propulse_id', 'scanned_at', 'device_id', 'matched', 'idempotency_key'];

/**
 * Every check-in on this phone as CSV, oldest first.
 *
 * Deliberately every check-in, not one row per visitor: deduplication happens
 * once, on the laptop, across all phones. Doing it here would hide a phone
 * whose clock was wrong, or a visitor scanned at two booths.
 */
export function toAttendanceCsv(records) {
  const rows = [...records]
    .sort((a, b) => a.scanned_at.localeCompare(b.scanned_at))
    .map(r => [r.propulse_id, r.scanned_at, r.device_id, r.matched ? 'yes' : 'no', r.idempotency_key]);
  return [ATTENDANCE_COLUMNS, ...rows].map(r => r.join(',')).join('\r\n') + '\r\n';
}

// --- wire format -----------------------------------------------------------

/**
 * The ONLY shape of a check-in that ever leaves the phone: four identifiers,
 * no name, no company, no delivery bookkeeping. aws/lambda.cjs rejects any
 * request carrying a fifth key, so the two ends enforce the same rule.
 */
export const WIRE_FIELDS = ['device_id', 'idempotency_key', 'propulse_id', 'scanned_at'];
export function wireCheckin(r) {
  return { idempotency_key: r.idempotency_key, propulse_id: r.propulse_id, scanned_at: r.scanned_at, device_id: r.device_id };
}
