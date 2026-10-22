# API

Everything the UI does goes through this JSON API, so scripts can do it too.

## Calling it

**From the Scaper UI**: same-origin only. Writes (POST/PUT/PATCH/DELETE) must send an `Origin` header that matches the host, so other websites open in your browser can't call it.

**From scripts, cron, n8n or Home Assistant**: create a token in **Settings → API & import** and send it as a header. Tokens start with `scp_`, are shown once, are stored only as a hash, and can be revoked at any time. A token works for every route except login, logout and the live event stream.

```bash
export SCAPER_TOKEN=scp_…
curl -H "Authorization: Bearer $SCAPER_TOKEN" http://127.0.0.1:3000/api/tasks
curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://example.com","mode":"fast","extract":{"type":"auto"}}' http://127.0.0.1:3000/api/scrape
```

A wrong or revoked token always gets `401`, even when no app password is set.

**Errors** look like `{"error": {"code", "message", "requestId", "fields?"}}`. `fields` maps a dotted path (for example `options.pagination.selector`) to a message. Rate-limited calls get `429`.

## Routes

### Collect

| Method & path | Purpose | Rate limit |
|---|---|---|
| POST `/api/scrape` | Quick scrape `{url, mode, extract, options?}`. Runs as a job and waits for the result | 30/min, burst 10 |
| GET/POST `/api/tasks` | List or create tasks (saved scrapes with pages, detail pages, crawl, inputs, quality checks, alerts, schedule) | – |
| GET/PUT/PATCH/DELETE `/api/tasks/:id` | Read, replace, pause/resume (`{paused}`) or delete a task | – |
| POST `/api/tasks/:id/run` | Run now. Waits up to 90 s and returns the run; `?wait=0` returns the job at once | shares scrape limit |
| POST `/api/tasks/:id/duplicate` · DELETE `/api/tasks/:id/seen` | Copy a task · forget "already seen" rows and detail pages | – |
| `/api/recipes/**` | Older name for `/api/tasks/**`, kept for existing scripts | – |
| GET/DELETE `/api/runs` · GET/DELETE `/api/runs/:id` | Scraped data (`?recipeId&status&q&before&limit`); DELETE `/api/runs` takes `{ids}` | – |
| GET `/api/runs/:id/export?format=csv\|xlsx\|json\|ndjson&dataset=N` | Download one dataset | – |
| POST `/api/inspect` · POST `/api/inspect/test` | Screenshot and element boxes for the picker · live match count for a selector | 10/min · 120/min |
| POST `/api/ai/suggest` | "Build with AI": proposes selectors and tests them on the page | 20/min |
| POST `/api/steps/test` | Try page actions in the browser and get a screenshot | 8/min |
| GET `/api/schedule/preview?cron=` | Next run times for a cron expression | – |

### Jobs (the Runs page)

| Method & path | Purpose |
|---|---|
| GET `/api/jobs?status&kind&q&before&limit` · DELETE `/api/jobs` | List jobs · clear finished ones |
| GET `/api/jobs/:id?after=<logId>` | Job with progress and its log lines after `after` |
| POST `/api/jobs/:id/cancel` · POST `/api/jobs/:id/retry` | Cancel a queued or running job · run it again |

### Monitor

