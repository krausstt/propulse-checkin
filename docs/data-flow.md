# Where visitor data goes, and where it never goes

Goal: e-mail addresses and phone numbers **never leave the laptop**. Names and
companies exist only on the laptop, in ProGlove's M365 tenant, and on the five
managed phones (and, for one scan at a time, on the MAI screen). Never on
GitHub, never on the Pages site, never in an AI chat.

A phone cannot greet someone by name without holding that name. So "no names
anywhere" is impossible; the achievable goal is "names in exactly these places
and nowhere else", with each boundary enforced by code rather than by memory.

## The path

| # | Where | What is there | Enforced by |
|---|---|---|---|
| 1 | SharePoint sheet | all 21 columns: names, e-mail, phone, address… | M365 access control |
| 2 | Tobias's laptop, `data/registrants.csv` | same 21 columns | `.gitignore` (`*.csv`, `data/*`) |
| 3 | `build-roster.mjs --strict`, on the laptop, no network | **e-mail, phone, address, title dropped here** | the script only copies 5 named columns |
| 4 | `roster.json` on the laptop | id, full_name, host, badge_location, company, status | `.gitignore` (`roster.json`) |
| 5 | Company OneDrive / Teams | **the full CSV export** (since 2026-09-24), or `roster.json` | M365 tenant |
| 6 | Phone Downloads, until deleted | **the full CSV export**, e-mail and phone included | SureMDM device control; the app tells the user to delete it right after import |
| 6b | Phone: *Import registrant CSV*, in memory | reduced to the 5 fields by `csv-roster.js` | no cell value is ever logged or shown in an error; only `ALLOWED_FIELDS` are stored |
| 7 | Phone IndexedDB | the 5 fields | origin-scoped browser storage, no sync |
| 8 | `display_v2!` → `ws://localhost:9998` → INSIGHT Mobile → BLE → MAI | one visitor's name, company, host, badge location | loopback only; **see open question A** |
| 9 | Check-in record, phone IndexedDB | `idempotency_key, propulse_id, device_id, scanned_at, matched`, **no name** | `createCheckin` in `outbox.js` |
| 10 | *Export attendance* CSV, per phone | the same five name-free columns | safe to send anywhere |
| 10b | AWS DynamoDB `propulse-checkins`, eu-central-1 | `idempotency_key, propulse_id, scanned_at, device_id, received_at` | `wireCheckin` on the phone sends only these; `aws/lambda.cjs` rejects any request with another field; IAM role can only PutItem |
| 11 | `attended.csv` on the laptop | names + attendance | built by `merge-attendance.mjs`; `*.csv` is git-ignored; keep in the tenant |

## What is public, and what guards it

| Public thing | Must contain | Guard |
|---|---|---|
| GitHub repo, all history | code + pseudonymised sample only | `.gitignore` by name; `tools/check-public.mjs` by content |
| Pages site (`web/`) | code + `demo-roster.sample.json` built from the sample | CI runs `check-public.mjs` and unit tests before deploy; deploy is blocked on failure |

`check-public.mjs` fails on: any spreadsheet other than the sample, any e-mail
outside `example.*` / the two commit identities, phone-shaped strings in the
sample or demo roster, any roster other than the demo, any forbidden roster
field, and a denylist of strings known to be real.

## Checklist, every time the real roster is built

1. Export from SharePoint as **CSV UTF-8** into `data/` on the laptop.
2. `node tools/build-roster.mjs data/registrants.csv --out roster.json --strict`
3. Upload the CSV (or, stricter, `roster.json`) to the event folder in OneDrive.
4. On each phone: download, *Import registrant CSV*, then **delete the file
   from Downloads**. It holds every registrant's e-mail and phone number.
5. Delete the CSV from the laptop when the event is over.

## Never

- Commit or push anything from `data/` except `data/sample/`.
- Paste a real `display_v2!` payload, a *Copy log* output from an event
  phone, or any roster content into Claude, a ticket or a chat. Anything pasted
  into an AI tool leaves the company. Anonymise it first, **including the
  name**. (The app redacts displayed text from logged error frames, but do
  not rely on that.)
- Put the real roster on the Pages site "just for testing". The site is public.

## After the event

- SureMDM: clear Chrome site data for the app origin on all five phones, or
  wipe the devices. IndexedDB persists until then, so a lost phone before the
  wipe exposes about 1000 names and companies (no e-mail, no phone).
- Delete `roster.json` from OneDrive and the laptop.

## Open questions

- **A. INSIGHT Mobile.** Does it forward Streams API traffic, or logs
  containing it, to any ProGlove cloud (INSIGHT web portal, telemetry)? If yes,
  names leave the phone through our own product. Ask the INSIGHT Mobile team.
- **B. Android backup.** Whether Chrome's IndexedDB is included in Google
  device backup is unverified. SureMDM can disable backup by policy; do that.
- **C. Attendance.** Built: *Export attendance* per phone, merged by
  `tools/merge-attendance.mjs`. Complete only if every phone is exported;
  storage persistence was reported `false` on the test phone, so Chrome may
  evict IndexedDB under storage pressure. Export at least every break.
- **D. Git history.** Before 2026-09-23 the sample carried the original
  pseudonym and a real-looking company name. They remain in public history
  unless history is rewritten.
