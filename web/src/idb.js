/**
 * idb.js - the only file in this app that talks to IndexedDB.
 *
 * Deliberately thin and deliberately dumb. Every decision worth testing lives
 * in roster.js and outbox.js, which are pure and covered by node:test. This
 * file is the part that cannot be unit-tested without pulling an npm shim, and
 * the project has zero runtime dependencies on purpose - so the answer is to
 * keep it small enough to read in one sitting rather than to test it.
 *
 * If you are tempted to put an `if` in here, it probably belongs next door.
 *
 * Two object stores:
 *   roster    one record under the key "current" - the whole payload as one
 *             blob. ~1000 visitors is ~30 KB; a thousand individual rows would
 *             be a thousand writes for no benefit, since we always read it all.
 *   checkins  keyed by idempotency_key, which is also the dedupe key the server
 *             uses. Re-putting the same key overwrites delivery bookkeeping and
 *             can never create a second check-in.
 */

const DB_NAME = 'propulse-checkin';
const DB_VERSION = 1;
const ROSTER_STORE = 'roster';
const CHECKIN_STORE = 'checkins';
const ROSTER_KEY = 'current';

let dbPromise = null;

/**
 * Chrome can evict IndexedDB under storage pressure. Ask for persistence once;
 * the answer is advisory and a "no" is not fatal, because the outbox flushes
 * continuously and the roster can be re-fetched. Worth asking anyway: an
 * evicted outbox at a trade fair is attendance data nobody can get back.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const already = await navigator.storage.persisted();
  const persisted = already || (await navigator.storage.persist());
  return { supported: true, persisted };
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROSTER_STORE)) db.createObjectStore(ROSTER_STORE);
      if (!db.objectStoreNames.contains(CHECKIN_STORE)) {
        db.createObjectStore(CHECKIN_STORE, { keyPath: 'idempotency_key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Fires when another tab holds an older version open. We never ship a
    // version bump mid-event, so this is a developer signal, not a user path.
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve();
        }
      })
  );
}

// --- roster --------------------------------------------------------------

/** @returns {Promise<object|null>} the cached payload, or null on first run. */
export function loadRoster() {
  return run(ROSTER_STORE, 'readonly', s => s.get(ROSTER_KEY)).then(v => v ?? null);
}

/**
 * Callers must have run roster.acceptReplacement() first. This does not
 * validate - by the time a payload reaches here the decision is already made,
 * and re-checking in two places is how the two checks drift apart.
 *
 * @param {object} payload   a validated propulse-roster/1 payload
 * @param {object} meta      {fetched_at, etag} - what the next conditional GET needs
 */
export function saveRoster(payload, meta) {
  return run(ROSTER_STORE, 'readwrite', s => s.put({ ...payload, ...meta }, ROSTER_KEY));
}

// --- check-ins -----------------------------------------------------------

/** Append-only in spirit: the key is the idempotency key, so a re-put of the
 *  same scan updates delivery bookkeeping and never adds a row. */
export function putCheckin(record) {
  return run(CHECKIN_STORE, 'readwrite', s => s.put(record));
}

export function putCheckins(records) {
  return run(CHECKIN_STORE, 'readwrite', s => {
    for (const r of records) s.put(r);
    return null; // resolve on transaction completion, not on the last request
  });
}

/**
 * The whole outbox, in one read.
 *
 * Fine at event scale: a booth that greets every one of ~1000 registrants
 * holds ~1000 small records. If this ever needs an index it is because the
 * outbox stopped draining, which is the actual problem to fix.
 */
export function allCheckins() {
  return run(CHECKIN_STORE, 'readonly', s => s.getAll()).then(v => v ?? []);
}

/** Exported for the diagnostic screen only. There is no delete path for
 *  check-ins by design - append-only means append-only. */
export const __stores = { DB_NAME, DB_VERSION, ROSTER_STORE, CHECKIN_STORE, ROSTER_KEY };
