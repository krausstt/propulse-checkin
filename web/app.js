/**
 * app.js - wiring. The only file that touches the DOM.
 *
 * Scan path, end to end:
 *   ProGlove scanner -> INSIGHT Mobile -> ws://localhost:9998 -> ScannerLink
 *     -> parseScannedId -> roster lookup -> buildDisplayCommand
 *     -> ScannerLink.sendDisplay -> INSIGHT Mobile -> BLE -> MAI screen
 *   and in parallel: createCheckin -> IndexedDB -> sync queue
 *
 * The greeting and the check-in are deliberately independent. The greeting is
 * worthless a second later, so it is fire-and-forget. The check-in is
 * attendance data, so it is written to disk before anything else and retried
 * until it lands.
 */

import { buildDisplayCommand, parseScannedId } from './src/mai.js';
import { ScannerLink } from './src/ws.js';
import { indexVisitors, lookup, validateRoster, acceptReplacement } from './src/roster.js';
import {
  createCheckin, isDuplicateScan, dueForSend, markSent, markFailed, outboxStats, toAttendanceCsv, wireCheckin,
} from './src/outbox.js';
import { PROBES, withAck } from './src/diag.js';
import { decodeCsvBytes, reduceExport, rosterPayload, checksumVisitors } from './src/csv-roster.js';
import { openDb, loadRoster, saveRoster, putCheckin, putCheckins, allCheckins, requestPersistence } from './src/idb.js';

const $ = id => document.getElementById(id);

/** Shown in Diagnostics. The service worker serves the cached shell first and
 *  refreshes in the background, so the first load after a deploy still runs
 *  the previous build. If this tag is old, close and reopen the app once. */
const BUILD = '2026-09-24.3 aws-sync';

/**
 * Where check-ins go. Empty by design: there is no backend (AWS was dropped),
 * so check-ins stay on the phone and the UI says so rather than pretending a
 * server write happened. The path is kept dormant, not deleted: a check-in
 * carries no name, so pointing ?api= at an endpoint later exposes only badge
 * IDs and timestamps.
 */
const params = new URLSearchParams(location.search);
/**
 * One-time setup link per phone:  ...?api=https://<id>.execute-api...&key=<event key>
 * Both are remembered on the phone and then removed from the address bar, so
 * the key does not linger in the URL. Neither is ever committed: the repo is
 * public, and the key is what keeps random traffic out of the table.
 */
for (const [param, store] of [['api', 'apiBase'], ['key', 'eventKey']]) {
  const v = params.get(param);
  if (v) { try { localStorage.setItem(store, v.trim()); } catch {} }
}
if (params.has('api') || params.has('key')) {
  params.delete('api'); params.delete('key');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
}
const API_BASE = (localStorage.getItem('apiBase') || '').replace(/\/$/, '');
const EVENT_KEY = localStorage.getItem('eventKey') || '';


/** One stable id per phone, so five SureMDM devices are distinguishable in the
 *  check-in log without anybody provisioning a config file per device. */
function deviceId() {
  let v = localStorage.getItem('deviceId');
  if (!v) { v = `dev-${crypto.randomUUID().slice(0, 8)}`; localStorage.setItem('deviceId', v); }
  return v;
}

const state = {
  index: new Map(),
  rosterMeta: null,
  checkins: [],
  template: localStorage.getItem('template') || 'pg_work5_t3',
  syncing: false,
};

// --- logging -------------------------------------------------------------

const t0 = performance.now();
function log(msg, level = 'info') {
  const el = document.createElement('div');
  el.className = `l-${level}`;
  el.textContent = `${String(Math.round(performance.now() - t0)).padStart(6)}ms  ${msg}`;
  $('log').appendChild(el);
  while ($('log').childElementCount > 400) $('log').firstElementChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
}

// --- the link ------------------------------------------------------------

const link = new ScannerLink();

link.on('log', l => log(l.msg, l.level === 'ok' ? 'ok' : l.level));

link.on('status', s => {
  $('dot').className = s.state;
  const text = {
    idle: 'Not connected', connecting: 'Connecting…', open: 'Scanner connected',
    backoff: 'Reconnecting…', 'needs-tap': 'Tap to connect',
  }[s.state] ?? s.state;
  $('linkText').textContent = text;
  $('linkDetail').textContent = s.detail
    || (s.serials.device_serial ? `MAI ${s.serials.device_serial}` : 'waiting for the first scan to learn the MAI serial');
  $('bConnect').hidden = s.state === 'open' || s.state === 'connecting';
  $('bDisconnect').hidden = !$('bConnect').hidden;
  $('bConnect').textContent = s.everConnected ? 'Reconnect scanner' : 'Connect scanner';
});

