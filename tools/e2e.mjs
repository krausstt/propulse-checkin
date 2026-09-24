#!/usr/bin/env node
/**
 * e2e.mjs - drives the real app in real Chromium against the mock INSIGHT
 * Mobile server, so the scan path is verified before anybody carries a phone
 * to a booth.
 *
 * What it covers: socket connect on a user tap, the inbound scan event, the
 * roster lookup, the outbound display_v2! payload as the server actually
 * receives it, the on-screen greeting, the check-in counter, and whether
 * check-ins survive a reload.
 *
 * What it CANNOT cover: Chrome's Local Network Access gate (desktop Chromium
 * loopback-to-loopback is not the same check an HTTPS page on Android faces)
 * and the MAI itself. Those still need web/lna-test.html on real hardware.
 *
 * Playwright is installed globally in this environment and is deliberately NOT
 * a project dependency - `npm test` stays dependency-free.
 *
 *   node tools/e2e.mjs [--headed]
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const WEB = new URL('../web/', import.meta.url).pathname;
const PORT = 8099;
const WS_PORT = 9998;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const failures = [];
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`); failures.push(name); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(label, fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- static server (zero deps) -------------------------------------------
const site = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = join(WEB, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => site.listen(PORT, '127.0.0.1', r));

// --- mock INSIGHT Mobile --------------------------------------------------
const mock = spawn(process.execPath, [new URL('mock-insight.mjs', import.meta.url).pathname, '--port', String(WS_PORT)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let mockOut = '';
mock.stdout.on('data', d => { mockOut += d.toString(); process.stdout.write(''); });
const sendScan = code => mock.stdin.write(`${code}\n`);
await until('mock listening', () => mockOut.includes('stand-in on ws://'));

// --- browser --------------------------------------------------------------
// Playwright ships CommonJS, and a dynamic import() of it yields a namespace
// with no named exports, so require it outright. The base path is the global
// install: deliberately not a project dependency, so `npm test` stays clean.
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  console.log('\nBOOT');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await until('roster loaded', async () => /5 visitors/.test(await page.textContent('#rosterText')));
  check('bundled synthetic roster loads', true);
  check('roster is the sample, not real data', /synthetic/.test(await page.textContent('#rosterText')));

  console.log('\nCONNECT (user tap)');
  check('does not auto-connect before a tap', (await page.textContent('#linkText')).includes('Tap to connect'));
  await page.click('#bConnect');
  await until('socket open', async () => (await page.textContent('#linkText')) === 'Scanner connected');
  check('a tap opens the socket', true);

  console.log('\nSCAN a known badge');
  sendScan('1');
  await until('greeting rendered', async () => (await page.textContent('#gName')) === 'Nolan Wong');
  check('greets the visitor by name', true);
  const meta = await page.textContent('#gMeta');
  check('shows company, host and badge location', /Anonymized Information/.test(meta) && /Rohan/.test(meta) && /B-12/.test(meta), meta);
  check('badge says CHECKED IN', /CHECKED IN/.test(await page.textContent('#gBadge')));

  await until('display received', () => mockOut.includes('display_v2!'));
  check('the MAI command reached the server', true);
  check('uses the template the UI selected', /template=pg_work5_t3/.test(mockOut));
  check('pg_work5_t3 sends no forced_orientation', /forced_orientation=\(absent\)/.test(mockOut));
  check('device_serial was learned from the scan, not hardcoded', /device=MAIXBEU011089/.test(mockOut));
  check('full name is FOCUSED and highlighted', /field_bottom.*<-- FOCUSED HIGHLIGHTED/.test(mockOut));
  check('ID is SUCCESS, not highlighted', /field_top_left.*<-- SUCCESS$/m.test(mockOut));
  check('badge location (middle left) is FOCUSED, not highlighted', /field_middle_left\s+Badge Location.*<-- FOCUSED$/m.test(mockOut));
  check('host is top right, stateless', /field_top_right\s+Host\s+Rohan$/m.test(mockOut));
  check('company carries no state', /field_middle_right\s+Company Name[^\n]*Inc$/m.test(mockOut));
  check('full name is in field_bottom', /field_bottom\s+Full Name of Visitor\s+Nolan Wong/.test(mockOut));

  console.log('\nCHECK-IN');
  await until('counter moved', async () => (await page.textContent('#nTotal')) === '1');
  check('the check-in was recorded', true);
  check('it is honest that nothing synced', /No server configured/.test(await page.textContent('#bSync')));
  check('it counts as unsynced', (await page.textContent('#nPending')) === '1');

  console.log('\nUNKNOWN badge');
  sendScan('9999');
  await until('miss rendered', async () => /NOT REGISTERED/.test(await page.textContent('#gBadge')));
  check('an unknown ID is loud, not blank', true);
  check('the unmatched scan is still recorded', (await page.textContent('#nTotal')) === '2');

  console.log('\nNON-BADGE barcode');
  sendScan('junk');
  await until('ignored rendered', async () => /IGNORED/.test(await page.textContent('#gBadge')));
  check('an EAN off a giveaway does not fake a check-in', (await page.textContent('#nTotal')) === '2');

  console.log('\nMALFORMED frame');
  const before = await page.textContent('#nTotal');
  sendScan('bad');
  await sleep(400);
  check('garbage from the socket does not crash the app', (await page.textContent('#linkText')) === 'Scanner connected');
  check('garbage records nothing', (await page.textContent('#nTotal')) === before);

  console.log('\nDUPLICATE scan inside the dedupe window');
  sendScan('2');
  await until('second visitor', async () => (await page.textContent('#gName')) === 'Maria Santos');
  const afterFirst = await page.textContent('#nTotal');
  sendScan('2');
  await sleep(600);
  check('the scanner double-firing is one visit', (await page.textContent('#nTotal')) === afterFirst);

  console.log('\nRELOAD (check-ins must survive)');
  const total = await page.textContent('#nTotal');
  await page.reload();
  await until('counters restored', async () => (await page.textContent('#nTotal')) === total);
  check('check-ins survive a reload', true);
  check('the socket does not silently reconnect after reload', (await page.textContent('#linkText')).includes('connect'));

  console.log('\nSIMULATE after reload (serials must be remembered)');
  const displaysBefore = (mockOut.match(/display_v2!/g) || []).length;
  await page.click('#bConnect');
  await until('socket open again', async () => (await page.textContent('#linkText')) === 'Scanner connected');
  console.log('\nINSIGHT reports no scanner (frame captured on hardware)');
  const serialsBefore = await page.evaluate(() => localStorage.getItem('serials'));
  sendScan('noscanner');
  await until('error banner', async () => /ERROR_DEVICE_NOT_FOUND/.test(await page.textContent('#insightErr')));
  check('INSIGHT error is shown on the main screen', await page.isVisible('#insightErr'));
  check('it tells the user to pair in INSIGHT Mobile', /pair the MAI/i.test(await page.textContent('#insightErr')));
  check('the placeholder serial is NOT learned', (await page.evaluate(() => localStorage.getItem('serials'))) === serialsBefore);

  await page.click('#bSim');
  await until('simulated display reached the mock', () => (mockOut.match(/display_v2!/g) || []).length > displaysBefore);
  check('Simulate scan reaches the MAI without a fresh real scan', true);

  console.log('\nMAI PROBES');
  await page.evaluate(() => { document.querySelector('details').open = true; });
  for (const [label, expect] of [
    ['Feedback beep (no display)', /<- feedback!/],
    ['Capture pg_work4_t4, verbatim', /template=pg_work4_t4/],
    ['Capture pg_work5_t3, original states', /field_middle_right.*<-- FOCUSED HIGHLIGHTED/],
  ]) {
    await page.click(`#probes button:has-text("${label}")`);
    await until(label, () => expect.test(mockOut));
    check(`probe sent: ${label}`, true);
  }
  check('probes ask for an ack by default', /ack_required=ON_HANDLED/.test(mockOut), 'mock did not see ack_required');

  console.log('\nIMPORT the Excel CSV export on the phone');
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  // The real export's header (2026-09-24), synthetic values, German-Excel
  // semicolons, and the re-export file name that used to be refused.
  const H = ['Member Status','First Name','Last Name','Email','Title','State (text only)','Related Record Owner','Account Owner','Phone','Zip/Postal Code','City','Country (text only)','Company','Member Type','Register Type','Badge location','Propulse ID','Content QR Inhalt','C:\\Users\\someone\\QR Codes','Attented','Full Name'];
  const row = (id, first, last, company, badge) => ['Registered', first, last, `${first.toLowerCase()}@example.com`, 'Engineer', '', 'Insight Web Portal Integration User', 'Ann Host', 'PHONENUMBER', '', '', 'Canada', company, 'Contact', '', badge, id, id, '', '#N/A', `${first} ${last}`];
  const csvText = [H, row('41', 'Imported', 'Person', 'Csv Import GmbH', 'Z-9'), row('42', 'Second', 'Person', 'Other Co', 'Z-8')]
    .map(r => r.join(';')).join('\r\n');
  await page.setInputFiles('#fRoster', { name: 'EXCELNAME (1).csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFF' + csvText, 'utf8') });
  await until('roster replaced', async () => /2<\/b> visitors · file: EXCELNAME \(1\)\.csv/.test(await page.innerHTML('#rosterText')));
  check('a ".csv" named "EXCELNAME (1).csv" imports', true);
  await until('delete reminder', () => dialogs.some(m => /DELETE the file/.test(m)));
  check('the user is told to delete the file afterwards', true);
  const stored = await page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('propulse-checkin'); r.onsuccess = () => {
      const g = r.result.transaction('roster').objectStore('roster').get('current'); g.onsuccess = () => res(JSON.stringify(g.result));
    };
  }));
  check('IndexedDB holds no e-mail, phone or title', !/@example|PHONENUMBER|Engineer|Canada/.test(stored));
  const logText = await page.textContent('#log');
  check('the import logs no names', !/Imported Person|Second Person|Csv Import/.test(logText));
  sendScan('41');
  await until('imported visitor greeted', async () => (await page.textContent('#gName')) === 'Imported Person');
  check('a scan finds the imported visitor', /Csv Import GmbH/.test(await page.textContent('#gMeta')));

  console.log('\nEXPORT attendance');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bExport')]);
  const exported = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  check('export is named per device', /^attendance-dev-[0-9a-f]{8}-.*\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('export contains the check-ins', /^41,/m.test(exported) && exported.startsWith('propulse_id,scanned_at,device_id,matched,idempotency_key'));
  check('export contains no names', !/Imported|Person|Nolan|Maria/.test(exported));

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  console.log(`\nABORTED: ${e.message}`);
  // Dump both sides of the wire. A failure here is almost always visible in
  // one of them, and guessing from a bare timeout wastes a whole run.
  try { console.log(`\n--- in-page log ---\n${await page.textContent('#log')}`); } catch {}
  if (pageErrors.length) console.log(`\n--- page errors ---\n${pageErrors.join('\n')}`);
  console.log(`\n--- mock server output ---\n${mockOut}`);
  failures.push(e.message);
} finally {
  await browser.close();
  mock.kill();
  site.close();
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) { console.log(`FAILED:\n  - ${failures.join('\n  - ')}`); process.exit(1); }
