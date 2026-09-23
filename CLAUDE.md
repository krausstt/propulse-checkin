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

### 3. Only the fields the template displays ever leave the laptop

Currently FIVE: `propulse_id`, `full_name`, `host`, `badge_location`, `company`.
E-mail, phone, address and title are read by the roster builder and dropped.

This was four until the `pg_work5_t3` capture arrived (2026-09-22). That
template has a fifth cell showing the visitor's employer, so `company` now has
to travel from the sheet to the phone. The rule is unchanged in spirit: a field
crosses the line only when a template cell demands it, never because it is
convenient. If the booth returns to `pg_work4_t4`, drop `company` again.

Still absolutely not: e-mail, phone, address, title.

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

### Partially answered since (2026-09-22, low-grade evidence)

A Google-owned repo states WebSocket connections to a local address "start
triggering permission **prompts**", which suggests prompt rather than hard-fail.
But `developer.chrome.com`, `chromestatus.com`, `wicg.github.io` and
`chromeenterprise.google` are ALL blocked by the cloud session's egress proxy,
so no primary source could be read and nothing Android-specific was found.
Treat as a lead. Also unverified: the WICG spec seems to split the permission
name by address space (`loopback-network` for 127.0.0.1, `local-network` for
private ranges), and a separate `LoopbackNetworkAccessAllowedForUrls` policy may
exist alongside `LocalNetworkAccessAllowedForUrls`. `LocalNetworkAccess
RestrictionsTemporaryOptOut` is removed in Chrome 156, so it is not a plan.

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

**Open question for the ProGlove team:** does INSIGHT Mobile forward Streams
API traffic, or logs containing it, to any ProGlove cloud (INSIGHT web portal,
telemetry)? Every `display_v2!` carries a visitor's name and company. If
INSIGHT Mobile uploads it, names leave the phone through our own product.

**Open question for the ProGlove team:** does INSIGHT Mobile support **MQTT**?
If it does, the loopback problem disappears entirely — phone ↔ AWS IoT Core ↔
web app over WSS, no LNA at all. Costs offline capability, so it is the fallback,
not the default. This is the contingency if test 1 comes back "hard fail".

---

## Architecture (decided)

| Layer | Choice |
|---|---|
| App | Buildless PWA, plain ES modules, no bundler, no framework |
| Hosting | GitHub Pages, **code only**. Custom ProGlove subdomain before the phones are provisioned (the LNA grant is per origin; `*.github.io` grants are void after a move) |
| Backend | **None.** AWS (Lambda + DynamoDB) was dropped on 2026-09-23 |
| Roster | Built on the laptop by `build-roster.mjs`, carried to each phone **by hand** via company OneDrive/Teams, loaded with *Load roster file*, held in IndexedDB |
| Check-ins | Append-only on the phone, client-generated UUID idempotency key. They carry **no name**: `{idempotency_key, propulse_id, device_id, scanned_at, matched}`. Held on device; the sync path is dormant unless `?api=` is set |

**This repo and its Pages site are public.** Nothing with a real name may be
committed or published, ever. Two gates enforce it and neither may be relaxed:

1. `.gitignore` stops real files **by name** (every CSV/XLSX, `roster.json`).
2. `tools/check-public.mjs` checks **content** of every tracked file (e-mail
   domains, phone-shaped strings, a denylist of known real strings, stray
   rosters, forbidden roster fields). CI runs it before every deploy. Run it
   yourself before every push: `npm run check-public`.

The raw SharePoint export never leaves the laptop. What travels to the phones
is the **reduced** `roster.json`, never the CSV: the phone app refuses `.csv`
files and refuses any roster whose records carry a key outside
`ALLOWED_FIELDS` in `web/src/roster.js`.

The sample data is **pseudonymised, not merely synthetic**: row 1 was derived
from a real record. Its name and company were replaced on 2026-09-23. The
original strings survive in git history before that date (see the denylist in
`check-public.mjs`). Never "restore realism" to the sample from a real export.

See `docs/data-flow.md` for the full path and every place a name exists.

---

## Ground truth

`web/src/mai.test.js` holds TWO captured `display_v2!` payloads from the
customer's own INSIGHT Mobile install, each asserted by deep-equal. **Those
captures are the spec.** If a change breaks either test, the change is wrong.

- Template `pg_work4_t4`: `field_top_left` (ID), `field_top_right` (Host),
  `field_middle_left` (Badge Location), `field_bottom` (Full Name, highlighted),
  plus `title`. No `field_middle_right`. Carries `forced_orientation`.
- Template `pg_work5_t3`: `field_top_left` (ID), `field_top_right` (Badge
  Location), `field_middle_left` (Host), `field_middle_right` (**Company**,
  highlighted), `field_bottom` (Full Name, not highlighted), plus `title`.
  Carries **no** `forced_orientation` key at all.

These two are not old and new. They are two templates that both exist, they
order their cells differently, and they put the highlight on different cells.
`pg_work5_t3` is the app default. Do not collapse them or normalise one to the
other without a capture that proves they are the same thing.
- Badge QR content is a bare integer, e.g. `1`. Confirmed by Tobias. Marketing
  print it; it is not changeable.
- `forced_orientation: "LANDSCAPE"` is correct for `pg_work4_t4` and is absent
  from the `pg_work5_t3` capture. Do not add it there "for consistency": a key
  the device has never been observed to receive is how a working template turns
  into an unexplained rejection at the booth.
- INSIGHT Mobile's command queue is only **5 deep** — debounce display sends.

---

## Commands

```bash
npm test                                             # node:test, no deps
npm run e2e                                          # real Chromium vs. the mock server
npm run mock                                         # stand-in for INSIGHT Mobile
npm run serve                                        # static server for web/ (plain HTTP)
npm run demo-roster                                  # rebuild the synthetic bundled roster
npm run check-public                                 # content gate: run before every push
node tools/build-roster.mjs <in.csv> --out roster.json --strict
node tools/build-roster.mjs data/sample/registrants.sample.csv --sample
```

Zero runtime dependencies, by choice — this code path touches customer PII and
should not pull an npm tree nobody has audited. Keep it that way.

## Environment notes

Developed on Windows (PowerShell). A cloud session is Linux — adjust shell
syntax, but nothing in the code is platform-specific. AWS CLI and SAM are
**not** installed anywhere yet.
