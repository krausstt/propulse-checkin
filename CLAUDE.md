# ProPulse 2026 Chicago — visitor check-in

Web app on Android phones that greets trade-fair visitors by name on a ProGlove
MAI wearable display. No APK: it is a PWA in Chrome.

**Scan path:** badge QR (a bare integer ID) → ProGlove scanner → INSIGHT Mobile →
WebSocket → this web app → look up the visitor → build a `display_v2!` command →
same WebSocket → INSIGHT Mobile → BLE → MAI screen.

---

## Rules that are not negotiable

### 1. Never handle the real registrant data

The source is an Excel sheet on ProGlove SharePoint with ~1000 real customers:
names, e-mail addresses, phone numbers. **Do not connect to SharePoint. Do not
ask for the real export. Do not read anything under `data/` except
`data/sample/`.** Tobias exports it himself and runs `build-roster.mjs` locally.

Develop against `data/sample/registrants.sample.csv` — synthetic, same schema.

If you are running as a **cloud session**, the real CSV does not exist in your
environment and must never be uploaded into it. That is by design, not an
obstacle to work around.

### 2. The PII firewall in `.gitignore` is load-bearing

All `*.csv`/`*.xlsx` and `roster.json` are ignored; only the one sample filename
is re-included. Uses `data/*` not `data/` deliberately — git cannot re-include a
file whose parent directory is excluded. **Verify with `git check-ignore -v`
after touching it.** A name in git history is permanent.

### 3. Only four fields ever leave the laptop

`propulse_id`, `full_name`, `host`, `badge_location`. E-mail, phone, address,
company and title are read by the roster builder and dropped. The MAI template
has exactly four cells, so nothing else is needed. Do not "helpfully" add fields.

---

## The constraint that drives the architecture

**Chrome's Local Network Access gates `ws://localhost:9998`.** Chrome 147
(April 2026) extended LNA to WebSockets on desktop *and* Android.

- **Mixed content is NOT the problem.** `ws://localhost` is potentially
  trustworthy — Secure Contexts decides loopback on the *host*, in steps with no
  scheme precondition. Confirmed against the spec and Blink source. Do not
  re-litigate this.
- **LNA keys on address space, not on who served the page.** A page served from
  a laptop on the venue LAN still hits the gate, because the phone still reaches
  its own loopback. This is why the laptop-server option was killed.
- **Use the literal host** `ws://localhost:9998` or `ws://127.0.0.1:9998`. Mixed
  content evaluates loopback syntactically, before DNS, and WebSocket has no
  `targetAddressSpace` escape hatch. A vanity hostname resolving to loopback is
  hard-blocked with no repair.
- **The socket must live in the foreground document, never a service worker.**
  Local network requests from a service worker fail by specification.
- **Three prompt dismissals permanently block the origin**, with no in-app
  recovery. One technician provisions each phone; booth staff must never meet
  that prompt cold.
- Last year's Lovable app is **void as evidence** — it predates Chrome 147.

### Unresolved, and gating

`web/lna-test.html` exists to settle these on real hardware. Until it is run,
treat the answers as unknown and do not design around a guess:

1. Does the gate **prompt** on Android, or hard-fail with `-385`?
2. Which permission name is live: `loopback-network`, `local-network`, or
   `local-network-access`?
3. Does a grant survive a Chrome force-stop, or is it per-session?
4. Does an installed PWA share a tab's grant?
5. Does the `scan` event really carry `device_serial` **and** `gateway_serial`?
   (If yes, nothing is hardcoded per phone — that is the intended design.)

**Open question for the ProGlove team:** does INSIGHT Mobile support **MQTT**?
If it does, the loopback problem disappears entirely — phone ↔ AWS IoT Core ↔
web app over WSS, no LNA at all. Costs offline capability, so it is the fallback,
not the default. This is the contingency if test 1 comes back "hard fail".

---

## Architecture (decided)

| Layer | Choice |
|---|---|
| App | Buildless PWA — plain ES modules, no bundler, no framework |
| Hosting | GitHub Pages on a ProGlove **custom subdomain** (pins one origin for permission policy; `*.github.io` is shared and would over-grant) |
| Backend | AWS SAM → 1× Lambda Function URL + 1× DynamoDB table, `eu-central-1` |
| Roster | Served by the Lambda behind an event key, cached in IndexedDB |
| Check-ins | Append-only, client-generated UUID idempotency key, local outbox flushed on reconnect |

**A GitHub Pages site is public even from a private repo** (private sites need
Enterprise Cloud). So Pages carries **code only** — never the roster.

"Single source of truth" means DynamoDB is the only *writer of record*. The
IndexedDB roster cache is a versioned read replica, not a per-device export.
Venue WiFi must never be a hard dependency of the greeting.

---

## Ground truth

`web/src/mai.test.js` holds a captured `display_v2!` payload from the customer's
own INSIGHT Mobile install, asserted by deep-equal. **That capture is the spec.**
If a change breaks that test, the change is wrong.

- Template `pg_work4_t4`: `field_top_left`, `field_top_right`,
  `field_middle_left`, `field_bottom`, plus optional `title`. There is **no**
  `field_middle_right`.
- Badge QR content is a bare integer, e.g. `1`. Confirmed by Tobias. Marketing
  print it; it is not changeable.
- `forced_orientation: "LANDSCAPE"` is correct for this template.
- INSIGHT Mobile's command queue is only **5 deep** — debounce display sends.

---

## Commands

```bash
npm test                                             # node:test, no deps
node tools/build-roster.mjs <in.csv> --out roster.json --strict
node tools/build-roster.mjs data/sample/registrants.sample.csv --sample
```

Zero runtime dependencies, by choice — this code path touches customer PII and
should not pull an npm tree nobody has audited. Keep it that way.

## Environment notes

Developed on Windows (PowerShell). A cloud session is Linux — adjust shell
syntax, but nothing in the code is platform-specific. AWS CLI and SAM are
**not** installed anywhere yet.
