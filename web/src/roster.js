/**
 * roster.js - the visitor lookup table, held on the phone.
 *
 * The roster is built on the laptop by tools/build-roster.mjs and carried to
 * each phone by hand (company OneDrive/Teams, never GitHub). It is verified and
 * held in IndexedDB so that a scan resolves with no network in the loop. Venue
 * WiFi must never be able to break the greeting.
 *
 * Pure functions only - no IndexedDB, no fetch, no clock. Storage lives in
 * idb.js, the clock is injected. Same contract as mai.js, same reason: this is
 * the code path that decides whether a visitor is greeted by name, and it has
 * to be testable in Node without a browser.
 */

/**
 * One normalisation, used on BOTH sides of every comparison.
 *
 * The badge QR is a bare integer and the app compares it as a string, so "007"
 * and "7" must collapse to the same key or the lookup silently misses. The
 * scanner side already does this (parseScannedId in mai.js); build-roster.mjs
 * does NOT, so a sheet containing 007 would produce a key no scan can reach.
 * Normalising here closes that gap without changing the roster builder's
 * output contract - and without a second place for the two to drift apart.
 */
export function normalizeId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, '');
}

/** Exactly what a MAI template cell needs, plus status. Nothing else may
 *  exist on a phone. Adding a key here widens the firewall: see CLAUDE.md rule 3. */
export const ALLOWED_FIELDS = new Set(['full_name', 'host', 'badge_location', 'company', 'status']);

/**
 * Reject a payload that is not a roster before it can poison the cache.
 *
 * The realistic failure here is not a malicious response, it is a captive
 * portal at the venue answering every request with an HTML login page, or a
 * truncated body from a dropped connection. Both parse as "not our schema".
 * Returns a list of reasons rather than throwing, so the caller can log all of
 * them at once instead of discovering them one reload at a time.
 */
export function validateRoster(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return ['payload is not an object (a captive portal or an error page?)'];
  }
  if (payload.schema !== 'propulse-roster/1') {
    errors.push(`unexpected schema ${JSON.stringify(payload.schema)}, want "propulse-roster/1"`);
  }
  if (!payload.visitors || typeof payload.visitors !== 'object') {
    errors.push('missing visitors map');
    return errors; // nothing below can run without it
  }
  const ids = Object.keys(payload.visitors);

  // The PII firewall, enforced a second time on the phone. build-roster.mjs is
  // the first line: it drops e-mail, phone, address and title on the laptop.
  // But the roster reaches the phones by hand (OneDrive, Teams, USB), and a
  // hand-carried file can be the wrong file. So a roster record carrying any
  // key outside the allowlist is refused outright, and the error names only
  // the offending KEYS - never values, which would put the PII in the log.
  const forbidden = new Set();
  for (const record of Object.values(payload.visitors)) {
    if (!record || typeof record !== 'object') continue;
    for (const key of Object.keys(record)) if (!ALLOWED_FIELDS.has(key)) forbidden.add(key);
  }
  if (forbidden.size) {
    errors.push(
      `refusing roster: records carry fields that must never reach a phone (${[...forbidden].join(', ')}). ` +
      'Rebuild it with tools/build-roster.mjs.'
    );
  }
  if (ids.length === 0) {
    errors.push('roster is empty - refusing to replace a working cache with nothing');
  }
  if (typeof payload.count === 'number' && payload.count !== ids.length) {
    errors.push(`count says ${payload.count} but there are ${ids.length} visitors`);
  }
  return errors;
}

/**
 * Build the lookup map, normalising every key.
 *
 * Collisions matter more than they look. If the sheet holds both "07" and "7"
 * they are two different rows to marketing and one key to us, which means one
 * of two real visitors gets greeted with the other one's name and host. That is
 * worse than a miss, so it is reported rather than silently resolved.
 */
export function indexVisitors(payload) {
  const index = new Map();
  const collisions = [];
  const unusable = [];

  for (const [rawId, record] of Object.entries(payload.visitors)) {
    const id = normalizeId(rawId);
    if (id === null) {
      unusable.push(rawId); // not a badge-shaped ID; no scan can ever produce it
      continue;
    }
    if (index.has(id)) {
      collisions.push({ id, raw: [index.get(id).__raw, rawId] });
    }
    index.set(id, { ...record, __raw: rawId });
  }

  return { index, collisions, unusable };
}

/** @returns {object|null} the visitor record, or null for an unknown badge. */
export function lookup(index, scannedId) {
  const id = normalizeId(scannedId);
  if (id === null) return null;
  return index.get(id) ?? null;
}

/**
 * Recompute the checksum build-roster.mjs wrote, to catch a cache that was
 * truncated on the way into IndexedDB or corrupted on the way out.
 *
 * Must match tools/build-roster.mjs exactly: sha256 over JSON.stringify of the
 * visitors map, first 16 hex characters.
 *
 * This depends on both sides enumerating the keys in the same order, which they
 * do: ECMAScript orders integer-index keys ascending regardless of insertion
 * order, and ProPulse IDs are integer-index keys. Any non-canonical key (a
 * leading-zero "007") falls back to insertion order, and that also agrees
 * because the client parses the very bytes the builder wrote. It is still an
 * ordering assumption, so a mismatch is a warning the caller decides about
 * rather than a hard failure that could strand a booth with no roster.
 *
 * @param {Crypto['subtle']} subtle - injected so Node's webcrypto works in tests
 */
export async function verifyChecksum(payload, subtle) {
  if (!payload?.checksum) return { ok: true, reason: 'no checksum in payload' };
  const bytes = new TextEncoder().encode(JSON.stringify(payload.visitors));
  const digest = await subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const actual = hex.slice(0, 16);
  return actual === payload.checksum
    ? { ok: true, actual }
    : { ok: false, actual, expected: payload.checksum };
}

/**
 * Cache freshness.
 *
 * Deliberately NOT "refresh if online". A roster that is six hours old still
 * greets every visitor correctly; a refresh that half-completes on venue WiFi
 * does not. Staleness is advisory - the caller shows the technician a banner,
 * it never blocks a scan.
 */
export const ROSTER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function rosterAge(cached, now) {
  if (!cached?.fetched_at) return null;
  const at = Date.parse(cached.fetched_at);
  return Number.isFinite(at) ? now - at : null;
}

export function isStale(cached, now, maxAgeMs = ROSTER_MAX_AGE_MS) {
  const age = rosterAge(cached, now);
  return age === null || age > maxAgeMs;
}

/**
 * Decide whether to accept a freshly fetched payload over what we already hold.
 *
 * The rule that matters: a bad download must never replace a good cache. At the
 * booth, "yesterday's roster" greets ~everyone correctly and "no roster" greets
 * nobody, so the cache wins every tie.
 */
export function acceptReplacement(current, incoming) {
  const errors = validateRoster(incoming);
  if (errors.length) return { accept: false, errors };
  if (current && current.checksum && current.checksum === incoming.checksum) {
    return { accept: false, errors: [], reason: 'unchanged' };
  }
  return { accept: true, errors: [] };
}
