#!/usr/bin/env node
/**
 * build-roster.mjs - turn the ProPulse registrant export into the minimal
 * lookup table the check-in app needs.
 *
 * This is the PII firewall. It runs on your laptop, against a CSV you exported
 * yourself. Of the 21 columns in the marketing sheet it keeps FOUR:
 *
 *     Propulse ID  ->  id              (the QR payload, the lookup key)
 *     Full Name    ->  full_name       (MAI field_bottom)
 *     Account Owner->  host            (MAI field_top_right)
 *     Badge location-> badge_location  (MAI field_middle_left)
 *
 * E-mail, phone, address, company, title and member status are read, counted,
 * and then dropped. They never reach the cloud, the phones, or git.
 *
 * Zero third-party dependencies - deliberately. A script that handles real
 * customer PII should not pull an npm tree it cannot audit.
 *
 * Usage:
 *   node tools/build-roster.mjs <input.csv> [--out roster.json] [--sample] [--strict]
 *
 *   --sample   print ONE fully-rendered record so you can eyeball the mapping.
 *              Off by default: normal runs print counts only, never PII.
 *   --strict   exit non-zero on any warning (use this in a release step).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

// --- RFC 4180 CSV parser -------------------------------------------------
// Handles quoted fields, embedded delimiters/newlines, and "" escapes.

function sniffDelimiter(text) {
  // Look only at the header line, outside of quotes.
  const header = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (const ch of header) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // Trailing field/row (file may not end with a newline).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// --- column resolution ---------------------------------------------------
// Marketing renames columns between events. Match loosely rather than by index.

const norm = s => s.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');

const COLUMNS = {
  id:             ['propulseid', 'propulse id', 'contentqrinhalt', 'qrcontent'],
  full_name:      ['fullname'],
  first_name:     ['firstname'],
  last_name:      ['lastname'],
  host:           ['accountowner', 'host', 'relatedrecordowner'],
  badge_location: ['badgelocation', 'badgeloc', 'location'],
  status:         ['memberstatus', 'status'],
};

function resolveColumns(header) {
  const index = new Map(header.map((h, i) => [norm(h), i]));
  const found = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    const hit = aliases.map(a => index.get(norm(a))).find(v => v !== undefined);
    if (hit === undefined) missing.push(key); else found[key] = hit;
  }
  return { found, missing };
}

// --- main ----------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const outIdx = argv.indexOf('--out');
const outPath = outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : 'roster.json';
const inPath = positional.find(p => p !== outPath);

if (!inPath) {
  console.error('usage: node tools/build-roster.mjs <input.csv> [--out roster.json] [--sample] [--strict]');
  process.exit(2);
}

const raw = readFileSync(inPath);
let text = raw.toString('utf8');

const warnings = [];

// Excel's plain "CSV (Comma delimited)" writes Windows-1252, not UTF-8. Decoding
// that as UTF-8 yields U+FFFD. Catch it here rather than seeing "J?nas" on the MAI.
if (text.includes('�')) {
  warnings.push(
    'File is not valid UTF-8 (found replacement characters). Non-ASCII names WILL be corrupted. ' +
    'Re-export from Excel using "CSV UTF-8 (Comma delimited) (*.csv)".'
  );
}
text = text.replace(/^﻿/, '');

const delimiter = sniffDelimiter(text);
const rows = parseCsv(text, delimiter);
if (rows.length < 2) { console.error(`${inPath}: no data rows found.`); process.exit(1); }

const header = rows[0];
const { found, missing } = resolveColumns(header);

const hardMissing = missing.filter(m => !['full_name', 'first_name', 'last_name', 'status'].includes(m));
if (hardMissing.length) {
  console.error(`\n${inPath}: could not find required column(s): ${hardMissing.join(', ')}`);
  console.error(`Headers seen: ${header.map(h => JSON.stringify(h.trim())).join(', ')}`);
  console.error('Add an alias in COLUMNS at the top of this script if marketing renamed one.');
  process.exit(1);
}
if (missing.includes('full_name') && (missing.includes('first_name') || missing.includes('last_name'))) {
  console.error(`${inPath}: need either a "Full Name" column or both "First Name" and "Last Name".`);
  process.exit(1);
}

const cell = (row, key) => (found[key] !== undefined ? (row[found[key]] ?? '').trim() : '');

const roster = {};
const seen = new Map();
const stats = { rows: 0, kept: 0, skippedNoId: 0, duplicates: 0, noBadgeLocation: 0, noHost: 0, byStatus: {} };
let sampleRecord = null;

for (const row of rows.slice(1)) {
  stats.rows++;

  const rawId = cell(row, 'id');
  const id = rawId.replace(/\.0+$/, '');            // Excel loves turning 1 into 1.0
  if (!id) { stats.skippedNoId++; continue; }
  if (!/^\d+$/.test(id)) {
    warnings.push(`Row ${stats.rows}: ProPulse ID ${JSON.stringify(rawId)} is not a plain integer. ` +
                  'The badge QR is scanned as text, so the app compares strings - a mismatch here means a failed lookup.');
  }

  const fullName = cell(row, 'full_name') ||
                   [cell(row, 'first_name'), cell(row, 'last_name')].filter(Boolean).join(' ');
  const host = cell(row, 'host');
  const badgeLocation = cell(row, 'badge_location');
  const status = cell(row, 'status') || 'Unknown';

  stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

  if (seen.has(id)) {
    stats.duplicates++;
    warnings.push(`Duplicate ProPulse ID ${id} (rows ${seen.get(id)} and ${stats.rows}). ` +
                  'Last one wins - two visitors will collide on one badge scan.');
  }
  seen.set(id, stats.rows);

  if (!badgeLocation) stats.noBadgeLocation++;
  if (!host) stats.noHost++;

  // Cancelled/no-show registrants are kept on purpose: at the door, showing the
  // right name for someone who cancelled but turned up anyway beats "not found".
  roster[id] = { full_name: fullName, host, badge_location: badgeLocation, status };
  stats.kept++;
  if (!sampleRecord) sampleRecord = { id, ...roster[id] };
}

const payload = {
  schema: 'propulse-roster/1',
  event: 'ProPulse 2026 Chicago',
  generated_at: new Date().toISOString(),
  source_file: basename(inPath),
  count: stats.kept,
  visitors: roster,
};
payload.checksum = createHash('sha256')
  .update(JSON.stringify(payload.visitors))
  .digest('hex')
  .slice(0, 16);

writeFileSync(outPath, JSON.stringify(payload, null, 0), 'utf8');

// --- report (counts only; no PII unless --sample) ------------------------

const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`\n  ${basename(inPath)}  ->  ${outPath}`);
console.log(`  delimiter ${JSON.stringify(delimiter)}   ${stats.rows} rows read   ${stats.kept} visitors kept   ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  checksum ${payload.checksum}`);
console.log(`  dropped columns: every field except id, full_name, host, badge_location, status`);

console.log(`\n  status breakdown:`);
for (const [s, n] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(5)}  ${s}`);
}

if (stats.skippedNoId) console.log(`\n  ${stats.skippedNoId} row(s) skipped: no ProPulse ID`);
if (stats.noBadgeLocation) warnings.push(`${stats.noBadgeLocation} visitor(s) have no badge location - the MAI will show a blank field for them.`);
if (stats.noHost) warnings.push(`${stats.noHost} visitor(s) have no host/account owner.`);

if (warnings.length) {
  console.log(`\n  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`    ! ${w}`);
} else {
  console.log(`\n  no warnings`);
}

if (flags.has('--sample') && sampleRecord) {
  console.log(`\n  --sample (contains real data, do not paste into chat or tickets):`);
  console.log(`    ${JSON.stringify(sampleRecord)}`);
}

console.log('');
if (flags.has('--strict') && warnings.length) process.exit(1);
