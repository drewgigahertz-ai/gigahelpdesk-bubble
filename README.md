# GigaHelpDesk Bubble

## Expanded ticket panel (new)

Each notification card now has two buttons:

- **View ↗** — expands the SAME bubble panel in place (not a separate
  window) to show that ticket: live status, SLA/pending time, the full
  conversation, a reply box, and attachments — it's the real GigaHelpDesk
  ticket page, signed in automatically with your stored session, embedded
  inside the panel below a slim header with a **← Back** button. Clicking
  a different notification while a ticket is already open swaps that same
  panel to the new ticket instead of opening anything new. **← Back**
  returns to the notification list at the normal panel size.
- **🌐** — opens the same ticket in your default web browser instead, if
  you'd rather use that.

Clicking an attachment downloads it and then opens it in your OS's
default viewer automatically.


An always-on-top desktop notification bubble for GigaHelpDesk, built on the same
Electron "chat-head" bubble UI as the Cash Receipt bubble app — drag anywhere,
resize, click to expand into a panel, preview popups for new items, ringtone
alarm mode, custom sounds, theme colors, etc.

## What's different from the template you sent

The template polled a Google Apps Script Web App (URL + token). This version
talks to GigaHelpDesk directly, using the same login flow as your
`Code.gs` / `Index.html`:

- **Login lives in the app itself** — no more Web App URL / API token fields.
  Open the bubble and sign in with your GigaHelpDesk email + password.
  "Keep me signed in" mirrors the `remember` option in your `loginUser()` —
  it stores the email and an OS-encrypted password (via Electron's
  `safeStorage`, using Windows DPAPI / macOS Keychain / libsecret) so the app
  can silently re-login on a 401/419, exactly like `getNotifications()` does
  in Code.gs.
- **The login + polling logic itself was ported 1:1** from `Code.gs`:
  `doLogin()`, `extractCookiesFromResponse()`, `cookieMapToString()`,
  `captureRotatedCookie()`, and the 401/419 auto-relogin path are all in
  `main.js`, using Node's `fetch` (which, unlike a renderer's sandboxed
  `fetch`, can read `Set-Cookie` headers and follow the same
  GET-token → POST-login → cookie-capture dance UrlFetchApp did).
- **Notification shape** matches your `/admin/notifications/dropdown-data`
  response (`{ unread_count, items: [{ id, title, message, created_at,
  open_url, is_read }] }`) instead of the old `{alerts, upTo}` sheet-row
  format. The bubble badge shows `unread_count`; new *unread* items trigger
  the preview popup + ringtone, same as new sheet rows used to.
- **"Open" button** on each notification opens `open_url` in your default
  browser (via `shell.openExternal`, safely restricted to http/https).
- Removed things that were specific to the Cash Receipt sheet backend:
  deposit/payment/SI type coloring & mute toggles, the 5-minute alert
  countdown timer, and "Reset Last Row".
- **New icon** — `bubble-icon.png` / `icon.png` / `icon.ico` were regenerated
  from your uploaded HELPDESK logo (background removed so it sits cleanly in
  the round bubble).

## Run it

```bash
npm install
npm start
```

## Sharing this with other users

There are three ways to get this into other people's hands. Pick whichever
fits — you don't need to do all three.

### Option A — Build on an actual Windows PC (simplest)

If you or anyone on the team has a Windows machine:

```bash
npm install
npm run dist
```

The installer lands in `dist\GigaHelpDesk Bubble Setup 1.0.0.exe`. Send that
one file to anyone — they double-click it, click through the install
wizard, done. This is the cleanest result (proper Start Menu entry,
uninstaller, custom icon embedded in the .exe itself) and needs zero
workarounds because `electron-builder`'s Windows-installer step (NSIS +
icon embedding) is itself a Windows program.

**Note:** the very first time someone runs an installer that isn't
code-signed, Windows SmartScreen will show "Windows protected your PC" —
that's expected for an internal tool without a paid code-signing
certificate. Click "More info" → "Run anyway". This is a one-time click for
each user, not a bug.