// Serials are learned from the scan event, and until now lived only in memory:
// every reload forgot them, so Simulate scan silently sent nothing until a real
// badge was scanned again. Remember the last ones seen on this phone. A real
// scan always overwrites them, so a swapped MAI corrects itself on first scan.
try {
  const saved = JSON.parse(localStorage.getItem('serials') || 'null');
  if (saved?.device_serial) { link.serials = saved; }
} catch {}
link.on('serials', s => {
  try { localStorage.setItem('serials', JSON.stringify(s)); } catch {}
  renderSerials();
});
function renderSerials() {
  const s = link.serials;
  $('serials').textContent = s.device_serial
    ? `MAI ${s.device_serial}${s.gateway_serial ? ` · gateway ${s.gateway_serial}` : ' · no gateway_serial seen'}`
    : 'no MAI serial yet: scan one real badge';
}

// INSIGHT Mobile's own errors, shown on the main screen rather than buried in
// the log: "the MAI does not change" is exactly the symptom they explain.
link.on('insight-error', e => {
  $('insightErr').hidden = false;
  $('insightErr').textContent = `INSIGHT Mobile: ${e.code}${e.message ? ` (${e.message})` : ''}. ${e.advice}`;
});
link.on('serials', () => { $('insightErr').hidden = true; });

link.on('scan', frame => { onScan(frame).catch(e => log(`scan handling failed: ${e.message}`, 'error')); });

// --- the scan path -------------------------------------------------------

async function onScan(frame) {
  const raw = frame.code;
  const id = parseScannedId(raw);

  if (id === null) {
    // A product EAN, a poster QR, someone's train ticket. Say so rather than
    // flashing NOT REGISTERED, which would send a greeter chasing a visitor
    // who never scanned a badge.
    log(`ignored non-badge scan ${JSON.stringify(raw)}`, 'warn');
    showGreeting({ kind: 'ignored', raw });
    return;
  }

  const visitor = lookup(state.index, id);
  const now = Date.now();

  // 1. The screen. Fire and forget - a greeting is worthless a second later.
  if (link.serials.device_serial) {
    const cmd = buildDisplayCommand({
      id,
      visitor,
      deviceSerial: link.serials.device_serial,
      gatewaySerial: link.serials.gateway_serial,
      eventId: crypto.randomUUID(),
      now,
      template: state.template,
    });
    link.sendDisplay(cmd);
    log(`-> display_v2! ${cmd.event_id} to ${cmd.device_serial} (${state.template}, ${JSON.stringify(cmd).length} bytes)`, 'dim');
  } else {
    // Loud, because a silent skip is exactly what "the MAI does not change" looks like.
    log('NOT SENT to the MAI: no device_serial known yet. Scan one real badge first; the serial is remembered after that.', 'error');
  }

  // 2. The check-in. Disk first, network later, never the other way round.
  if (isDuplicateScan(state.checkins, id, now)) {
    log(`duplicate scan of ${id} inside the dedupe window - not recorded twice`, 'dim');
  } else {
    const record = createCheckin({ id, uuid: crypto.randomUUID(), deviceId: deviceId(), now, matched: Boolean(visitor) });
    await putCheckin(record);
    state.checkins.push(record);
    log(`check-in recorded ${record.idempotency_key} (${visitor ? 'matched' : 'UNMATCHED'})`, visitor ? 'ok' : 'warn');
  }

  showGreeting({ kind: visitor ? 'hit' : 'miss', id, visitor });
  renderSync();
  sync('after scan');
}

