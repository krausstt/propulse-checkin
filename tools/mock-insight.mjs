#!/usr/bin/env node
/**
 * mock-insight.mjs - stands in for INSIGHT Mobile's WebSocket server.
 *
 * INSIGHT Mobile hosts the server; the web app is the client. This is that
 * server, so the whole scan path can be exercised on a laptop before anybody
 * puts a phone and a MAI on a desk. It speaks just enough RFC 6455 for text
 * frames, with zero dependencies - same rule as the rest of the repo.
 *
 * It does two things:
 *   - sends scan events, so the app receives badges
 *   - prints every display_v2! command it receives, pretty-printed
 *
 * Usage:
 *   node tools/mock-insight.mjs                 # port 9998, interactive
 *   node tools/mock-insight.mjs --port 9998
 *   node tools/mock-insight.mjs --scan 1 --scan 2 --delay 1500 --once
 *
 * Interactive: type a badge ID and press enter to send that scan.
 * Type "junk" to send a non-badge barcode, "bad" to send a malformed frame.
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const all = name => argv.reduce((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const PORT = Number(opt('port', 9998));
const DELAY = Number(opt('delay', 1200));
const SCANS = all('scan');
const ONCE = argv.includes('--once');

const DEVICE_SERIAL = opt('device-serial', 'MAIXBEU011089');
const GATEWAY_SERIAL = opt('gateway-serial', 'd7c0e70f-f37e-4a3a-8f3d-700de57a2d8e');

// --- minimal RFC 6455 ----------------------------------------------------

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Returns [{opcode, payload}], plus whatever bytes are left over. */
function decodeFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    const masked = (buf[i + 1] & 0x80) !== 0;
    let len = buf[i + 1] & 0x7f;
    let p = i + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k % 4];
    out.push({ opcode, payload });
    i = p + len;
  }
  return { frames: out, rest: buf.subarray(i) };
}

// --- server --------------------------------------------------------------

const clients = new Set();

const server = createServer((_req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('mock INSIGHT Mobile: connect over WebSocket\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  console.log(`\n[mock] client connected (${clients.size} total)`);

  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { socket.end(); return; }
      if (f.opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; }
      if (f.opcode !== 0x1) continue;
      onCommand(f.payload.toString('utf8'));
    }
  });
  const drop = () => { clients.delete(socket); console.log(`[mock] client gone (${clients.size} left)`); };
  socket.on('close', drop);
  socket.on('error', drop);

  if (SCANS.length) playScript();
});

function onCommand(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { console.log(`[mock] <- non-JSON: ${text}`); return; }

  if (msg.event_type === 'display_v2!') {
    const view = msg.screen_views?.[0] ?? {};
    const template = Object.keys(view).find(k => k !== 'ref_id');
    const cells = view[template] ?? {};
    console.log(`\n[mock] <- display_v2! template=${template} event_id=${msg.event_id}`);
    console.log(`       forced_orientation=${msg.forced_orientation ?? '(absent)'} device=${msg.device_serial}`);
    for (const [name, cell] of Object.entries(cells)) {
      if (name === 'title') { console.log(`       title: ${cell}`); continue; }
      const st = cell?.state;
      const hot = st ? `  <-- ${st.type}${st.highlighted ? ' HIGHLIGHTED' : ''}` : '';
      console.log(`       ${name.padEnd(19)} ${String(cell?.text_header).padEnd(22)} ${cell?.text_content}${hot}`);
    }
    return;
  }
  console.log(`[mock] <- ${msg.event_type ?? '(no event_type)'}`);
}

function scanEvent(code) {
  return JSON.stringify({
    api_version: '1.0',
    event_type: 'scan',
    event_id: randomUUID(),
    time_created: Date.now(),
    scan_code: String(code),
    scan_bytes: Buffer.from(String(code)).toString('base64url'),
    device_serial: DEVICE_SERIAL,
    device_model: 'MAI',
    gateway_serial: GATEWAY_SERIAL,
  });
}

function broadcast(text) {
  const frame = encodeFrame(text);
  for (const c of clients) c.write(frame);
}

function sendScan(code) {
  console.log(`[mock] -> scan ${code}`);
  broadcast(scanEvent(code));
}

async function playScript() {
  for (const code of SCANS) {
    await new Promise(r => setTimeout(r, DELAY));
    sendScan(code);
  }
  if (ONCE) { await new Promise(r => setTimeout(r, 500)); process.exit(0); }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] INSIGHT Mobile stand-in on ws://localhost:${PORT}`);
  console.log(`[mock] device_serial=${DEVICE_SERIAL}`);
  if (!SCANS.length) {
    console.log('[mock] type a badge ID + enter to send a scan ("junk" / "bad" for the nasty paths, "q" to quit)\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => {
      const line = d.trim();
      if (!line) return;
      if (line === 'q') process.exit(0);
      if (line === 'junk') return sendScan('4006381333931');       // an EAN off a giveaway
      if (line === 'bad') { console.log('[mock] -> malformed frame'); return broadcast('{not json'); }
      sendScan(line);
    });
  }
});