| Method & path | Purpose | Rate limit |
|---|---|---|
| GET/POST `/api/watchers` · GET/PUT/PATCH/DELETE `/api/watchers/:id` | Watchers (page, selector, price, visual, JSON, feed, sitemap, uptime); PATCH pauses/resumes | – |
| POST `/api/watchers/preview` | Test a watcher before saving `{watcher, sample?}` | 12/min |
| POST `/api/watchers/:id/check` · `/clear-error` · `/test-alert` | Check now · clear the failure state · send a test alert | 6/min per watcher |
| GET `/api/watchers/:id/snapshots?changed=1&before` · GET `/api/watchers/:id/snapshots/:sid` | History · one full snapshot | – |
| GET `/api/watchers/:id/compare?b=&a=` | Snapshot `b` against `a` (or the one before it), for the diff viewer | – |
| POST `/api/watchers/bulk` · POST `/api/watchers/import` | `{action: check\|pause\|resume\|tag\|untag\|delete, ids}` · create from a list of URLs | – |
| GET `/api/media/<path>` | Screenshots saved by watchers | – |
| GET/POST `/api/products` · GET/PATCH/DELETE `/api/products/:id` | Tracked products; POST takes `{url}` or `{urls}` | add: 20/min |
| POST `/api/products/:id/refresh` · GET `/api/products/:id/export` | Check now · price history as CSV | 4/min per product |
| POST `/api/deals/scan` | Scan a listing with filters `{url, filters, rankWithAi}` | 10/min |
| GET/POST `/api/deals/searches` · GET/PUT/DELETE `/api/deals/searches/:id` · POST `…/:id/run` | Saved deal searches that run on a schedule and alert on new matches | run: 10/min |
| GET/POST `/api/notifications` | Inbox (`?unread&kind&q&before`); POST `{action: read\|delete, ids \| "all" \| "read"}` | – |
| GET `/api/notifications/stream` | Server-Sent Events for live updates (browser session only) | – |

### Assist and system

| Method & path | Purpose | Rate limit |
|---|---|---|
| POST `/api/agent` | Start an agent run `{prompt, useFastModel, followUpOf?}`; poll the run | 10/min |
| GET `/api/agent/runs?q&limit` · GET/DELETE `/api/agent/runs/:id` | History · one run with its earlier turns (`thread`) · delete | – |
| POST `/api/agent/runs/:id/stop` | Stop a running agent after its current step | – |
| GET `/api/ai/usage` | Requests and tokens today and for 30 days | – |
| GET/POST `/api/sites` · GET/DELETE `/api/sites/:host` · POST `/api/sites/:host/reset` | Per-site rules (slower delay, mode, headers, cookies, pause) and 30-day stats · reset backoff | – |
| GET/PUT `/api/settings` | Settings (secrets masked; a masked value sent back means "unchanged") | – |
| POST `/api/settings/test` | Test `ai`, `ai_fast`, `webhook`, `telegram`, `discord`, `slack`, `ntfy` or `email` | 10/min |
| GET/POST `/api/tokens` · DELETE `/api/tokens/:id` | API tokens (POST returns the token once) · revoke | – |
| GET/POST `/api/backups` · GET/DELETE `/api/backups/:name` | List · back up now · download · delete | 4/min |
| GET/POST `/api/config` | Export setup (tasks, watchers, products, searches, site rules; no secrets) · import it (adds, skips duplicates) | – |
| GET `/api/storage` · GET `/api/stats` · GET `/api/events` · GET `/api/search?q=` | Disk use · dashboard numbers · audit log · search everything | – |
| GET `/api/data/export` | Everything as one JSON file (secrets masked) | – |
| GET `/api/health` | Version, database, scheduler and browser status (public) | – |
| POST `/api/auth/login` · `/api/auth/logout` | Password session, when `SCAPER_APP_PASSWORD` is set | login: 10 per 15 min |

## Webhook payload

Alerts sent to your webhook look like this:

```json
{ "event": "scaper.watcher", "title": "Headphones price", "body": "Dropped 12.0% (from 2,499 to 2,199).", "url": "https://…", "data": { "value": 2199 }, "sentAt": "2026-10-21T04:00:00.000Z" }
```

Tasks set to "Send rows to my webhook" post their rows when a run finishes (first 500 rows):

```json
{ "event": "scaper.task.finished", "task": { "id": "…", "name": "Widget catalogue" }, "run": { "id": "…", "status": "ok", "rows": 12, "pages": 15, "url": "https://…" }, "columns": ["title", "link", "price"], "rows": [{ "title": "Widget A", "link": "https://…", "price": "₹500" }], "monitor": { "added": 2, "removed": 0 } }
```

When `SCAPER_SESSION_SECRET` is set, requests carry `x-scaper-signature: hex(HMAC-SHA256(secret, body))`.
