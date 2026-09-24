# Central check-in database on AWS, step by step

For someone who has never used AWS. About 20 minutes. No software to install:
everything happens in the browser, in the AWS console and in **CloudShell**
(a terminal built into the console, bottom-left of the console home page).

## What you are building

```
phone ──HTTPS──▶ API Gateway ──▶ Lambda ──▶ DynamoDB table "propulse-checkins"
        (throttled, only         (rejects      (one row per scan:
         krausstt.github.io)      anything     badge ID, device ID,
                                  but 4 IDs)   two timestamps)
```

Each row contains `propulse_id`, `device_id`, `scanned_at`, `received_at` and
`idempotency_key`. That is all: **no name, company, e-mail or phone ever
arrives**. The Lambda refuses any request carrying a fifth field, and the phone
never sends one. Badge IDs are still pseudonymous personal data under GDPR,
because the Excel sheet maps them back to people. The table is in Frankfurt
(`eu-central-1`) and encrypted at rest. Whether a private AWS account may hold
it is a question for ProGlove's DPO/IT; everything here can be redeployed into
a company account unchanged.

Cost for the event: cents. DynamoDB and API Gateway bill per request (about
1000 requests), and Lambda stays inside its free allowance.

**Free-plan catch:** the free plan ends when the credits run out or on the
date shown on the console home page (22 Mar 2027 for this account). Export the
data (step 7) before then, or upgrade the plan.

---

## 0. Two minutes of safety first

1. Top right → your account name → **Security credentials** → **Assign MFA**
   for the root user (use an authenticator app). An AWS account without MFA
   is the most common way these accounts get hijacked.
2. Top right, next to your account name: set the region to
   **Europe (Frankfurt) eu-central-1**. Every step below assumes it.
   (If CloudFormation later shows a different region, switch it back here.)

## 1. Make the event key

The phones send this key with every request, so random internet traffic
cannot fill the table.

1. Click **CloudShell** (bottom-left). Wait until the prompt appears.
2. Paste and press Enter:
   ```bash
   openssl rand -hex 16
   ```
3. Copy the 32-character result into a note that only you can see (for
   example a Teams chat with yourself). This is the **event key**.
   Never put it in the repo, a public channel or a screenshot.

## 2. Get the template

Download this file to your PC (right-click → Save link as):
`https://raw.githubusercontent.com/krausstt/propulse-checkin/main/aws/template.yaml`

It describes the table, the function, the API and their permissions in one
file. AWS builds all of it for you from that file.

## 3. Create the stack

1. In the console search bar type **CloudFormation**, open it.
2. **Create stack** → **With new resources (standard)**.
3. **Choose an existing template** → **Upload a template file** → choose
   `template.yaml` → **Next**.
4. **Stack name:** `propulse-checkins`
   **EventKey:** paste the key from step 1
   **AllowedOrigin:** leave `https://krausstt.github.io`
   → **Next**.
5. The options page: change nothing → **Next**.
6. The review page: scroll to the bottom, tick
   **"I acknowledge that AWS CloudFormation might create IAM resources"**
   → **Submit**.
7. Wait about 1-2 minutes until the status is **CREATE_COMPLETE** (refresh
   with the circular arrow).
   - If it says **ROLLBACK_COMPLETE** instead: open the **Events** tab, find
     the first red line, and send me its text. Then delete the stack and
     repeat step 3.
8. Open the **Outputs** tab and copy **ApiUrl**
   (looks like `https://abc123xyz.execute-api.eu-central-1.amazonaws.com`).

## 4. Test it from CloudShell

Replace the two placeholders, then paste:

