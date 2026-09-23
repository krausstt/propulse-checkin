/**
 * mai.js - building ProGlove Streams API `display_v2!` commands.
 *
 * Pure functions only: no DOM, no WebSocket, no clock of its own. Everything
 * non-deterministic (uuid, timestamp) is injected, so this module is testable
 * in Node and the tests are not flaky.
 *
 * TWO templates are supported, because there are two real captures from the
 * customer's own INSIGHT Mobile installation and they disagree:
 *
 *   pg_work4_t4   4 cells. ID / Host / Badge Location / Full Name.
 *                 Carries forced_orientation: "LANDSCAPE".
 *   pg_work5_t3   5 cells. Adds Company, and moves the highlight off the name
 *                 onto Company. Carries NO forced_orientation at all.
 *
 * Both captures are asserted by deep-equal in mai.test.js. Neither is "the old
 * one" - they are two templates that exist, and the app picks. Do not collapse
 * them into one until a capture proves they are the same thing.
 */

/** The MAI display is ~2in. Long strings are silently clipped by the device,
 *  so we clip deliberately and visibly instead of letting it surprise us.
 *  Limits are per template: five cells means less room per cell for the short
 *  fields, but the pg_work5_t3 capture carries a 37-character company name
 *  untruncated, so the content budget there is demonstrably wider. */
const LIMITS = {
  pg_work4_t4: { title: 32, header: 20, content: 28 },
  pg_work5_t3: { title: 32, header: 20, content: 40 },
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

function makeField(limits) {
  return (refId, header, content, state) => {
    const f = {
      text_header: clip(header, limits.header),
      text_content: clip(content, limits.content),
      ref_id: refId,
    };
    // Key order matters only for readability, but `state` is last in both
    // captures and deep-equal does not care - keep it last anyway so a diff
    // against a fresh capture stays easy to read.
    if (state) f.state = state;
    return f;
  };
}

/** The one visual emphasis the template allows. Exactly one cell gets it. */
const FOCUSED = { type: 'FOCUSED', highlighted: true };

/**
 * @param {object} p
 * @param {string} p.id              scanned ProPulse ID
 * @param {object|null} p.visitor    roster record {full_name, host, badge_location, company} or null
 * @param {string} p.deviceSerial    MAI serial, learned at runtime from INSIGHT Mobile
 * @param {string} p.gatewaySerial   gateway serial, learned at runtime
 * @param {string} p.eventId         UUID for this command
 * @param {number} p.now             epoch millis
 * @param {string} [p.title]
 * @param {'pg_work4_t4'|'pg_work5_t3'} [p.template]
 */
export function buildDisplayCommand({
  id,
  visitor,
  deviceSerial,
  gatewaySerial,
  eventId,
  now,
  title = 'ProPulse 2026 Chicago',
  template = 'pg_work4_t4',
}) {
  if (!deviceSerial) throw new Error('deviceSerial missing - has a scan been received yet?');
  if (!eventId) throw new Error('eventId missing');
  if (!Number.isFinite(now)) throw new Error('now must be epoch millis');
  const limits = LIMITS[template];
  if (!limits) throw new Error(`unknown template ${template}`);

  const field = makeField(limits);
  const found = Boolean(visitor);

  // A miss must be loud on the device. A greeter looking at a blank screen has
  // no idea whether the scan failed or the guest is new; "Not Registered" tells
  // them to walk the guest to the desk.
  const nameHeader = found ? 'Full Name of Visitor' : 'Not Registered';
  const nameValue = found ? visitor.full_name : `ID ${id}`;

  const screen =
    template === 'pg_work5_t3'
      ? {
          title: clip(title, limits.title),
          field_top_left: field('field_top_left_ref', 'ID', id),
          field_top_right: field('field_top_right_ref', 'Badge Location', found ? visitor.badge_location : '—'),
          field_middle_left: field('field_middle_left_ref', 'Host', found ? formatHost(visitor.host) : '—'),
          field_middle_right: field(
            'field_middle_right_ref',
            'Company',
            found ? visitor.company : '—',
            FOCUSED
          ),
          field_bottom: field('field_bottom_ref', nameHeader, nameValue),
        }
      : {
          title: clip(title, limits.title),
          field_top_left: field('field_top_left_ref', 'ID', id),
          field_top_right: field('field_top_right_ref', 'Host', found ? formatHost(visitor.host) : '—'),
          field_middle_left: field('field_middle_left_ref', 'Badge Location', found ? visitor.badge_location : '—'),
          field_bottom: field('field_bottom_ref', nameHeader, nameValue, FOCUSED),
        };

  const command = {
    active_screen_view: 'SCREEN_VIEW_1',
    api_version: '3.0',
    device_serial: deviceSerial,
    event_id: eventId,
    event_type: 'display_v2!',
  };

  // The pg_work5_t3 capture has no forced_orientation key at all. Adding one
  // "for consistency" would be inventing a field the device has never been
  // observed to receive, which is exactly how you turn a working template into
  // an unexplained rejection at the booth.
  if (template === 'pg_work4_t4') command.forced_orientation = 'LANDSCAPE';

  command.gateway_serial = gatewaySerial;
  command.ref_id = 'SCREEN_1';
  command.screen_views = [{ ref_id: 'SCREEN_VIEW_1', [template]: screen }];
  command.time_created = now;

  return command;
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

export const TEMPLATES = Object.keys(LIMITS);
export const __testing = { LIMITS, clip };
