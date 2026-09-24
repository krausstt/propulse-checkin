#!/usr/bin/env node
/**
 * merge-attendance.mjs - the attendance list, built on the laptop.
 *
 * Inputs: the registrant CSV export (same file the phones import) and one or
 * more attendance-*.csv files exported from the phones. Output: attended.csv
 * with one row per registrant and whether, when and where they were scanned.
 * Git-ignored by *.csv; it contains names, so it stays in the M365 tenant.
 *
 * Why this is the accurate path with no backend: every phone keeps an
 * append-only log with a unique key per scan. Merging all logs, deduplicated
 * by that key, is lossless as long as every phone's export is collected. The
 * report says how many phones and scans went in, so a missing phone is visible.
 *
 *   node tools/merge-attendance.mjs <registrants.csv> <attendance-*.csv...> [--out attended.csv]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeCsvBytes, reduceExport, parseCsv } from '../web/src/csv-roster.js';
import { normalizeId } from '../web/src/roster.js';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const out = oi !== -1 ? argv[oi + 1] : 'attended.csv';
const files = argv.filter((a, i) => !a.startsWith('--') && !(oi !== -1 && i === oi + 1));
const [regPath, ...scanPaths] = files;
if (!regPath || !scanPaths.length) {
  console.error('usage: node tools/merge-attendance.mjs <registrants.csv> <attendance-*.csv...> [--out attended.csv]');
  process.exit(2);
}

const reg = reduceExport(decodeCsvBytes(readFileSync(regPath)).text);
if (!reg.ok) { for (const e of reg.errors) console.error(e); process.exit(1); }
const registrants = new Map(Object.entries(reg.visitors).map(([id, v]) => [normalizeId(id) ?? id, v]));

const byKey = new Map();      // idempotency_key -> scan: dedupes a file loaded twice
const devices = new Set();
for (const p of scanPaths) {
  const rows = parseCsv(decodeCsvBytes(readFileSync(p)).text, ',');
  const head = rows[0].map(h => h.trim());
  const col = n => head.indexOf(n);
  for (const need of ['propulse_id', 'scanned_at', 'device_id', 'idempotency_key']) {
    if (col(need) === -1) { console.error(`${basename(p)}: not an attendance export (no ${need} column)`); process.exit(1); }
  }
  for (const r of rows.slice(1)) {
    const scan = { id: normalizeId(r[col('propulse_id')]) ?? r[col('propulse_id')], at: r[col('scanned_at')], device: r[col('device_id')] };
    byKey.set(r[col('idempotency_key')], scan);
    devices.add(scan.device);
  }
}

// First scan per visitor is their check-in time; count every scan.
const first = new Map();
const count = new Map();
for (const s of byKey.values()) {
  count.set(s.id, (count.get(s.id) ?? 0) + 1);
  if (!first.has(s.id) || s.at < first.get(s.id).at) first.set(s.id, s);
}

const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const lines = [['propulse_id', 'full_name', 'company', 'host', 'status', 'attended', 'first_scan_at', 'first_scan_device', 'scan_count']];
for (const [id, v] of [...registrants].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const f = first.get(id);
  lines.push([id, v.full_name, v.company, v.host, v.status, f ? 'yes' : 'no', f?.at ?? '', f?.device ?? '', count.get(id) ?? 0]);
}
const walkIns = [...first.keys()].filter(id => !registrants.has(id));
for (const id of walkIns.sort()) {
  const f = first.get(id);
  lines.push([id, '(not in registrant export)', '', '', 'UNREGISTERED', 'yes', f.at, f.device, count.get(id)]);
}
writeFileSync(out, lines.map(r => r.map(q).join(',')).join('\r\n') + '\r\n', 'utf8');

const attended = [...registrants.keys()].filter(id => first.has(id)).length;
console.log(`\n  ${scanPaths.length} export file(s) (phones and/or AWS), ${devices.size} distinct device(s), ${byKey.size} unique scans`);
console.log(`  ${attended} of ${registrants.size} registrants attended`);
console.log(`  ${walkIns.length} scanned ID(s) not in the registrant export`);
console.log(`  -> ${out}  (contains names: keep it in the M365 tenant, never commit it)\n`);
console.log('  Check the device count against the number of phones used. A missing phone');
console.log('  export is the one way this list can be incomplete.\n');
