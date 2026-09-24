# Provisioning the five SureMDM phones

The scanner link depends on a Chrome permission that is granted **per origin**
and that Chrome will **block permanently after three prompt dismissals**, with
no way back from inside the app. So provisioning is not "install the PWA", it is
"make sure nobody at the booth ever meets that prompt cold".

## Do this in order

1. **Pin the origin first.** The ProGlove subdomain has to exist and be live on
   GitHub Pages *before* any phone is provisioned. Every grant made on
   `*.github.io` is void the moment the app moves. This is a DNS request to
   whoever runs ProGlove DNS, so start it early: it is the longest-lead-time
   item in the whole project, longer than anything in the code.
2. **Run `web/lna-test.html` on one phone** against that origin, with INSIGHT
   Mobile running. Work down the buttons. This answers whether Android prompts
   or hard-fails, which permission name is live, and whether the grant survives
   a Chrome force-stop. Nothing below is worth doing until it has run.
3. **Try the managed pre-grant.** SureMDM can push Chrome managed configuration
   to Android Enterprise devices. The relevant Chrome policy is
   `LocalNetworkAccessAllowedForUrls`, set to the exact production origin.
   - Unverified, flagged so nobody wastes an afternoon: a separate
     `LoopbackNetworkAccessAllowedForUrls` policy **may** exist, since our
     target is loopback rather than a private-range address. Try the
     `LocalNetworkAccess*` name first and check `chrome://policy` on the device
     to see what actually applied.
   - `LocalNetworkAccessRestrictionsTemporaryOptOut` is removed in Chrome 156.
     Do not build on it.
4. **If the pre-grant works**, the phones never see a prompt. Verify on one
   device by opening the app and tapping Connect: it should go straight to
   "Scanner connected".
5. **If it does not**, one technician taps Connect once per phone and taps
   **Allow**. Then force-stop Chrome and tap Connect again to confirm the grant
   survived. Booth staff get the phones only after this.

## INSIGHT Mobile, per phone (once)

Source: an AI-written summary of the ProGlove docs (2026-09-24), not the docs
themselves. Confirm against the INSIGHT Webportal when doing it.

1. Grant INSIGHT Mobile Android's **Display over other apps** permission
   (Android 10+), or it cannot show its connection barcodes.
2. In the **INSIGHT Webportal → Configurations**, create an **Android**
   configuration with integration path **Websocket**, port **9998**.
3. **Scan that configuration's QR code with the MAI.**
4. Connect the MAI to INSIGHT Mobile through INSIGHT Mobile's own flow, not
   Android Bluetooth settings. INSIGHT Mobile must list the MAI as connected,
   with a serial. If the web app shows `ERROR_DEVICE_NOT_FOUND` and "NO scanner
   connected", this step is what is missing.

## Per phone, on the day

- INSIGHT Mobile running, WebSocket integration enabled, port **9998**
- Scanner paired, MAI paired
- App open, **Connect scanner** tapped, status green
- Load the real roster once via **Load roster file** (it is not on the server;
  Pages is public). It persists in that phone's IndexedDB
- Scan one known badge and confirm the name appears on the MAI

## At the end of each day

Open the app on each phone and read the **Unsynced** count. With no backend
configured that number is the attendance data living on that phone and nowhere
else. Do not wipe a device before it reads zero, or before the check-ins have
been exported another way.

## What is deliberately not automated

Nothing here installs an APK or sideloads anything. It is a PWA in Chrome, so
SureMDM only needs to push the Chrome policy and, optionally, a web shortcut to
the production origin.
