#!/usr/bin/env node
/**
 * serve.mjs - a static server for web/, so the app can be opened on a phone on
 * the same WiFi without installing anything. Zero dependencies, like the rest.
 *
 * CAUTION: this serves over plain HTTP. That is fine for a first look at the
 * UI, but it is NOT a valid test of the scanner link: ws://localhost from an
 * http:// page is a different security situation from the https:// origin the
 * phones will really run on. Test the socket on the deployed HTTPS origin.
 *
 *   node tools/serve.mjs [--port 8080]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const WEB = new URL('../web/', import.meta.url).pathname;
const i = process.argv.indexOf('--port');
const PORT = Number(i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = join(WEB, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`serving web/ on:`);
  console.log(`  http://localhost:${PORT}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  http://${n.address}:${PORT}   <- from a phone on the same WiFi`);
    }
  }
  console.log('\nremember: plain HTTP. Good for the UI, not a valid test of the scanner link.');
});
