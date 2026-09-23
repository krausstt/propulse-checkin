#!/usr/bin/env node
/**
 * check-public.mjs - the last gate before anything becomes public.
 *
 * This repository is public and its Pages site is public. The .gitignore
 * firewall stops real files by NAME. This script checks CONTENT, because the
 * failure that actually happened on this project was a sample file whose name
 * was fine and whose first row was not.
 *
 * It fails when a tracked file:
 *   - is a spreadsheet other than the one synthetic sample
 *   - contains an e-mail address outside the allowed domains
 *   - contains something shaped like a phone number in the sample or roster
 *   - is a roster (anything with a "visitors" map) other than the demo one
 *   - puts a field on the demo roster that no phone may hold
 *   - contains a string on the denylist (known real customer data)
 *
 * Runs in CI before every Pages deploy, and locally:  npm run check-public
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SAMPLE = 'data/sample/registrants.sample.csv';
const DEMO = 'web/demo-roster.sample.json';

// example.* is reserved for documentation by RFC 2606. The other two are the
// commit identities, which are public by being in every commit anyway.
const ALLOWED_EMAIL = /@(example\.(com|org|net|se|cn|de)|proglove\.de|anthropic\.com)$/i;

// Strings known to be real, which must never come back. Kept as fragments,
// lower-cased, so the list itself does not republish them in full.
const DENY = ['linxdeep', 'customerdomain'];

const ALLOWED_ROSTER_FIELDS = new Set(['full_name', 'host', 'badge_location', 'company', 'status']);

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];

for (const f of files) {
  if (/\.(csv|tsv|xlsx?|xlsm)$/i.test(f) && f !== SAMPLE) problems.push(`${f}: spreadsheet outside the synthetic sample`);
  if (f === 'tools/check-public.mjs') continue; // holds the denylist itself

  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lower = text.toLowerCase();

  for (const d of DENY) if (lower.includes(d)) problems.push(`${f}: contains denylisted real data ("${d.slice(0, 3)}…")`);

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!ALLOWED_EMAIL.test(m[0])) problems.push(`${f}: e-mail outside allowed domains (${m[0].replace(/^[^@]+/, '***')})`);
  }

  if ((f === SAMPLE || f === DEMO) && /\+?\d[\d ()./-]{8,}\d/.test(text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ''))) {
    problems.push(`${f}: contains something shaped like a phone number`);
  }

  if (f.endsWith('.json')) {
    let j; try { j = JSON.parse(text); } catch { continue; }
    if (j && typeof j.visitors === 'object') {
      if (f !== DEMO) { problems.push(`${f}: a roster file other than the demo roster is tracked`); continue; }
      if (j.source_file !== 'registrants.sample.csv') problems.push(`${f}: not built from the synthetic sample`);
      for (const rec of Object.values(j.visitors)) {
        for (const k of Object.keys(rec)) if (!ALLOWED_ROSTER_FIELDS.has(k)) problems.push(`${f}: forbidden field "${k}"`);
      }
    }
  }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`PUBLIC-CONTENT CHECK FAILED (${unique.length}):`);
  for (const p of unique) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`public-content check passed: ${files.length} tracked files, no customer data found`);
