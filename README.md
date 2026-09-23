# ProPulse 2026 Chicago — visitor check-in

Greets trade-fair visitors by name on a ProGlove **MAI** wearable display when
their badge is scanned. Runs as a PWA in Chrome on Android — no APK.

```
badge QR ("1")  →  ProGlove scanner  →  INSIGHT Mobile  →  ws://localhost:9998
                                                                    ↓
   MAI display  ←  BLE  ←  INSIGHT Mobile  ←  display_v2!  ←  this web app
                                                                    ↑
                                              roster lookup (IndexedDB cache)
```

## Status

| | |
|---|---|
| Roster pipeline | ✅ built, tested |
| MAI command builder | ✅ both captured templates reproduced exactly |
| Roster cache + check-in outbox | ✅ built, tested |
| WebSocket manager | ✅ built, tested (safe under every LNA outcome) |
| PWA shell | ✅ installable, offline-capable shell |
| Mock INSIGHT Mobile server | ✅ `npm run mock` |
| End-to-end test in real Chromium | ✅ `npm run e2e` |
| On-device LNA diagnostic | ✅ built — **not yet run on hardware** |
| Backend | none by decision (AWS dropped): roster by hand, check-ins stay on the device |

77 unit tests + 25 end-to-end checks green, plus `npm run check-public`.

## Try it in two minutes, no phone, no scanner

```bash
npm run e2e          # drives the whole scan path in real Chromium
```

Or watch it by hand, in two terminals:

```bash
npm run mock         # stands in for INSIGHT Mobile on ws://localhost:9998
npm run serve        # serves web/ on http://localhost:8080
```

Open the page, tap **Connect scanner**, then type a badge ID (`1`…`5`) into the
mock's terminal and press enter. The greeting appears, and the mock prints the
`display_v2!` command it received, cell by cell. Type `junk` for a non-badge
barcode and `bad` for a malformed frame.

## Try it on your Android

Plain HTTP over the LAN (`npm run serve`) is fine for looking at the UI, but it
is **not** a valid test of the scanner link: `ws://localhost` from an `http://`
page is a different security situation from the `https://` origin the phones
will really run on. For the socket, deploy to HTTPS:

1. Settings → Pages → Source: **GitHub Actions**. Push, and the workflow in
   `.github/workflows/pages.yml` publishes `web/`.
2. Open the Pages URL on the phone, with INSIGHT Mobile running and its
   WebSocket integration on port 9998.
3. Tap **Connect scanner**. If Chrome prompts for local network access, tap
   **Allow**.
4. Scan a badge.

> ⚠️ The Local Network Access grant is **per origin**, and Chrome blocks an
> origin permanently after three prompt dismissals. Testing on the
> `*.github.io` origin is fine for getting an answer, but every grant made
> there is void the moment the app moves to the ProGlove subdomain. Provision
> the five managed phones **only** against the final origin.

## What "checked in" means right now

There is no backend (AWS was dropped by decision), and the app does not pretend otherwise. A scan writes
an immutable check-in to IndexedDB with a client-generated idempotency key, and
the counter shows **Recorded / Synced / Unsynced**. With no server configured
the button reads *"No server configured — held on device"*, and Unsynced stays
at the full count. That is the honest state.

The sync path is kept dormant rather than deleted. Check-ins carry no name, so
if a backend is ever added, it only ever sees badge IDs and timestamps: open the app once with `?api=https://your-endpoint` (it is remembered),
and it POSTs batches to `POST {api}/checkins`, expecting `{"accepted": [...]}`
of idempotency keys back.

## Quickstart

```bash
npm test
```

```bash
node tools/build-roster.mjs data/sample/registrants.sample.csv --sample
```

## The blocking question

Chrome 147 (April 2026) put **Local Network Access** in front of WebSocket
connections to loopback, on Android as well as desktop. Whether that gate
prompts or hard-fails on Android is not answerable from documentation, and it
decides the architecture.

`web/lna-test.html` settles it in about ten minutes. Push it to any HTTPS origin,
open it on a real event phone with INSIGHT Mobile running, and work down the
buttons.

> ⚠️ Chrome permanently blocks an origin after **three dismissals** of the
> permission prompt, with no in-app way back. Always tap **Allow**.

See [CLAUDE.md](CLAUDE.md) for the full constraint set and the open questions.

## Handling registrant data

**This repository and its Pages site are public.** Read `docs/data-flow.md`
before touching anything that involves visitor data, and run
`npm run check-public` before every push.

The registrant export contains real customer names, e-mail addresses and phone
numbers. It never enters this repo.

- Export the sheet to **CSV UTF-8** yourself and keep it in `data/` (git-ignored)
- `tools/build-roster.mjs` reduces 21 columns to the five the MAI needs
  (`id`, `full_name`, `host`, `badge_location`, `company`) and drops the rest —
  e-mail, phone, address and title never leave the laptop
- **`company` was added on 2026-09-22** because the `pg_work5_t3` template has a
  fifth cell showing the visitor's employer. It is a deliberate widening of the
  firewall, not an accident. If the booth returns to `pg_work4_t4`, take it out
- The bundled `web/demo-roster.sample.json` is built from the synthetic sample
  and nothing else. **GitHub Pages is public even from a private repo**, so the
  real roster is never committed — load it on the phone with *Load roster file*,
  and it stays in that device's IndexedDB
- `roster.json` is a deploy artefact, never a commit

Verify the firewall after any `.gitignore` change:

```bash
git check-ignore -v data/whatever.csv roster.json .env
```
