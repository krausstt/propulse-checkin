import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildTemplate, inlineCode, ZIPFILE_LIMIT } from '../tools/build-template.mjs';

test('the committed template is exactly what the generator produces', () => {
  const committed = readFileSync(new URL('./template.yaml', import.meta.url), 'utf8');
  assert.equal(committed, buildTemplate(), 'run: npm run build-template');
});

test('the inline Lambda fits CloudFormation\'s 4096-character limit', () => {
  assert.ok(inlineCode().length <= ZIPFILE_LIMIT, `${inlineCode().length} chars`);
});

test('the stripped inline code still behaves like the tested source', async () => {
  // Stripping comment lines must not change behaviour. Load the stripped
  // version as a module and run a real request through it.
  const dir = mkdtempSync(join(tmpdir(), 'lambda-'));
  const file = join(dir, 'index.cjs');
  writeFileSync(file, inlineCode());
  const { makeHandler } = createRequire(import.meta.url)(file);
  const items = [];
  const h = makeHandler({ put: async i => { items.push(i); } }, { table: 't', key: 'k'.repeat(24) });
  const r = await h({ headers: { 'x-event-key': 'k'.repeat(24) }, body: JSON.stringify({ checkins: [{
    idempotency_key: '00000001-aaaa-4bbb-8ccc-dddddddddddd', propulse_id: '1',
    scanned_at: '2026-10-01T15:00:00.000Z', device_id: 'dev-0a1b2c3d' }] }) });
  assert.equal(r.statusCode, 200);
  assert.equal(items.length, 1);
});

test('the function role can only write, never read or delete', () => {
  const t = readFileSync(new URL('./template.yaml', import.meta.url), 'utf8');
  const actions = [...t.matchAll(/Action:\s*(dynamodb:[A-Za-z*]+)/g)].map(m => m[1]);
  assert.deepEqual(actions, ['dynamodb:PutItem']);
});

test('the table survives a stack deletion', () => {
  const t = readFileSync(new URL('./template.yaml', import.meta.url), 'utf8');
  assert.match(t, /DeletionPolicy: Retain/);
  assert.match(t, /DeletionProtectionEnabled: true/);
  assert.match(t, /PointInTimeRecoveryEnabled: true/);
});