function showGreeting(g) {
  const el = $('greet');
  if (g.kind === 'ignored') {
    el.innerHTML = `<div id="gEmpty">Not a badge code</div>
      <div id="gMeta">scanned: ${escapeHtml(String(g.raw).slice(0, 60))}</div>
      <div id="gBadge" class="b-idle">IGNORED</div>`;
    return;
  }
  if (g.kind === 'miss') {
    el.innerHTML = `<div id="gName">ID ${escapeHtml(g.id)}</div>
      <div id="gMeta">Not on the roster. Walk the guest to the desk.</div>
      <div id="gBadge" class="b-miss">NOT REGISTERED</div>`;
    return;
  }
  const v = g.visitor;
  el.innerHTML = `<div id="gName">${escapeHtml(v.full_name)}</div>
    <div id="gMeta">${escapeHtml(v.company || '—')} · host ${escapeHtml(v.host || '—')} · badge ${escapeHtml(v.badge_location || '—')}</div>
    <div id="gBadge" class="b-ok">CHECKED IN · ID ${escapeHtml(g.id)}</div>`;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- check-in sync -------------------------------------------------------

// --- attendance export ---------------------------------------------------

/**
 * With no backend, this phone's check-in log IS the attendance database, and
 * a lost or wiped phone loses it. So the number that matters on screen is how
 * many check-ins exist only here, i.e. since the last export.
 */
function renderExport() {
  const total = state.checkins.length;
  let last = null;
  try { last = JSON.parse(localStorage.getItem('lastExport') || 'null'); } catch {}
  const since = total - (last?.count ?? 0);
  $('bExport').textContent = `Export attendance (${total} check-ins, no names)`;
  $('exportInfo').textContent = last
    ? `Last export ${new Date(last.at).toLocaleString()} · ${since} check-in(s) since, only on this phone`
    : `Never exported · all ${total} check-in(s) exist only on this phone`;
  $('exportInfo').style.color = since > 0 ? 'var(--warn)' : 'var(--dim)';
}

$('bExport').onclick = () => {
  const csvText = toAttendanceCsv(state.checkins);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csvText], { type: 'text/csv' }));
  a.download = `attendance-${deviceId()}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  try { localStorage.setItem('lastExport', JSON.stringify({ at: Date.now(), count: state.checkins.length })); } catch {}
  log(`attendance exported: ${state.checkins.length} check-ins -> ${a.download}`, 'ok');
  renderExport();
};

function renderSync() {
  renderExport();
  const s = outboxStats(state.checkins, Date.now());
  $('nTotal').textContent = s.pending + s.sent;
  $('nSynced').textContent = s.sent;
  $('nPending').textContent = s.pending;
  $('pPending').classList.toggle('warn', s.pending > 0);
  $('bSync').textContent = !API_BASE || !EVENT_KEY
    ? 'No server configured — held on this phone only'
    : (s.pending ? `Sync ${s.pending} now${s.stuck ? ` (${s.stuck} stuck)` : ''}` : 'All synced to server ✓');
}

/**
 * Drain the outbox.
 *
 * With no API_BASE this is deliberately a no-op that says so. The alternative
 * is a green "synced" tick that means nothing, which is exactly the kind of
 * reassurance that gets discovered as false on the evening of day one.
 */
async function sync(reason) {
  if (!API_BASE || !EVENT_KEY || state.syncing || !navigator.onLine) return;
  const batch = dueForSend(state.checkins, Date.now());
  if (!batch.length) return;

  state.syncing = true;
  const keys = new Set(batch.map(r => r.idempotency_key));
  try {
    const res = await fetch(`${API_BASE}/checkins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-event-key': EVENT_KEY },
      body: JSON.stringify({ checkins: batch.map(wireCheckin) }),
    });
    if (res.status === 401) {
      $('insightErr').hidden = false;
      $('insightErr').textContent = 'Check-in server refused the event key. Open the setup link for this phone again.';
      throw new Error('HTTP 401 (event key)');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Only keys the server explicitly confirms are marked synced. Anything it
    // did not confirm stays pending and is retried - never assumed delivered.
    const accepted = new Set((Array.isArray(body.accepted) ? body.accepted : []).filter(k => keys.has(k)));
    const now = Date.now();
    state.checkins = state.checkins.map(r => {
      if (!keys.has(r.idempotency_key) || r.status === 'sent') return r;
      return accepted.has(r.idempotency_key) ? markSent(r, now) : markFailed(r, { now, error: 'not confirmed by server' });
    });
    await putCheckins(state.checkins.filter(r => keys.has(r.idempotency_key)));
    log(`synced ${accepted.size}/${batch.length} check-in(s) (${reason})`, accepted.size === batch.length ? 'ok' : 'warn');
  } catch (e) {
    const now = Date.now();
    state.checkins = state.checkins.map(r => (keys.has(r.idempotency_key) && r.status !== 'sent' ? markFailed(r, { now, error: e.message }) : r));
    await putCheckins(state.checkins.filter(r => keys.has(r.idempotency_key)));
    log(`sync failed: ${e.message} - check-ins stay on the phone and retry`, 'error');
  } finally {
    state.syncing = false;
    renderSync();
  }
}

// Drain regularly, not only after a scan: a check-in recorded offline must
// reach the table as soon as WiFi returns, even if nobody scans again.
setInterval(() => sync('timer'), 15_000);

// --- roster --------------------------------------------------------------

