#!/usr/bin/env node
/**
 * build-roster.mjs - turn the ProPulse registrant export into the roster file.
 *
 * Optional since 2026-09-24: the phone app now imports the Excel CSV directly
 * and performs the same reduction on the device. This tool remains for the
 * stricter path, where only the reduced roster.json ever leaves the laptop.
 *
 * All parsing and all PII reduction live in web/src/csv-roster.js, shared with
 * the phone, so the two can never disagree about which columns survive.
 *
 * Usage:
 *   node tools/build-roster.mjs <input.csv> [--out roster.json] [--sample] [--strict]
 *
 *   --sample   print ONE fully-rendered record so you can eyeball the mapping.
 *              Off by default: normal runs print counts only, never PII.
 *   --strict   exit non-zero on any warning (use this in a release step).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { basename } from 'node:path';
import { decodeCsvBytes, reduceExport, rosterPayload, checksumVisitors } from '../web/src/csv-roster.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const outIdx = argv.indexOf('--out');
const outPath = outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : 'roster.json';
const inPath = argv.filter(a => !a.startsWith('--')).find(p => p !== outPath);

if (!inPath) {
  console.error('usage: node tools/build-roster.mjs <input.csv> [--out roster.json] [--sample] [--strict]');
  process.exit(2);
}

const { text, encoding } = decodeCsvBytes(readFileSync(inPath));
const r = reduceExport(text);
if (!r.ok) {
  for (const e of r.errors) console.error(`${inPath}: ${e}`);
  process.exit(1);
}

const payload = rosterPayload({ visitors: r.visitors, sourceFile: basename(inPath), generatedAt: new Date().toISOString() });
payload.checksum = await checksumVisitors(payload.visitors, webcrypto.subtle);
writeFileSync(outPath, JSON.stringify(payload), 'utf8');

const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`\n  ${basename(inPath)}  ->  ${outPath}`);
console.log(`  encoding ${encoding}   delimiter ${JSON.stringify(r.delimiter)}   ${r.stats.rows} rows read   ${r.stats.kept} visitors kept   ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  checksum ${payload.checksum}`);
console.log('  kept columns: id, full_name, host, badge_location, company, status. Everything else dropped.');
console.log('\n  status breakdown:');
for (const [s, n] of Object.entries(r.stats.byStatus).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${s}`);
if (r.stats.skippedNoId) console.log(`\n  ${r.stats.skippedNoId} row(s) skipped: no ProPulse ID`);
if (r.warnings.length) {
  console.log(`\n  ${r.warnings.length} warning(s):`);
  for (const w of r.warnings) console.log(`    ! ${w}`);
} else {
  console.log('\n  no warnings');
}
if (flags.has('--sample')) {
  const [id, rec] = Object.entries(payload.visitors)[0] ?? [];
  if (id) {
    console.log('\n  --sample (contains real data, do not paste into chat or tickets):');
    console.log(`    ${JSON.stringify({ id, ...rec })}`);
  }
}
console.log('');
if (flags.has('--strict') && r.warnings.length) process.exit(1);