### Option B — Let GitHub build it for you (no Windows PC needed)

This repo includes `.github/workflows/build.yml`, which builds the same
installer on a real Windows machine in the cloud, for free, via GitHub
Actions:

1. Push this project to a GitHub repo (public or private).
2. Go to the repo's **Actions** tab → "Build Windows Installer" → **Run workflow**.
3. Wait ~2–3 minutes, open the finished run, and download the
   `GigaHelpDesk-Bubble-Setup` artifact — that's your installer .exe, built
   on genuine Windows with no wine limitations.

It also runs automatically on every push to `main`, so future icon/UI
tweaks always have a ready-to-share installer waiting in Actions.

### Option C — Portable app, no installer at all

If you don't want an installer step in the mix, `electron-builder` can also
just produce the packaged app folder directly:

```bash
npm install
npx electron-builder --win dir
```

That creates `dist/win-unpacked/`, containing `GigaHelpDesk Bubble.exe`
plus all its resources. Zip that folder and send it to people — they unzip
it anywhere (no admin rights needed) and double-click the .exe to run it.
There's no Start Menu entry or uninstaller, but it's the fastest way to get
something in someone's hands, and it sidesteps NSIS entirely (useful if
you're building from Linux/macOS without a Windows box, since this step
doesn't need wine the way the NSIS installer step does).

## Build a Windows installer (quick reference)

```bash
npm install
npm run dist
```

## Notes / things worth double-checking

- Node's `fetch` (undici) needs `Response.headers.getSetCookie()` to read
  multiple `Set-Cookie` headers correctly; this ships with modern Node/Electron
  (Electron 31 bundles a Node version that has it), with a single-cookie
  fallback in `extractCookiesFromResponse()` just in case.
- Credentials are stored per-OS-user in
  `app.getPath('userData')/ghz-session.json` — the cookie always in plain
  text (it's just a session token), the password encrypted with
  `safeStorage` when available.
- If GigaHelpDesk ever changes its login page's CSRF field name or the
  notifications endpoint's JSON shape, update the same two spots you'd have
  updated in `Code.gs`: the `tokenMatch` regex and the `data.items` /
  `data.unread_count` checks in `bubble.html`'s `poll()`/`onData()`.
- SLA reminders inspect each ticket URL from the notification list and look
  for the ticket page's Created, Opened, or Submitted timestamp plus its First
  Response, Response Due, Resolution, Resolve By, or Due Date deadline. The
  warning triggers when 80% of that ticket-specific SLA interval has elapsed.
  For example, a 1-minute SLA warns at about 48 seconds. If the ticket page
  uses different labels or only renders SLA values through JavaScript after
  load, update `parseDateNearLabel()` / `extractTicketSla()` in `main.js`.

- SLA countdowns use continuous elapsed time when the ticket exposes a
  duration instead of a calculated due date. Warnings trigger at 80% elapsed,
  and alerts show warning or overdue state with a live countdown.
- Custom audio files are stored separately under the user's app data folder.
  Settings includes a sound library where files can be renamed or deleted;
  each filename is available independently in the notification sound menus.

## Automatic updates without a certificate

The app checks the GitHub Releases for
`drewgigahertz-ai/gigahelpdesk-bubble` automatically. A code-signing
certificate is not required, although Windows SmartScreen may still show a
warning for unsigned installers.

To publish an update:

1. Change the `version` in `package.json`, for example `1.0.0` to `1.0.1`.
2. Commit and push the change to `main`.
3. Create and push a matching version tag:

```powershell
git tag v1.0.1
git push origin v1.0.1
```

The GitHub Actions workflow builds the Windows installer and publishes a
GitHub Release containing the installer, `latest.yml`, and blockmap. Existing
installed users detect the new release, download it, and install it when the
app exits.

For a private repository, GitHub release access must be available to the
installed users; public Releases are recommended for this updater setup.
