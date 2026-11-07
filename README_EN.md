# 🗂️ HubMate — My Service Hub

[中文](./README.md) | English

[![GitHub stars](https://img.shields.io/github/stars/jasonssuns-prog/hubmate)](https://github.com/jasonssuns-prog/hubmate/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org/)

**Keep track of everything you signed up for** — check-in sites, proxies, VPS, games, subscriptions — check in daily and watch expirations, **all on one page**.

Pure Node.js with **zero dependencies** (no `npm install`), data lives in a single local `data.json`, one command to deploy.

🌐 **Live demo**: [web.jasonsun.us](https://web.jasonsun.us) — the author's own hub. The public landing page (site list and check-ins) is visible without logging in; personal data behind the login (accounts, notes, notification settings) stays private.

> ⭐ If this project is useful to you, please give it a Star. To support continued development, see [Sponsor](#️-sponsor) at the bottom.

## 💡 Why HubMate

- **Zero dependencies**: pure Node.js, no `npm install`, no third-party packages — nothing in the supply chain to break, one command to deploy
- **Your data stays yours**: everything lives in a single `data.json` on your own server, never uploaded to any cloud; backups, restores, and exports are all under your control
- **Free**: MIT open source, host it yourself for free — runs fine on free-tier servers (Oracle Always Free, instabox free tier)
- **Lightweight**: single-file data, tiny resource footprint — a 1-core box is enough
- **All in one place**: check-ins, expiry reminders, notepad, Telegram notifications, multi-account, multi-server sync, GitHub auto-backup, auto sign-in, health scores, 2FA, calendar subscription… one page manages it all, no pile of apps
- **Self-hosted**: no third-party service required (except optional Telegram / GitHub); works on your LAN too
- **Mobile friendly**: add to home screen and use it like an app, with a mobile-optimized layout

## ✨ Features

### Service management
- **CRUD**: name, category, URL, price, notes; a service can hold multiple accounts (main/alt)
- **Accounts manager**: the "👤 Accounts" button on a card opens a dedicated accounts dialog (separate from the service edit page) — view accounts, copy credentials, sign in, set the default, add, edit, and delete accounts. The service edit page has no account fields, so managing accounts can't accidentally change service info
- **Password generator**: in the accounts dialog, hit "🎲 Generate" to create a random strong password (12/16/20/24 chars, upper + lower + digit + symbol, ambiguous characters excluded) and fill it into the password field
- **Duplicate service**: a "Duplicate" button on the card copies a service (name gets " 副本"); check-in records and renewal history are not copied, accounts are
- **Bulk edit**: in bulk mode, besides moving and deleting, you can change the check-in interval and renewal cycle for several selected services at once (blank fields are left unchanged)
- **Manageable categories**: custom categories (rename, change icon); only empty custom categories can be deleted
- **Favorites**: star services, a "★ My Favorites" section on the home page; the "Favorites" category groups in too
- **Password reuse warning**: if the same password is used on multiple accounts, it is flagged (grouped by password, tap the eye to reveal it) so you can change them to different ones
- **Bulk mode**: select multiple services, move them to another category or delete them at once
- **Reorder**: move cards up / down, your order stays
- **Duplicate cleanup**: finds services with the same name or domain, clean them up in one place
- **Dead-link checks**: every 6 hours it HEAD-checks your URLs and flags ones that look dead ⚠️; every probe is recorded, and cards show each site's uptime over the last 7 / 30 days
- **Search**: search by name / account / URL / notes when logged in; the public home page is searchable too

### Check-ins & XP
- **Daily check-in**: +5⚡ per check-in, only the first one of the day counts (anti-farming)
- **Per-account check-in**: a service with several accounts only counts as done when ALL of its accounts are signed today; each account has its own sign-in button in the accounts dialog, and the check-in panel signs all unsigned accounts of a service in one tap; progress is shown per account as a percentage (e.g. 2/3 · 67%), and the ring and all-done bonus count accounts, not services
- **Check-in interval**: check in every N days (1 = daily); services that aren't due are never nagged
- **All-done bonus**: +10⚡ when everything due today is signed
- **Undo check-in**: misclicked? Hit "↩ Undo" on the panel or the card (or undo a single account in the accounts dialog)
- **One-click sign-all**: sign everything due today in a single request (multi-account services get all their accounts signed at once)
- **Levels & achievements**: XP levels, achievement wall, streaks, check-in heatmap, daily fortune
- **Mark abnormal**: a site temporarily broken and un-check-in-able? Tick "⚠️ Mark abnormal" and its card and check-in row turn red; marked services don't count toward all-done, sign-all, or reminders — unmark them when they're back

### Expiry & renewal
- **Expiring soon**: services expiring within 30 days listed in the sidebar (with a count badge), most urgent first; a banner on top for anything due within 7 days
- **Renew**: extends by the service's own renewal cycle (from the old expiry date if not expired, from today if expired; 365 days = +1 year, Feb 29 → Feb 28)
- **Undo renewal**: renewed by mistake? Undo restores the previous expiry date
- **Renewal history**: every renewal is logged (when, from which date to which date); expand it from the expiring row with "📜 Records", and cards show the last renewal date; undoing a renewal removes its log entry too
- **Cycle auto-fill**: expiry = registration/purchase date + renewal cycle — change either one and the other fills in; renewing also moves the start date to the new cycle start so the loop keeps going (a manually edited expiry is never auto-overwritten)
- **Expiry only changes the record**: the renew button only edits the date here — it does not pay the vendor for you
- **Calendar subscription**: a public `.ics` feed (`/api/calendar.ics`) — subscribe in your phone calendar and every expiry shows up automatically, with reminders 3 days and 1 day before; it contains only service names and expiry dates, no accounts or passwords

### Notepad
- A private notepad, visible only after login — **never shown on the pre-login home page**
- **Markdown** support (headings, bold/italic, code blocks, lists, quotes, links), with a formatting toolbar and preview on mobile
- Search, expand to read, edit, delete; backups and restores include your notes automatically

### Telegram notifications
- Push via the Telegram Bot API: daily at 17:00 (configurable) it reminds you about unsigned services and expiring ones — at most once per type per day, and only when there's something to report
- Bot commands: `/today` for today's check-in status, `/expiring` for the expiring list; reminder messages carry an "✅ Sign all" button that really signs
- Repeat reminders are configurable (off by default): after the fixed reminder, re-check every N hours
- Test it from the settings page — the test message uses the exact same layout as the real reminders; the token lives only on the server and is never sent to the frontend

### API token (iOS Shortcuts)
- Generate a dedicated token from the sidebar's "🔑 API token" panel and use it in an iOS Shortcut to sign in without opening the page; the token only authorizes the check-in endpoints (sign all, sign one service) and nothing else; it is shown once when generated, can be revoked anytime, and is never included in backup exports

### Highlights (v60)
- **Auto sign-in**: each service can have a sign-in request configured (URL + method + headers + body + text the response must contain); the server runs it hourly, and only a success counts as a sign-in — failures are not recorded and the Telegram reminder still fires. **Only works for plain API sign-ins with no human verification; sites with a CAPTCHA or a login form cannot be automated**; there is a "test this request" button in the edit dialog
- **Service health score**: a 0–100 score per service (uptime + expiry distance + check-in + dead link), shown as a badge on each card, with the 5 lowest scores listed in the data center
- **Two-factor login**: TOTP two-factor authentication (Google / Microsoft Authenticator, 1Password, etc.); after the password, a 6-digit code from your authenticator app is required; the secret lives only on the server and is never included in backups
- **Multi-tag**: a service can carry multiple tags (e.g. both "VPS" and "free"); tap a tag on a card or in the tag row to filter to services with that tag; search matches tags too
- **Public status page**: the pre-login landing page has a "Service status" section showing each service's online/offline state and 7-day uptime
- **Accounts CSV export**: all recorded accounts exported as CSV, importable into 1Password or Bitwarden; the file contains passwords, keep it safe
- **GitHub auto-backup**: with a token and a private repo configured, the data is pushed daily to `hubmate-backup.json` in the repo (the Git history is the backup history); skipped when the data is unchanged; the login password, Telegram token, API token, TOTP secret, and auto-sign-in headers are stripped before pushing

### Multi-server sync (v61)
- Deploy the hub on several servers and keep the data in sync: if one goes down, use another; when the downed server comes back up, it pulls the latest data within 30 seconds
- Every server shares one sync token (use it only between your own servers — it can read and write the whole dataset, keep it secret) and the other servers' addresses; on boot and every 5 minutes each server compares recency and content hash with its peers and pulls or pushes the newer data
- The current data is auto-backed up before adopting a peer's data (keeps the last 5); note: do not write to two servers in the same second — normally write on one server and treat the other as a hot standby

### What's new (v62)
- **Bookmark import**: import services in one go from a Chrome / Edge / Safari bookmarks HTML export; URLs that already exist are skipped
- **Accounts CSV import**: match existing services by name and append accounts in bulk (same columns as the accounts export, so an export can be re-imported as-is); missing services and duplicate accounts are skipped and reported
- **Multi-channel notifications**: besides Telegram, reminders can also go to a Webhook (POST JSON), Bark (iPhone push), and ServerChan (WeChat push); the test button reports each channel's result
- **Uptime trend**: a new panel in the data center — pick a service and see a 30-day chart of daily probe success rates
- **Global search**: one search box at the top searches services, accounts, and notes together, grouped by type; click a result to jump to it
- **Custom fields**: up to 10 custom key–value pairs per service (e.g. invite code, support email), added/removed in the edit dialog and shown on the card
- **Browser extension**: for desktop Chrome / Edge (in `browser-extension/`, an add-on in the repo): save the current page as a service in one click, and autofill accounts by domain on login pages; see `browser-extension/README.md` for how to load it
- **Fix**: restoring a backup no longer drops multi-account data or the "abnormal" flag (restore used to keep only the default account)

### Backup & security
- **Backup / restore**: one-click backup download (login password hash, Telegram token, API token, TOTP secret, sync token, and auto-sign-in headers are stripped automatically); restoring auto-saves the current data first (keeps the last 5)
- **Export ledger**: generates a `服务台账.md` (service ledger) for easy reading
- **Login captcha**: built-in image captcha (one-time, 5-minute expiry, checked before the password) + per-IP rate limiting (10 attempts / 10 min)
- **Security headers + CSP, gzip, ETag caching**, systemd sandbox running as a low-privilege user

### Data & themes
- **Year in review**: a card for the year — check-in days, total check-ins, XP earned from check-ins, and your most-checked-in service
- **Follow system theme**: a 5th theme dot, "Follow system", that switches light/dark automatically with your phone's system setting

### Mobile friendly
- Mobile layout: collapsible panel help texts and category groups, back-to-top button only appears when scrolling up
- **Add to home screen** (PWA manifest + icons, no Service Worker)

## 🚀 Quick start

### Run locally
```bash
node server.js
# Open http://127.0.0.1:7788
```
On Windows you can double-click `start.bat` (closing the black window stops the service). Default port is 7788, change it with the `PORT` environment variable.

Default login is `jason` / `jason123` — **change the password after logging in** (top-right "change password").

### Deploy to a server (2 minutes)
```bash
git clone https://github.com/jasonssuns-prog/hubmate.git /opt/service-hub
cd /opt/service-hub && sudo bash deploy/install.sh
```
The script installs Node.js, creates a low-privilege user, sets up systemd autostart, and runs a health check. Then open `http://YOUR_SERVER_IP:7788` — default login is `jason` / `jason123`, change the password right after logging in. For more options (nginx reverse proxy, HTTPS, custom port), see [`DEPLOY.md`](./DEPLOY.md).

### Custom domain (Cloudflare)
`cloudflare-worker/` contains a reverse-proxy Worker: bind your own domain to it and it forwards visits to your deployed instance, keeping your domain in the address bar. See [`cloudflare-worker/README.md`](./cloudflare-worker/README.md).

> **One-click deploy to Cloudflare Workers?** Not currently possible: this project is a Node.js server (listens on a port, stores data in local files), while Workers is a serverless runtime with no persistent filesystem and no TCP listener — so a [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) button can't deploy it directly. Turning it into a native Workers app (KV / D1 storage) would be a separate, larger project — open an Issue if you're interested.

## 🔔 Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and get the token.
2. Log in to the hub → sidebar "🔔 Notification settings" and paste the token, save.
3. Send `/start` to your bot on Telegram first (the bot needs to hear from you before it can get your Chat ID).
4. Click "auto-fetch Chat ID", then "send test" — if the test message arrives, you're set.

The token is stored only in the server's `data.json` and never appears in the frontend or in backup files. **Never post the token in a group chat or anywhere public** — if it leaks, regenerate it via @BotFather.

## ☁️ GitHub auto-backup setup

1. Create a **private** repo on GitHub (e.g. `hubmate-data`) — empty is fine, no README / .gitignore / license needed.
2. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic). Give it a note (e.g. `hubmate-backup`), set Expiration to No expiration, check the `repo` scope, and copy the token — **it is shown only once**.
3. Log in to the hub → sidebar "☁️ GitHub backup", fill in the token, the repo (`your-username/repo-name`, e.g. `jasonssuns-prog/hubmate-data`), and the branch (default `main`), then save and hit "Back up now".
4. Once configured, it backs up daily (skipped when the data is unchanged); the backup file is `hubmate-backup.json` in the repo, and the Git history is the backup history.

The login password hash, Telegram token, API token, TOTP secret, sync token, and auto-sign-in headers are stripped before pushing. If the token leaks, delete it on GitHub, create a new one, and update it in the panel.

## 💾 Data

Everything lives in `data/data.json` (services, categories, notes, settings, check-in history). The service re-reads it on every start, so you can edit the file directly if you like.

> Backup files **exclude** the login password hash, Telegram token, API token, TOTP secret, sync token, and auto-sign-in headers; restoring a backup keeps your current values.

## ❤️ Sponsor

This is a free, open-source project maintained by one person. If you find it useful:

- Give it a ⭐ **Star** so more people can find it;
- Sponsor continued development via [GitHub Sponsors](https://github.com/sponsors/jasonssuns-prog);
- Found a bug or want a feature? Open an [Issue](https://github.com/jasonssuns-prog/hubmate/issues).

## 📄 License

[MIT](./LICENSE)