async function installRoster(payload, meta, source) {
  const errors = validateRoster(payload);
  if (errors.length) { log(`roster rejected: ${errors.join('; ')}`, 'error'); return false; }

  const { index, collisions, unusable } = indexVisitors(payload);
  state.index = index;
  state.rosterMeta = { ...meta, count: index.size, source, event: payload.event };
  for (const c of collisions) log(`ID collision after normalising: ${JSON.stringify(c.raw)} both map to ${c.id}`, 'error');
  for (const u of unusable) log(`roster key ${JSON.stringify(u)} is not badge-shaped and can never be scanned`, 'warn');

  $('rosterText').innerHTML =
    `<b>${index.size}</b> visitors · ${escapeHtml(source)}` +
    (collisions.length ? ` · <span style="color:var(--bad)">${collisions.length} ID collision(s)</span>` : '') +
    `<br><span style="color:var(--dim);font-size:12px">${escapeHtml(payload.event || '')} · built ${escapeHtml((payload.generated_at || '').slice(0, 16))}</span>`;
  return true;
}

async function bootRoster() {
  const cached = await loadRoster().catch(() => null);
  if (cached && validateRoster(cached).length === 0) {
    await installRoster(cached, cached, `cached on device`);
    return;
  }
  // The bundled roster is the SYNTHETIC sample and nothing else. GitHub Pages
  // serves a public site even from a private repo, so the real registrant data
  // can never live here - it is loaded from the phone with "Load roster file".
  try {
    const res = await fetch('demo-roster.sample.json', { cache: 'no-cache' });
    const payload = await res.json();
    if (await installRoster(payload, { fetched_at: new Date().toISOString() }, 'bundled sample (synthetic)')) {
      await saveRoster(payload, { fetched_at: new Date().toISOString() });
    }
  } catch (e) {
    $('rosterText').textContent = `no roster: ${e.message}`;
    log(`roster load failed: ${e.message}`, 'error');
  }
}

$('fRoster').onchange = async ev => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const result = await importRosterFile(file);
    if (!result) return;
    const { payload, summary } = result;
    const decision = acceptReplacement(state.rosterMeta, payload);
    if (!decision.accept && decision.errors.length) {
      log(`roster file rejected: ${decision.errors.join('; ')}`, 'error');
      alert(`Roster not loaded:\n\n${decision.errors.join('\n')}`);
      return;
    }
    const meta = { fetched_at: new Date().toISOString() };
    if (await installRoster(payload, meta, `file: ${file.name}`)) {
      await saveRoster(payload, meta);
      log(`roster loaded from ${file.name}: ${summary}`, 'ok');
      alert(
        `Roster loaded: ${payload.count} visitors.\n${summary}\n\n` +
        'Only name, host, badge location, company and status were kept on this phone.\n\n' +
        'Now DELETE the file from Downloads: it still contains e-mail addresses and phone numbers.'
      );
    }
  } catch {
    // Never log the exception text: Chrome's JSON.parse error quotes the first
    // bytes of the file, which in a real export is a visitor's name.
    log(`could not read ${file.name} as a roster (content not logged)`, 'error');
    alert('Could not read this file as a roster. Export the sheet from Excel as "CSV UTF-8" and try again.');
  }
};

/**
 * Accepts either the Excel CSV export or a roster.json, told apart by CONTENT,
 * not by file name: a re-export arrives as "EXCELNAME (1).csv", and Android's
 * file picker is inconsistent about MIME types for CSV.
 *
 * A CSV is reduced right here, in memory, by the same code build-roster.mjs
 * uses. The full text (with e-mail and phone columns) is a local variable that
 * goes out of scope when this returns; only the reduced payload is stored.
 */
async function importRosterFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // "PK": a zip container, i.e. .xlsx. Parsing that needs a library we refuse to ship.
    alert('This is an Excel workbook (.xlsx). In Excel use File → Save As → "CSV UTF-8 (Comma delimited)" and load that.');
    return null;
  }
  const { text, encoding } = decodeCsvBytes(bytes);
  if (/^\s*\{/.test(text)) {
    return { payload: JSON.parse(text), summary: 'roster.json' };
  }
  const r = reduceExport(text);
  if (!r.ok) {
    log(`CSV import failed: ${r.errors.join('; ')}`, 'error');
    alert(`This CSV could not be imported:\n\n${r.errors.join('\n')}`);
    return null;
  }
  for (const w of r.warnings) log(`import: ${w}`, 'warn');
  const payload = rosterPayload({ visitors: r.visitors, sourceFile: file.name, generatedAt: new Date().toISOString() });
  payload.checksum = await checksumVisitors(payload.visitors, crypto.subtle);
  const summary = `${r.stats.rows} rows, ${r.stats.kept} kept, ${r.stats.skippedNoId} without ID, ` +
    `${r.stats.duplicates} duplicate IDs, ${encoding}, delimiter ${JSON.stringify(r.delimiter)}` +
    (r.warnings.length ? `, ${r.warnings.length} warning(s) in the log` : '');
  return { payload, summary };
}