```bash
API='https://abc123xyz.execute-api.eu-central-1.amazonaws.com'
KEY='your-event-key'

# A valid test scan. Expect: {"accepted":["00000000-0000-4000-8000-000000000000"],"failed":0}
curl -s -X POST "$API/checkins" -H 'content-type: application/json' -H "x-event-key: $KEY" \
  -d '{"checkins":[{"idempotency_key":"00000000-0000-4000-8000-000000000000","propulse_id":"9999999","scanned_at":"2026-01-01T00:00:00.000Z","device_id":"dev-00000000"}]}'; echo

# The firewall: a name in the request. Expect: {"error":"checkin 0: must have exactly ..."}
curl -s -X POST "$API/checkins" -H 'content-type: application/json' -H "x-event-key: $KEY" \
  -d '{"checkins":[{"idempotency_key":"00000000-0000-4000-8000-000000000001","propulse_id":"1","scanned_at":"2026-01-01T00:00:00.000Z","device_id":"dev-00000000","full_name":"Test Person"}]}'; echo

# A wrong key. Expect: {"error":"bad event key"}
curl -s -X POST "$API/checkins" -H 'content-type: application/json' -H 'x-event-key: wrong' -d '{}'; echo
```

Then remove the test row: search **DynamoDB** → **Tables** →
`propulse-checkins` → **Explore table items** → tick the row with
`propulse_id` 9999999 → **Actions** → **Delete items**.

## 5. Connect each phone (once per phone)

Build this link with your two values:

```
https://krausstt.github.io/propulse-checkin/?api=<ApiUrl>&key=<event key>
```

Send it to yourself (not to a public channel), open it **on the phone in
Chrome**, once. The phone remembers both values and removes them from the
address bar. In **Diagnostics** you should see `api https://…` and
`eventkey set (32 chars)`.

## 6. Check that scans arrive

1. Scan a badge on the phone. Within ~15 s the button under "Check-ins on this
   device" shows **All synced to server ✓**.
2. In DynamoDB → `propulse-checkins` → **Explore table items**, the scan is
   there: badge ID, device, times. Nothing else.

When the WiFi drops, scans queue on the phone and go out on their own once it
is back. The **Unsynced** counter shows how many are still waiting.

## 7. Export the attendance list

In CloudShell (make sure the region is still Frankfurt):

```bash
aws dynamodb scan --table-name propulse-checkins --region eu-central-1 --output json \
 | jq -r '["propulse_id","scanned_at","device_id","matched","idempotency_key"],
          (.Items[] | [.propulse_id.S, .scanned_at.S, .device_id.S, "", .idempotency_key.S]) | @csv' \
 > attendance-aws.csv && wc -l attendance-aws.csv
```

**Actions** (top right of CloudShell) → **Download file** →
`attendance-aws.csv`. On the laptop, with the registrant export:

```bash
npm run attendance -- "EXCELNAME (1).csv" attendance-aws.csv
```

For a belt-and-braces list, also export each phone (*Export attendance*) and
add those files to the same command. Every scan has a unique key, so a scan
present in both AWS and a phone export is counted once.

## 8. Recommended: a budget alarm

Search **Billing** → **Budgets** → **Create budget** → **Use a template** →
**Monthly cost budget**, amount `5` USD, your e-mail → **Create**. You get an
e-mail long before the credits could be touched.

## After the event

1. Export (step 7) and keep `attended.csv` in the ProGlove tenant.
2. To remove everything: the table is deletion-protected on purpose. DynamoDB →
   `propulse-checkins` → **Additional settings** → turn off **Deletion
   protection** → delete the table. Then CloudFormation → delete the stack.

## What happens in the edge cases

| Situation | Result |
|---|---|
| Two scanners scan different badges at the same moment | Two independent rows with different keys. Nothing to conflict. |
| WiFi drops mid-send, phone resends | The row is written "only if it does not exist yet", so the resend is confirmed and no duplicate is created. |
| The server confirms only part of a batch | Only confirmed scans are marked synced. The rest keep retrying. |
| Venue WiFi is down all day | Scans stay on the phone (and in its export), and sync when WiFi returns. |
| Someone sends a name or any extra field | Whole request refused (HTTP 400), nothing stored. |
| Random internet traffic | No key → HTTP 401. Throttled to 10 requests/s anyway. |
| Stack deleted by mistake | Table stays (Retain + deletion protection); point-in-time recovery covers the last 35 days. |
