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
| MAI command builder | ✅ built, 8/8 tests green against a captured payload |
| On-device LNA diagnostic | ✅ built — **not yet run on hardware** |
| PWA + WebSocket manager | ⬜ blocked on the diagnostic |
| AWS SAM backend | ⬜ not started |

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

The registrant export contains real customer names, e-mail addresses and phone
numbers. It never enters this repo.

- Export the sheet to **CSV UTF-8** yourself and keep it in `data/` (git-ignored)
- `tools/build-roster.mjs` reduces 21 columns to the four the MAI needs and drops
  the rest — e-mail and phone never leave the laptop
- `roster.json` is a deploy artefact, never a commit

Verify the firewall after any `.gitignore` change:

```bash
git check-ignore -v data/whatever.csv roster.json .env
```
