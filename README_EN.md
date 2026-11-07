# 🗂️ HubMate — My Service Hub

[中文](./README.md) | English

[![GitHub stars](https://img.shields.io/github/stars/jasonssuns-prog/hubmate)](https://github.com/jasonssuns-prog/hubmate/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org/)

**Keep track of everything you signed up for** — check-in sites, proxies, VPS, games, subscriptions — check in daily and watch expirations, **all on one page**.

Pure Node.js with **zero dependencies** (no `npm install`), data lives in a single local `data.json`, one command to deploy.

🌐 **Live demo**: [web.jasonsun.us](https://web.jasonsun.us) — the author's own hub. The public landing page (site list and check-ins) is visible without logging in; personal data behind the login (accounts, notes, notification settings) stays private.

> ⭐ If this project is useful to you, please give it a Star. To support continued development, see [Sponsor](#️-sponsor) at the bottom.

## ✨ Features

### Service management
- **CRUD**: name, category, URL, account, password/secret, price, notes; a service can hold multiple accounts (main/alt) — expand the card to one-tap copy credentials and jump to the site
- **Manageable categories**: custom categories (rename, change icon); only empty custom categories can be deleted
- **Favorites**: star services, a "★ My Favorites" section on the home page; the "Favorites" category groups in too
- **Password reuse warning**: if the same password is used on multiple accounts, it is flagged (grouped by password, tap the eye to reveal it) so you can change them to different ones
- **Bulk mode**: select multiple services, move them to another category or delete them at once
- **Reorder**: move cards up / down, your order stays
- **Duplicate cleanup**: finds services with the same name or domain, clean them up in one place
- **Dead-link checks**: every 6 hours it HEAD-checks your URLs and flags ones that look dead ⚠️
- **Search**: search by name / account / URL / notes when logged in; the public home page is searchable too

### Check-ins & XP
- **Daily check-in**: +5⚡ per check-in, only the first one of the day counts (anti-farming)
- **Check-in interval**: check in every N days (1 = daily); services that aren't due are never nagged
- **All-done bonus**: +10⚡ when everything due today is signed
- **Undo check-in**: misclicked? Hit "↩ Undo" on the panel or the card
- **One-click sign-all**: sign everything due today in a single request
- **Levels & achievements**: XP levels, achievement wall, streaks, check-in heatmap, daily fortune
- **Mark abnormal**: a site temporarily broken and un-check-in-able? Tick "⚠️ Mark abnormal" and its card and check-in row turn red; marked services don't count toward all-done, sign-all, or reminders — unmark them when they're back

### Expiry & renewal
- **Expiring soon**: services expiring within 30 days listed in the sidebar (with a count badge), most urgent first; a banner on top for anything due within 7 days
- **Renew**: extends by the service's own renewal cycle (from the old expiry date if not expired, from today if expired; 365 days = +1 year, Feb 29 → Feb 28)
- **Undo renewal**: renewed by mistake? Undo restores the previous expiry date
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

### Backup & security
- **Backup / restore**: one-click backup download (login password hash and Telegram token are stripped automatically); restoring auto-saves the current data first (keeps the last 5)
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

### Deploy to a server
See [`DEPLOY.md`](./DEPLOY.md): one `bash deploy/install.sh` sets it up (systemd service + optional nginx reverse proxy + HTTPS).

### Custom domain (Cloudflare)
`cloudflare-worker/` contains a reverse-proxy Worker: bind your own domain to it and it forwards visits to your deployed instance, keeping your domain in the address bar. See [`cloudflare-worker/README.md`](./cloudflare-worker/README.md).

> **One-click deploy to Cloudflare Workers?** Not currently possible: this project is a Node.js server (listens on a port, stores data in local files), while Workers is a serverless runtime with no persistent filesystem and no TCP listener — so a [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) button can't deploy it directly. Turning it into a native Workers app (KV / D1 storage) would be a separate, larger project — open an Issue if you're interested.

## 🔔 Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and get the token.
2. Log in to the hub → sidebar "🔔 Notification settings" and paste the token, save.
3. Send `/start` to your bot on Telegram first (the bot needs to hear from you before it can get your Chat ID).
4. Click "auto-fetch Chat ID", then "send test" — if the test message arrives, you're set.

The token is stored only in the server's `data.json` and never appears in the frontend or in backup files. **Never post the token in a group chat or anywhere public** — if it leaks, regenerate it via @BotFather.

## 💾 Data

Everything lives in `data/data.json` (services, categories, notes, settings, check-in history). The service re-reads it on every start, so you can edit the file directly if you like.

> Backup files **exclude** the login password hash and the Telegram token; restoring a backup keeps your current token.

## ❤️ Sponsor

This is a free, open-source project maintained by one person. If you find it useful:

- Give it a ⭐ **Star** so more people can find it;
- Sponsor continued development via [GitHub Sponsors](https://github.com/sponsors/jasonssuns-prog);
- Found a bug or want a feature? Open an [Issue](https://github.com/jasonssuns-prog/hubmate/issues).

## 📄 License

[MIT](./LICENSE)
