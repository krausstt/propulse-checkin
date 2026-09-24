import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { decodeCsvBytes, reduceExport, rosterPayload, checksumVisitors, sniffDelimiter } from './csv-roster.js';
import { validateRoster, ALLOWED_FIELDS } from './roster.js';

// The REAL export's header, exactly as Tobias pasted it on 2026-09-24, except
// column 19: in the real file it is a Windows path into the marketing
// SharePoint. A generic path stands in for it here, because this repo is public.
const HEADER = [
  'Member Status', 'First Name', 'Last Name', 'Email', 'Title', 'State (text only)',
  'Related Record Owner', 'Account Owner', 'Phone', 'Zip/Postal Code', 'City',
  'Country (text only)', 'Company', 'Member Type', 'Register Type', 'Badge location',
  'Propulse ID', 'Content QR Inhalt', 'C:\\Users\\someone\\Documents\\Events\\01 QR Codes',
  'Attented', 'Full Name',
];
// Synthetic rows in the real shape. Row 1 mirrors the pasted row's gaps: empty
// Register Type and empty Badge location.
const ROWS = [
  ['Registered', 'Nolan', 'Wong', 'nolan@example.com', 'Global Support Engineer', '', 'Insight Web Portal Integration User', 'Rohan Wagh', 'PHONENUMBER', '', '', 'Canada', 'Anonymized Information Technology Inc', 'Contact', '', '', '1', '1', '', '#N/A', 'Nolan Wong'],
  ['Registered', 'Maria', 'Santos', 'maria@example.com', 'Director, Operations', '', 'Insight Web Portal Integration User', 'Eileen Example', 'PHONENUMBER', '', '', 'Brazil', 'Santos Logistica, S.A.', 'Contact', '', 'A-04', '2', '2', '', '#N/A', 'Maria Santos'],
  ['Cancelled', 'Jonas', 'Öberg', 'jonas@example.se', 'VP Supply Chain', '', 'Insight Web Portal Integration User', 'Tobias Krauss', 'PHONENUMBER', '', '', 'Sweden', 'Öberg & Söner AB', 'Contact', '', 'C-21', '3.0', '3', '', '#N/A', 'Jonas Öberg'],
];
const q = v => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (d = ',', eol = '\r\n') => [HEADER, ...ROWS].map(r => r.map(q).join(d)).join(eol) + eol;

test('the real export header is understood', () => {
  const r = reduceExport(csv());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.stats.kept, 3);
  assert.deepEqual(r.visitors['1'], {
    full_name: 'Nolan Wong', host: 'Rohan Wagh', badge_location: '',
    company: 'Anonymized Information Technology Inc', status: 'Registered',
  });
  assert.equal(r.visitors['3'].full_name, 'Jonas Öberg', 'Excel "3.0" is ID 3');
});

test('THE FIREWALL: nothing but the five display fields survives', () => {
  const r = reduceExport(csv());
  for (const rec of Object.values(r.visitors)) {
    assert.deepEqual(Object.keys(rec).sort(), [...ALLOWED_FIELDS].sort());
  }
  const out = JSON.stringify(r.visitors);
  for (const leaked of ['@example', 'PHONENUMBER', 'Global Support Engineer', 'Canada', 'Integration User', 'Contact']) {
    assert.equal(out.includes(leaked), false, `${leaked} must not survive the reduction`);
  }
});

test('messages never contain a cell value', () => {
  // Warnings and errors are shown and logged on the phone, and a log can be
  // copied off the device. They may name rows, counts and headers only.
  const dup = [HEADER, ROWS[0], ROWS[0], ['Registered', 'No', 'Id', 'x@example.com', ...Array(17).fill('')]];
  const r = reduceExport(dup.map(row => row.map(q).join(',')).join('\n'));
  const all = [...r.errors, ...r.warnings].join(' ');
  assert.ok(r.warnings.some(w => /Duplicate/.test(w)));
  for (const v of ['Nolan', 'Wong', 'nolan@', 'Rohan', 'Anonymized']) assert.equal(all.includes(v), false, `leaked ${v}`);
});

test('German Excel semicolons and CRLF work', () => {
  assert.equal(sniffDelimiter(csv(';')), ';');
  const r = reduceExport(csv(';'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.visitors['2'].company, 'Santos Logistica, S.A.', 'a comma inside a ;-file stays in its cell');
});

test('a plain "CSV (Comma delimited)" Windows-1252 export keeps its umlauts', () => {
  // Encode by hand: Windows-1252 maps these characters to single bytes.
  const cp = { 'Ö': 0xd6, 'ö': 0xf6, 'ä': 0xe4, 'ü': 0xfc, 'é': 0xe9 };
  const text = csv();
  const bytes = Uint8Array.from([...text].map(c => cp[c] ?? c.charCodeAt(0)));
  const { text: decoded, encoding } = decodeCsvBytes(bytes);
  assert.equal(encoding, 'windows-1252');
  assert.equal(reduceExport(decoded).visitors['3'].full_name, 'Jonas Öberg');
});

test('the UTF-8 BOM Excel writes for "CSV UTF-8" is stripped', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(csv())]);
  const { text, encoding } = decodeCsvBytes(bytes);
  assert.equal(encoding, 'utf-8');
  assert.equal(reduceExport(text).ok, true, 'BOM must not break the "Member Status" header match');
});

test('a file without the ID column is refused with the headers it did see', () => {
  const r = reduceExport('Name,Email\nA,a@example.com\n');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Required column/);
  assert.match(r.errors[0], /"Email"/, 'headers help diagnose a renamed column');
});

test('JSON handed to the CSV path is refused, not half-parsed', () => {
  assert.equal(reduceExport('{"schema":"propulse-roster/1"}').ok, false);
});

test('the phone-built roster passes the phone validator and the laptop checksum', async () => {
  const r = reduceExport(csv());
  const p = rosterPayload({ visitors: r.visitors, sourceFile: 'EXCELNAME (1).csv', generatedAt: '2026-09-24T00:00:00.000Z' });
  p.checksum = await checksumVisitors(p.visitors, webcrypto.subtle);
  assert.deepEqual(validateRoster(p), []);
  const { createHash } = await import('node:crypto');
  assert.equal(p.checksum, createHash('sha256').update(JSON.stringify(p.visitors)).digest('hex').slice(0, 16));
  assert.equal(p.source_file, 'EXCELNAME (1).csv', 'a re-export file name is fine');
});
