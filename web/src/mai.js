/**
 * mai.js - building ProGlove Streams API `display_v2!` commands.
 *
 * Pure functions only: no DOM, no WebSocket, no clock of its own. Everything
 * non-deterministic (uuid, timestamp) is injected, so this module is testable
 * in Node and the tests are not flaky.
 *
 * The payload shape is taken verbatim from a known-good message captured from
 * the customer's own INSIGHT Mobile installation - that capture is the spec.
 */

/** The MAI display is ~2in. Long strings are silently clipped by the device,
 *  so we clip deliberately and visibly instead of letting it surprise us. */
const LIMITS = {
  title: 32,
  header: 20,
  content: 28,
};

/**
 * The captured payload shows Host as "Rohan" where the source sheet holds
 * "Rohan Wagh". Given the field width, showing the given name is the right
 * call - but it is a display decision, so it lives here and not in the data
 * pipeline. build-roster.mjs deliberately keeps the full name.
 */
export function formatHost(host, { givenNameOnly = true } = {}) {
  const trimmed = (host || '').trim();
  if (!trimmed) return '—'; // em dash: an empty field looks like a bug
  return givenNameOnly ? trimmed.split(/\s+/)[0] : trimmed;
}

function clip(value, max) {
  const s = value === undefined || value === null || value === '' ? '—' : String(value).trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function field(refId, header, content) {
  return {
    text_header: clip(header, LIMITS.header),
    text_content: clip(content, LIMITS.content),
    ref_id: refId,
  };
}

/**
 * @param {object} p
 * @param {string} p.id              scanned ProPulse ID
 * @param {object|null} p.visitor    roster record {full_name, host, badge_location} or null
 * @param {string} p.deviceSerial    MAI serial, learned at runtime from INSIGHT Mobile
 * @param {string} p.gatewaySerial   gateway serial, learned at runtime
 * @param {string} p.eventId         UUID for this command
 * @param {number} p.now             epoch millis
 * @param {string} [p.title]
 */
export function buildDisplayCommand({
  id,
  visitor,
  deviceSerial,
  gatewaySerial,
  eventId,
  now,
  title = 'ProPulse 2026 Chicago',
}) {
  if (!deviceSerial) throw new Error('deviceSerial missing - has a scan been received yet?');
  if (!eventId) throw new Error('eventId missing');
  if (!Number.isFinite(now)) throw new Error('now must be epoch millis');

  const found = Boolean(visitor);

  return {
    active_screen_view: 'SCREEN_VIEW_1',
    api_version: '3.0',
    device_serial: deviceSerial,
    event_id: eventId,
    event_type: 'display_v2!',
    forced_orientation: 'LANDSCAPE',
    gateway_serial: gatewaySerial,
    ref_id: 'SCREEN_1',
    screen_views: [
      {
        ref_id: 'SCREEN_VIEW_1',
        pg_work4_t4: {
          title: clip(title, LIMITS.title),
          field_top_left: field('field_top_left_ref', 'ID', id),
          field_top_right: field('field_top_right_ref', 'Host', found ? formatHost(visitor.host) : '—'),
          field_middle_left: field(
            'field_middle_left_ref',
            'Badge Location',
            found ? visitor.badge_location : '—'
          ),
          field_bottom: {
            // A miss must be loud on the device. A greeter looking at a blank
            // screen has no idea whether the scan failed or the guest is new;
            // "NOT REGISTERED" tells them to walk the guest to the desk.
            ...field('field_bottom_ref', found ? 'Full Name of Visitor' : 'Not Registered', found ? visitor.full_name : `ID ${id}`),
            state: { type: 'FOCUSED', highlighted: true },
          },
        },
      },
    ],
    time_created: now,
  };
}

/**
 * The badge QR carries a bare integer. Anything else scanned at the booth -
 * a product EAN, a config code, someone's train ticket - must be rejected
 * quietly rather than triggering a bogus "not registered" screen.
 */
export function parseScannedId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, ''); // 007 and 7 are the same visitor
}

export const __testing = { LIMITS, clip };
