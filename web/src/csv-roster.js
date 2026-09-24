/**
 * csv-roster.js - the ONE place a registrant export is turned into a roster.
 *
 * Used by both:
 *   - tools/build-roster.mjs on the laptop, and
 *   - the phone app, which since 2026-09-24 accepts the Excel CSV export
 *     directly (Tobias's decision: the reduced roster.json step was friction).
 *
 * This is the PII firewall. Of the ~21 columns in the export it keeps the
 * fields a MAI cell displays, plus status, and nothing else. E-mail, phone,
 * address and title are read into memory for the length of one parse and are
 * never copied into the result. On the phone that result is the only thing
 * that reaches IndexedDB; the file text is never stored and never logged.
 *
 * Pure functions, no DOM, no Node APIs: it has to run in both places.
 */

// --- decoding ------------------------------------------------------------

/**
 * Excel on Windows writes "CSV (Comma delimited)" as Windows-1252 and only
 * "CSV UTF-8" as UTF-8. Try strict UTF-8 first; if the bytes are not valid
 * UTF-8, decode as Windows-1252 instead of corrupting "Öberg" into "?berg".
 * Returns which one was used so the caller can say so.
 */
export function decodeCsvBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    text = new TextDecoder('windows-1252').decode(u8);
    encoding = 'windows-1252';
  }
  return { text: text.replace(/^﻿/, ''), encoding };
}

// --- RFC 4180 CSV parser -------------------------------------------------

/** German Excel writes ';', English Excel ','. Look at the header line only,
 *  outside quotes, and take whichever candidate appears most. */
export function sniffDelimiter(text) {
  const nl = text.indexOf('\n');
  const header = text.slice(0, nl === -1 ? text.length : nl);
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
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

export function parseCsv(text, delimiter) {
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
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// --- column resolution ---------------------------------------------------

const norm = s => s.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Marketing renames columns between events, so match loosely by name. Order
 *  within each list is priority: "Account Owner" beats "Related Record Owner". */
export const COLUMNS = {
  id: ['propulseid', 'propulse id', 'contentqrinhalt', 'qrcontent'],
  full_name: ['fullname'],
  first_name: ['firstname'],
  last_name: ['lastname'],
  host: ['accountowner', 'host', 'relatedrecordowner'],
  badge_location: ['badgelocation', 'badgeloc', 'location'],
  company: ['company', 'accountname', 'organisation', 'organization'],
  status: ['memberstatus', 'status'],
};

/** Columns a roster may be built without. Anything else missing is fatal. */
const SOFT = ['full_name', 'first_name', 'last_name', 'status', 'company'];

export function resolveColumns(header) {
  const index = new Map(header.map((h, i) => [norm(h), i]));
  const found = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    const hit = aliases.map(a => index.get(norm(a))).find(v => v !== undefined);
    if (hit === undefined) missing.push(key); else found[key] = hit;
  }
  return { found, missing };
}

// --- reduction -----------------------------------------------------------

/**
 * Parse an export and reduce it to the roster.
 *
 * Every message returned names row numbers, counts or COLUMN HEADERS - never a
 * cell value. That is deliberate: on the phone these messages are shown and
 * logged, and a log can be copied off the device.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], visitors: object,
 *             stats: object, delimiter: string }}
 */
export function reduceExport(text) {
  const errors = [];
  const warnings = [];
  const stats = { rows: 0, kept: 0, skippedNoId: 0, duplicates: 0, noBadgeLocation: 0, noHost: 0, noCompany: 0, byStatus: {} };

  if (text.includes('�')) {
    warnings.push('File contains invalid characters. Non-ASCII names may be corrupted. Re-export as "CSV UTF-8".');
  }
  if (/^\s*[{[]/.test(text)) {
    return { ok: false, errors: ['This is JSON, not a CSV export.'], warnings, visitors: {}, stats, delimiter: ',' };
  }

  const delimiter = sniffDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (rows.length < 2) {
    return { ok: false, errors: ['No data rows found in the file.'], warnings, visitors: {}, stats, delimiter };
  }

  const header = rows[0];
  const { found, missing } = resolveColumns(header);
  const hardMissing = missing.filter(m => !SOFT.includes(m));
  if (hardMissing.length) {
    errors.push(
      `Required column(s) not found: ${hardMissing.join(', ')}. ` +
      `Headers seen: ${header.map(h => JSON.stringify(h.trim())).join(', ')}`
    );
  }
  if (missing.includes('full_name') && (missing.includes('first_name') || missing.includes('last_name'))) {
    errors.push('Need either a "Full Name" column or both "First Name" and "Last Name".');
  }
  if (errors.length) return { ok: false, errors, warnings, visitors: {}, stats, delimiter };
  if (missing.includes('company')) warnings.push('No company column found: the Company cell will show an em dash for everyone.');

  const cell = (row, key) => (found[key] !== undefined ? (row[found[key]] ?? '').trim() : '');
  const visitors = {};
  const seen = new Map();

  for (const row of rows.slice(1)) {
    stats.rows++;
    const rawId = cell(row, 'id');
    const id = rawId.replace(/\.0+$/, ''); // Excel loves turning 1 into 1.0
    if (!id) { stats.skippedNoId++; continue; }
    if (!/^\d+$/.test(id)) {
      warnings.push(`Row ${stats.rows}: ProPulse ID is not a plain integer, so no badge scan can match it.`);
    }

    const fullName = cell(row, 'full_name') || [cell(row, 'first_name'), cell(row, 'last_name')].filter(Boolean).join(' ');
    const host = cell(row, 'host');
    const badgeLocation = cell(row, 'badge_location');
    const company = cell(row, 'company');
    const status = cell(row, 'status') || 'Unknown';

    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    if (seen.has(id)) {
      stats.duplicates++;
      warnings.push(`Duplicate ProPulse ID in rows ${seen.get(id)} and ${stats.rows}: the later row wins.`);
    }
    seen.set(id, stats.rows);
    if (!badgeLocation) stats.noBadgeLocation++;
    if (!host) stats.noHost++;
    if (!company) stats.noCompany++;

    // THE firewall line. Exactly these keys, nothing else from the row.
    // Cancelled/no-show registrants are kept on purpose: at the door, the right
    // name for someone who cancelled but came anyway beats "not found".
    visitors[id] = { full_name: fullName, host, badge_location: badgeLocation, company, status };
    stats.kept++;
  }

  if (stats.kept === 0) errors.push('No row had a ProPulse ID.');
  if (stats.noBadgeLocation) warnings.push(`${stats.noBadgeLocation} visitor(s) have no badge location.`);
  if (stats.noHost) warnings.push(`${stats.noHost} visitor(s) have no host / account owner.`);
  if (stats.noCompany && !missing.includes('company')) warnings.push(`${stats.noCompany} visitor(s) have no company.`);

  return { ok: errors.length === 0, errors, warnings, visitors, stats, delimiter };
}

/** The roster envelope. The checksum is added by the caller, because Node and
 *  the browser hash differently (node:crypto vs SubtleCrypto). */
export function rosterPayload({ visitors, sourceFile, generatedAt }) {
  return {
    schema: 'propulse-roster/1',
    event: 'ProPulse 2026 Chicago',
    generated_at: generatedAt,
    source_file: sourceFile,
    count: Object.keys(visitors).length,
    visitors,
  };
}

/** sha256 over JSON.stringify(visitors), first 16 hex chars. Same value as
 *  tools/build-roster.mjs and roster.verifyChecksum. */
export async function checksumVisitors(visitors, subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(visitors)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
