// ProPulse check-in store. Accepts badge IDs and timestamps ONLY.
// Source of truth for the Lambda. tools/build-template.mjs inlines it into
// aws/template.yaml; comment lines are stripped there (CloudFormation caps
// inline code at 4096 characters), so keep every comment on its own line.
'use strict';
const { timingSafeEqual } = require('crypto');

// The server-side PII firewall: a check-in has exactly these four keys.
// Anything more (a name, a company, an e-mail) rejects the whole request.
const FIELDS = ['device_id', 'idempotency_key', 'propulse_id', 'scanned_at'];
const RX = {
  idempotency_key: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  propulse_id: /^\d{1,7}$/,
  device_id: /^dev-[0-9a-f]{8}$/,
  scanned_at: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/,
};

const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Error text names the field, never its value, so logs stay value-free.
function problem(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'not an object';
  if (Object.keys(c).sort().join() !== FIELDS.join()) return `must have exactly ${FIELDS.join(',')}`;
  for (const f of FIELDS) if (typeof c[f] !== 'string' || !RX[f].test(c[f])) return `${f} invalid`;
  if (Number.isNaN(Date.parse(c.scanned_at))) return 'scanned_at invalid';
  return null;
}

function keyOk(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// db.put(input) is injected: the real one wraps the AWS SDK (bundled in the
// Lambda runtime), tests pass a fake. Keeps the repo dependency-free.
function makeHandler(db, { table, key, now = () => new Date().toISOString() }) {
  return async event => {
    const headers = event.headers || {};
    if (!keyOk(headers['x-event-key'], key)) return reply(401, { error: 'bad event key' });

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
      if (raw.length > 20000) return reply(413, { error: 'too large' });
      body = JSON.parse(raw);
    } catch { return reply(400, { error: 'not JSON' }); }

    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'checkins') return reply(400, { error: 'body must be {checkins:[...]}' });
    const list = body.checkins;
    if (!Array.isArray(list) || list.length < 1 || list.length > 25) return reply(400, { error: 'checkins: 1..25 items' });
    // All or nothing on validation: a malformed item is a client bug, and a
    // partial silent accept is how records go missing.
    for (let i = 0; i < list.length; i++) {
      const p = problem(list[i]);
      if (p) return reply(400, { error: `checkin ${i}: ${p}` });
    }

    const accepted = [];
    let failed = 0;
    const at = now();
    await Promise.all(list.map(async c => {
      try {
        // Write-once per scan. A resend after a WiFi drop hits the condition
        // and counts as accepted; it can never create a second item.
        await db.put({
          TableName: table,
          Item: {
            idempotency_key: { S: c.idempotency_key },
            propulse_id: { S: c.propulse_id },
            scanned_at: { S: c.scanned_at },
            device_id: { S: c.device_id },
            received_at: { S: at },
          },
          ConditionExpression: 'attribute_not_exists(idempotency_key)',
        });
        accepted.push(c.idempotency_key);
      } catch (e) {
        if (e && e.name === 'ConditionalCheckFailedException') accepted.push(c.idempotency_key);
        else failed++;
      }
    }));
    // Only confirmed keys come back. The phone keeps retrying the rest.
    console.log(JSON.stringify({ received: list.length, accepted: accepted.length, failed }));
    return reply(200, { accepted, failed });
  };
}

let cached;
exports.handler = event => {
  if (!cached) {
    const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
    const client = new DynamoDBClient({});
    cached = makeHandler({ put: input => client.send(new PutItemCommand(input)) }, { table: process.env.TABLE, key: process.env.EVENT_KEY });
  }
  return cached(event);
};
exports.makeHandler = makeHandler;
