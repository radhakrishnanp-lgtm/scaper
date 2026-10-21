# Runbook

## Back up and restore

Your data is the `data/` folder (`scaper.db`, plus `-wal`/`-shm` files while running).

- **Back up**: stop Scaper, copy `data/`. While running, use `sqlite3 data/scaper.db ".backup data/backup-$(date +%F).db"`. A JSON export is also in Settings → Data.
- **Restore**: stop Scaper, replace `data/scaper.db` with the backup (delete the `-wal`/`-shm` files), start again.
- On a VPS, add a daily cron: `0 3 * * * sqlite3 /srv/scaper/data/scaper.db ".backup /srv/backups/scaper-$(date +\%F).db"` and keep 14 days.

## Put it on your VPS (later)

1. `git clone` the repo, `npm ci`, `npx playwright install --with-deps chromium`.
2. Create `.env.local` with `SCAPER_APP_PASSWORD`, `SCAPER_SESSION_SECRET` (32+ random chars) and `SCAPER_ALLOWED_HOSTS=scaper.yourdomain.com`.
3. `npm run build`, then run `npm start` under systemd or pm2 (it listens on 127.0.0.1:3000).
4. Put Caddy or Nginx in front for HTTPS: Caddy example `scaper.yourdomain.com { reverse_proxy 127.0.0.1:3000 }`.
5. Check `https://scaper.yourdomain.com/api/health`. Point an uptime monitor at it.

Keep "Allow private network" off on a VPS.

## Roll back a bad update

`git checkout <previous tag or commit> && npm ci && npm run build && restart`. Migrations only add things, so older code keeps working with a newer database as long as it does not need new columns. Take a backup before updating.

## Rotate a secret

- AI key / Telegram token: paste the new one in Settings, revoke the old one with the provider.
- `SCAPER_SESSION_SECRET`: change it and restart; everyone is logged out.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The scraping browser is not installed yet" | `npm run setup:browser` (or switch the job to Fast mode) |
| `better-sqlite3` build error on install | Use Node 20/22 LTS; on Windows install "Desktop development with C++" build tools, then `npm rebuild better-sqlite3` |
| A site keeps showing "blocked" | It is showing a bot check or rate limit. Increase the interval and the per-site delay, open the page yourself, or use the site's official API |
| robots.txt refusal | The site asked bots not to load that page. Only turn the check off for sites you own or have permission for |
| Watcher alerts on every check | Watch a selector instead of the whole page, or add noisy phrases to "Ignore lines containing" |
| Agent: "model may not support tool calling" | Pick a tool-capable model (recent GPT, Llama 3.1+, Qwen 2.5+, Mistral) |
| No desktop notifications | Alerts page → Turn on, and keep one Scaper tab open |
