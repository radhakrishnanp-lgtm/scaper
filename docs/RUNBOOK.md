# Runbook

## Back up and restore

Your data is the `data/` folder: `scaper.db` (plus `-wal`/`-shm` files while running), `media/` (watcher screenshots), `exports/` (files saved by tasks) and `backups/`.

- **Automatic**: Settings → Data & backups → "Back up once a day" (on by default). Scaper takes a consistent copy of the live database into `data/backups/` and keeps the newest N (default 7).
- **By hand**: Settings → Data & backups → **Back up now**, then **Download** to keep a copy somewhere else (another disk, cloud drive). Backups inside `data/` don't help if that disk dies.
- **Your setup only**: Settings → API & import → **Export setup** gives one JSON file with tasks, watchers, products, deal searches and site rules (no secrets, no history). **Import setup** on another machine adds them.

**Restore a backup**

1. Stop Scaper (Ctrl+C in the terminal running `npm run dev`).
2. Copy the backup over `data/scaper.db`, for example `cp data/backups/scaper-2026-10-22_06-20-08-700.db data/scaper.db`.
3. Delete `data/scaper.db-wal` and `data/scaper.db-shm` if they exist.
4. Start Scaper again. Settings, API keys and history come back as they were at backup time.

On a VPS, also copy `data/backups/` off the server daily (for example `rclone` or `rsync` from cron).

## Data retention

Settings → Data & backups → Keep. Every 6 hours Scaper removes data older than these limits (scrape results, snapshots per watcher, job history, logs) and screenshots no longer used, then compacts the write-ahead log. Read alerts older than 90 days are removed too.

## Put it on your VPS (later)

1. `git clone` the repo, `npm ci`, `npx playwright install --with-deps chromium`.
2. Create `.env.local` with `SCAPER_APP_PASSWORD`, `SCAPER_SESSION_SECRET` (32+ random chars) and `SCAPER_ALLOWED_HOSTS=scaper.yourdomain.com`.
3. `npm run build`, then run `npm start` under systemd or pm2 (it listens on 127.0.0.1:3000).
4. Put Caddy or Nginx in front for HTTPS: Caddy example `scaper.yourdomain.com { reverse_proxy 127.0.0.1:3000 }`.
5. Check `https://scaper.yourdomain.com/api/health`. Point an uptime monitor at it.

Keep "Allow private network addresses" off on a VPS.

## Roll back a bad update

Take a backup first. Then `git checkout <previous tag or commit> && npm ci && npm run build` and restart. Migrations only add tables and columns, so older code keeps working with a newer database as long as it doesn't need the new columns.

## Rotate a secret

- **AI key, Telegram token, SMTP password, ntfy token**: paste the new one in Settings, then revoke the old one with the provider. Leaving the field empty keeps the saved one; "Remove saved key" deletes the AI key.
- **Webhook, Discord, Slack, ntfy URLs**: shown hidden after saving. Paste a full new URL to replace one, or clear the field to remove it.
- **API tokens**: Settings → API & import → Revoke, then create a new one. Anything using the old token gets `401` at once.
- **`SCAPER_SESSION_SECRET`**: change it and restart; everyone is logged out.

## Jobs and the Runs page

Every task run, watcher check, price refresh, deal search and backup is a job. The Runs page shows what is queued, running and finished, with live logs.

- **Stuck "running" after a crash**: on start-up Scaper marks those jobs failed ("Interrupted because Scaper restarted"); press Retry.
- **Too slow**: Settings → Scraping → "Jobs at the same time" runs jobs for different sites in parallel. One site always gets one request at a time.
- **Clear the list**: Runs → Clear finished.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The scraping browser is not installed yet" | `npm run setup:browser` (or switch the job to Fast mode) |
| `better-sqlite3` build error on install | Use Node 20/22 LTS; on Windows install "Desktop development with C++" build tools, then `npm rebuild better-sqlite3` |
| A site keeps showing "blocked" | It is showing a bot check or rate limit. On the Sites page give it a longer delay, open the page yourself, or use the site's official API. Reset the backoff once it works again |
| "127.0.0.1 points to a private network address" | Turn on Settings → Scraping → "Allow private network addresses" only if you scrape your own devices |
| robots.txt refusal | The site asked bots not to load that page. Only turn the check off (per site, on the Sites page) for sites you own or have permission for |
| Watcher alerts on every check | Watch "Part of a page" instead of the whole page, or use the noise filters (ignore lines, ignore numbers) |
| A task finds fewer rows than before | The site changed. Open the task, use Test run, and fix the selectors with Pick on page. Data quality checks can alert you when this happens |
| Agent: "model may not support tool calling" | Pick a tool-capable model (recent GPT, Llama 3.1+, Qwen 2.5+, Mistral) |
| An alert channel test fails | The message under the test names the fix (missing token, wrong chat ID, HTTP status from the service). Save before testing |
| The dev page keeps reloading or shows odd build errors | Stop `npm run dev`, delete the `.next` folder, start again. This happens if `npm run build` ran while dev was running |
| No desktop notifications | Alerts page → Enable desktop alerts, and keep one Scaper tab open |
| Logs page | Shows saved settings, blocked pages, failed alerts and backups. Filter by Problems to see what went wrong |
