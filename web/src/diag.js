/**
 * diag.js - on-device bisection for "the MAI screen does not change".
 *
 * Each builder isolates one variable, so the first one that works on the
 * device tells us where the fault is:
 *
 *   feedback!                 no template at all. If THIS does nothing, the
 *                             command path (socket, serial, INSIGHT config) is
 *                             broken and no display payload can ever work.
 *   capture pg_work4_t4       the first captured payload, verbatim except
 *                             serials, event_id and time_created.
 *   capture pg_work5_t3       the second capture with its ORIGINAL states.
 *   app pg_work5_t3           exactly what a real scan sends today.
 *
 * Any of them can request an ack (ack_required, documented in Streams API
 * 3.6.6 as ON_RECEIVE / ON_HANDLED), so INSIGHT Mobile tells us whether it
 * accepted the command instead of us guessing from a blank screen.
 *
 * Only synthetic sample text is used here, so logging these payloads in full
 * is safe. Real-scan payloads are never logged in full (see app.js).
 */
import { buildDisplayCommand } from './mai.js';

const SAMPLE = {
  full_name: 'Nolan Wong',
  host: 'Rohan Wagh',
  badge_location: 'B-12',
  company: 'Anonymized Information Technology Inc',
};

function envelope({ eventType, serials, eventId, now }) {
  const e = {
    api_version: '3.0',
    event_type: eventType,
    event_id: eventId,
    time_created: now,
    device_serial: serials.device_serial,
  };
  if (serials.gateway_serial) e.gateway_serial = serials.gateway_serial;
  return e;
}

/**
 * The action id is NOT in the 3.6.6 summary we have: it names the values
 * (FEEDBACK_POSITIVE…) but not the key. "feedback_action_id" is the key in the
 * ProGlove Gateway Streams API as I remember it - unverified. If the glove
 * does not react and INSIGHT Mobile returns an error naming a field, that
 * error is the answer.
 */
export function feedbackCommand({ serials, eventId, now, action = 'FEEDBACK_POSITIVE' }) {
  return { ...envelope({ eventType: 'feedback!', serials, eventId, now }), feedback_action_id: action };
}

/** The pg_work4_t4 capture, with only the per-message fields refreshed. */
export function capture4Command({ serials, eventId, now }) {
  return buildDisplayCommand({
    id: '1', visitor: SAMPLE, deviceSerial: serials.device_serial, gatewaySerial: serials.gateway_serial,
    eventId, now, template: 'pg_work4_t4',
  });
}

/** The pg_work5_t3 capture exactly as captured: Company FOCUSED+highlighted,
 *  every other cell stateless. Built by hand, not by mai.js, on purpose: mai.js
 *  now carries Tobias's newer states, and this button must stay the capture. */
export function capture5Command({ serials, eventId, now }) {
  const cell = (ref, h, c, state) => ({ text_header: h, text_content: c, ref_id: ref, ...(state ? { state } : {}) });
  const cmd = {
    active_screen_view: 'SCREEN_VIEW_1',
    ...envelope({ eventType: 'display_v2!', serials, eventId, now }),
    ref_id: 'SCREEN_1',
    screen_views: [{
      ref_id: 'SCREEN_VIEW_1',
      pg_work5_t3: {
        title: 'ProPulse 2026 Chicago',
        field_top_left: cell('field_top_left_ref', 'ID', '1'),
        field_top_right: cell('field_top_right_ref', 'Badge Location', SAMPLE.badge_location),
        field_middle_left: cell('field_middle_left_ref', 'Host', 'Rohan'),
        field_middle_right: cell('field_middle_right_ref', 'Company', SAMPLE.company, { type: 'FOCUSED', highlighted: true }),
        field_bottom: cell('field_bottom_ref', 'Full Name of Visitor', SAMPLE.full_name),
      },
    }],
  };
  return cmd;
}

/** What a real scan of badge 1 sends right now. */
export function appCommand({ serials, eventId, now }) {
  return buildDisplayCommand({
    id: '1', visitor: SAMPLE, deviceSerial: serials.device_serial, gatewaySerial: serials.gateway_serial,
    eventId, now, template: 'pg_work5_t3',
  });
}

export const PROBES = {
  feedback: { label: 'Feedback beep (no display)', build: feedbackCommand },
  capture4: { label: 'Capture pg_work4_t4, verbatim', build: capture4Command },
  capture5: { label: 'Capture pg_work5_t3, original states', build: capture5Command },
  app: { label: 'App pg_work5_t3, current states', build: appCommand },
};

export function withAck(cmd, mode) {
  return mode ? { ...cmd, ack_required: mode } : cmd;
}
