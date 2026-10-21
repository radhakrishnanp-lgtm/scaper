# API

All endpoints are JSON, same-origin only. Writes (POST/PUT/PATCH/DELETE) must send an `Origin` header matching the host. Errors look like `{"error": {"code", "message", "requestId", "fields?"}}`.

| Method & path | Purpose | Rate limit |
|---|---|---|
| GET `/api/health` | DB, scheduler and browser status (public) | – |
| POST `/api/auth/login` · `/api/auth/logout` | Password session (when enabled) | login: 10 per 15 min |
| GET/PUT `/api/settings` | Read (secrets masked) / update settings | – |
| POST `/api/settings/test` | Test `ai`, `ai_fast`, `webhook` or `telegram` | 10/min |
| POST `/api/scrape` | Run a scrape `{url, mode, extract, screenshot?, recipeId?}` | 30/min, burst 10 |
| GET/POST `/api/recipes` · GET/PUT/DELETE `/api/recipes/:id` · POST `/api/recipes/:id/run` | Recipes | run: shares scrape limit |
| GET `/api/runs?limit&before&recipeId` · GET/DELETE `/api/runs/:id` | Scrape history (cursor pagination) | – |
| GET `/api/runs/:id/export?format=csv|json&dataset=N` | Download a dataset | – |
| GET/POST `/api/watchers` · GET/PUT/PATCH/DELETE `/api/watchers/:id` | Watchers (PATCH = pause/resume) | – |
| POST `/api/watchers/:id/check` | Check now | 6/min per watcher |
| GET `/api/watchers/:id/snapshots?changed=1&before` · GET `/api/watchers/:id/snapshots/:sid` | History and full snapshot | – |
| GET/POST `/api/notifications` | Inbox; POST `{action:"read", ids|"all"}` | – |
| GET `/api/notifications/stream` | Server-Sent Events | – |
| GET/POST `/api/products` · GET/PATCH/DELETE `/api/products/:id` · POST `/api/products/:id/refresh` | Price tracking | add: 20/min; refresh: 4/min per product |
| POST `/api/deals/scan` | Scan a listing `{url, minDiscount, rankWithAi}` | 10/min |
| POST `/api/agent` · GET `/api/agent/runs` · GET `/api/agent/runs/:id` | Agent runs (async; poll the run) | 10/min |
| GET `/api/stats` · GET `/api/events` | Dashboard numbers · audit log | – |
| GET `/api/data/export` | JSON backup (secrets masked) | – |

## Webhook payload

```json
{ "event": "scaper.watcher", "title": "Headphones price", "body": "Dropped 12.0% (from 2,499 to 2,199).", "url": "https://…", "data": { "value": 2199 }, "sentAt": "2026-10-21T04:00:00.000Z" }
```

When `SCAPER_SESSION_SECRET` is set, requests carry `x-scaper-signature: hex(HMAC-SHA256(secret, body))`.