// --- controls ------------------------------------------------------------

$('bConnect').onclick = () => link.connectFromUserGesture();
$('bDisconnect').onclick = () => link.disconnect();
$('bSync').onclick = () => sync('manual');
$('bLoad').onclick = () => $('fRoster').click();
$('bClear').onclick = () => { $('log').textContent = ''; };
$('bCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(`${$('env').textContent}\n\n${$('log').innerText}`); log('log copied', 'ok'); }
  catch { log('clipboard blocked - long-press the log and copy by hand', 'warn'); }
};

$('tpl').value = state.template;
$('tpl').onchange = e => {
  state.template = e.target.value;
  localStorage.setItem('template', state.template);
  log(`template -> ${state.template}`, 'dim');
};

/** Exercises the whole path except the socket: lookup, greeting, check-in,
 *  outbox. Lets the flow be validated on a desk with no scanner in reach. */
$('bSim').onclick = () => {
  const ids = [...state.index.keys()];
  if (!ids.length) { log('no roster loaded', 'warn'); return; }
  const id = ids[Math.floor(Math.random() * ids.length)];
  log(`simulating a scan of ${id}`, 'dim');
  onScan({ code: id }).catch(e => log(e.message, 'error'));
};

// --- MAI bisection probes ------------------------------------------------

for (const [key, probe] of Object.entries(PROBES)) {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = probe.label;
  b.onclick = () => {
    if (!link.serials.device_serial) { log('probe not sent: no MAI serial yet, scan one real badge first', 'error'); return; }
    const cmd = withAck(probe.build({ serials: link.serials, eventId: crypto.randomUUID(), now: Date.now() }), $('ack').value);
    // Synthetic sample text only, so the full payload is safe to log and to copy.
    log(`--- probe ${key} ---`, 'warn');
    log(JSON.stringify(cmd), 'dim');
    if (link.sendNow(cmd)) log(`probe ${key} sent (${cmd.event_id}). Watch the MAI, then this log for an ACK or errors frame.`, 'ok');
  };
  $('probes').appendChild(b);
}

// --- lifecycle -----------------------------------------------------------

// Timestamps, not timer ticks: a backgrounded Android tab has its timers frozen
// and its socket silently killed, so every route back into the foreground has
// to re-check by wall clock.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { link.resume('visibilitychange'); sync('resume'); }
});
window.addEventListener('pageshow', () => link.resume('pageshow'));
window.addEventListener('online', () => { link.resume('online'); sync('online'); });

window.onerror = (m, s, l, c, e) => log(`window.onerror: ${m} ${e?.stack ?? ''}`, 'error');
window.onunhandledrejection = e => log(`unhandled rejection: ${e.reason}`, 'error');

(async function boot() {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  $('env').textContent = [
    `build     ${BUILD}`,
    `origin    ${location.origin}`,
    `secure    ${window.isSecureContext}`,
    `display   ${standalone ? 'installed PWA' : 'browser tab'}`,
    `device    ${deviceId()}`,
    `api       ${API_BASE || '(none - check-ins stay on this device)'}`,
    `eventkey  ${EVENT_KEY ? `set (${EVENT_KEY.length} chars)` : 'not set'}`,
    `UA        ${navigator.userAgent}`,
  ].join('\n');
  log(`boot · ${standalone ? 'installed PWA' : 'browser tab'} · secureContext=${window.isSecureContext}`, 'dim');

  try {
    await openDb();
    const p = await requestPersistence();
    log(`storage persistence: ${p.supported ? p.persisted : 'unsupported'}`, p.persisted ? 'ok' : 'warn');
  } catch (e) {
    log(`IndexedDB unavailable: ${e.message} - check-ins cannot survive a reload`, 'error');
  }

  renderSerials();
  await bootRoster();
  state.checkins = await allCheckins().catch(() => []);
  renderSync();
  link._setState('needs-tap', 'tap to connect');

  // The socket lives in the foreground document. The service worker only ever
  // caches the shell: local network requests from a service worker fail by
  // specification, so it must never be anywhere near ws://localhost.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => log('service worker registered (shell cache only)', 'dim'))
      .catch(e => log(`service worker failed: ${e.message}`, 'warn'));
  }
})();
