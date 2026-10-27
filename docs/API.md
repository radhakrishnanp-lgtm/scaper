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
| POST `/api/ai/fields` | "Suggest columns" for AI extraction `{url, describe, mode, useFastModel}` → `{scope, instruction, fields}` | 20/min |
| POST `/api/crawl/plan` | Category scrape step 1 `{url, goal, mode, maxCategories, pagesPerCategory, useFastModel, private}` → `{plan}` (categories, sample rows, selectors, pagination, other menu links) | 6/min |
| POST `/api/crawl/run` | Step 2: run the plan as a job, or save it as a task with `save: {scheduleMinutes, cron}` → `{job, taskId}` | 10/min |
| POST `/api/tasks/:id/heal` | "Fix with AI": new selectors for the same columns, tested on today's page; send `{apply: extract}` to save them | 6/min |
| GET `/api/runs/:id/compare?with=&key=` | New, gone and changed rows against an earlier run of the same task | – |
| POST `/api/steps/test` | Try page actions in the browser and get a screenshot | 8/min |
| GET `/api/schedule/preview?cron=` | Next run times for a cron expression | – |

### Operations, quality and repair

| Method & path | Purpose | Rate limit |
|---|---|---|
| GET `/api/operations` | Fleet health: every task and watcher, a 30-day strip, failures grouped by cause, repairs and changes waiting | – |
| GET `/api/tasks/:id/health` | Success rates, fail streak, p50/p95, usual row range, last 200 runs with failure reports and scores, issues, pending repair | – |
| PUT `/api/tasks/:id/rules` | Save data checks `{rules, alert: off\|fail\|warn}` (creates a version) | – |
| POST `/api/tasks/:id/rules/suggest` | Checks that describe the last good run `{ai: false}` (from the data) or `{ai: true}` (your AI, merged with Scaper's) | AI: 6/min |
| GET `/api/tasks/:id/issues?status=open\|resolved` | Data issues tracked across runs | – |
| GET `/api/tasks/:id/versions` · GET/POST `/api/tasks/:id/versions/:n` | Every saved setup with who changed it and runs per version · read one · restore it (saved as a new version) | – |
| GET `/api/tasks/:id/repairs` · POST `/api/tasks/:id/repairs/:pid` | AI repairs (pending, applied, dismissed, failed) with their checks · `{action: apply\|dismiss, runAfter}` | – |
| POST `/api/tasks/:id/heal` | "Fix with AI" now: returns the checks against the last good run and the proposed `extract`; `{apply, proposalId?}` saves it | 6/min |
| PATCH `/api/tasks/:id` | Also takes `{heal: off\|ask\|auto}` | – |
| GET `/api/watchers/:id/versions` · POST `/api/watchers/:id/versions/:n` | Watcher versions · restore | – |
| GET `/api/changes?status=unreviewed\|important\|all\|not_useful&watcher&tag&q&limit` · POST `/api/changes` | The change inbox with counts · triage `{ids, reviewed?, important?, feedback?: useful\|not_useful}` | – |
| POST `/api/changes/review-all` · POST `/api/changes/:id/ignore` | Mark all reviewed `{watcherId?}` · "Not useful": ignore `{lines}` on that watcher from now on (history kept) | – |
| POST `/api/briefing` · GET `/api/briefing/export?days&tags&ai=1&format=md` | Preview or send a briefing `{days, tags?, match?, ai?, send}` · download it as HTML or Markdown | AI: 6/min |
| GET/POST `/api/views?scope=` · DELETE `/api/views/:id` | Saved table views (columns, widths, pins, filters, sort) per dataset | – |

### Decisions

| Method & path | Purpose | Rate limit |
|---|---|---|
| GET `/api/decisions` | Decision model status: on/off, model, provider, endpoint, what it is used for, thresholds | – |
| POST `/api/decisions` | Playground: `{state, questions, threshold}` → the model's answers plus Scaper's reading at the threshold (`clear` / `needs_review`). Questions use OpenRouter's shapes: `noul` (optional `criteria: {true, false}`), `choice` (`criteria: {option: text\|null}`), `score` (`criteria: [levels, lowest first]`); up to 200 | 20/min |
| POST `/api/decisions/check` | "OK to scrape?" `{url, goal?, mode?}` → `outcome: ok\|caution\|stop`, findings (each from a `rule` or the `ai`), page kind, data richness | 12/min |
| POST `/api/decisions/links` | "What to scrape" `{url, goal}` → every same-site link with the probability it leads to what you want | 10/min |
| POST `/api/decisions/test` | One small decision to prove the key, endpoint and model | 6/min |
| POST `/api/settings/network-test` | Load `{url}` through the saved route (proxy, HTTPS_PROXY or direct) and report status, time and route | 10/min |

### Integrations

| Method & path | Purpose | Rate limit |
|---|---|---|
| POST `/api/mcp` | MCP (JSON-RPC 2.0, Streamable HTTP, JSON responses): `initialize`, `ping`, `tools/list`, `tools/call`. Needs a Bearer token from other apps. Off switch and "Allow changes" in Integrations → MCP | 120/min |
| GET `/api/integrations` | Status of MCP, webhooks, Sheets, Firecrawl and Apify with 7-day delivery counts | – |
| POST `/api/integrations/firecrawl/test` · POST `/api/integrations/apify/test` | Load example.com through Firecrawl (and show credits left) · check the Apify token (user name and plan) | – |
| GET `/api/integrations/apify/store?q=` · GET `/api/integrations/apify/actor?id=` | Search the Apify Store, most used first · one actor's title and example input | – |
| POST `/api/integrations/webhooks/test` · POST `/api/integrations/sheets/test` | Test an endpoint `{id?, url?, secret?}` · open a sheet `{spreadsheet}` | 20/min |
| GET `/api/deliveries?kind&status&target&limit` · POST `/api/deliveries/:id/redeliver` · POST `/api/deliveries/retry-failed` | Delivery log with request, response and attempts · send again · retry every failed one | redeliver: 30/min |

### Jobs (the Runs page)

| Method & path | Purpose |
|---|---|
| GET `/api/jobs?status&kind&q&before&limit` · DELETE `/api/jobs` | List jobs · clear finished ones |
| GET `/api/jobs/:id?after=<logId>` | Job with progress and its log lines after `after` |
| POST `/api/jobs/:id/cancel` · POST `/api/jobs/:id/retry` | Cancel a queued or running job · run it again |
| POST `/api/jobs/:id/pause` · POST `/api/jobs/:id/resume` | Pause a queued job, or a running task or quick scrape after its current page (it saves where it stopped) · carry on from there. Private runs cannot pause |
| POST `/api/jobs/pause-all` | `{action: pause\|resume, downloads?: true}` pauses or resumes every run, and the download manager unless `downloads` is false; returns `{jobs, downloads}` |

### Downloads

| Method & path | Purpose |
|---|---|
| GET `/api/downloads?status&q&limit` | Files with progress, counts, the downloads folder, concurrency and size limit |
| POST `/api/downloads` | Queue direct file links `{urls: string[], folder?}`; the same link in the same folder is skipped |
| PATCH `/api/downloads` | `{action: pause\|resume\|cancel\|retry, ids: string[] \| "all"}` |
| DELETE `/api/downloads` · DELETE `/api/downloads/:id?file=1` | Clear finished rows (files stay) · remove one row, and its file with `file=1` |
| GET `/api/downloads/:id/file?open=1` | The downloaded file (as an attachment, or inline with `open=1`, sandboxed). Only files inside the downloads folder are served |

### Browser

| Method & path | Purpose |
|---|---|
| GET `/api/browser` · POST `/api/browser` | State (each tab has `status` and a `problem` with a plain reason when it did not load), annotations, bookmarks, add-ons and browser settings (engine, real window, Firefox installed) · `{action: open\|close, mode?: normal\|incognito}` (private mode always opens incognito) |
| GET `/api/browser/stream` | Server-sent events: `frame` (JPEG, size, scroll offsets), `state` (tabs, mode), `dialog`, `notice`. Frames are dropped, not queued, for slow readers |
| POST `/api/browser/input` | `{events: [...]}` up to 50 mouse (move, down, up, click, dblclick), wheel, key (with modifiers) and text events, in page pixels |
| POST `/api/browser/action` | `navigate {url}` (a link, host or search words), `back`, `forward`, `reload`, `stop`, `newTab {url?}`, `closeTab`, `switchTab {tabId}`, `viewport {width, height}`, `dialog {accept, text?}` |
| GET `/api/browser/screenshot?download=1` | A JPEG of the visible page |
| GET/POST/DELETE `/api/browser/annotations` · PATCH/DELETE `/api/browser/annotations/:id` | Notes on the current page (`?all=1` for recent notes everywhere), add `{x, y, w, h, note, color}`, clear (`?url=`) · edit or delete one |
| GET/DELETE `/api/browser/history` · GET `/api/browser/suggest?q` | History (`q`, `before`, `limit`); delete `{id}`, `{olderThanDays}` or `{all: true}` · address-bar suggestions from bookmarks and history |
| GET/POST `/api/browser/bookmarks` · DELETE `/api/browser/bookmarks/:id` | Bookmarks `{url, title}` |
| GET/POST `/api/browser/extensions` · PATCH/DELETE `/api/browser/extensions/:id` | Add-ons; install with `{store: "<Web Store link or id>"}` or a raw .zip/.crx body (60 MB max) · `{enabled}` or remove |
| POST `/api/browser/ask` | `{prompt, followUpOf?, model?: main\|fast}` starts an agent run with the open page and your notes attached; poll `/api/agent/runs/:id` |
| DELETE `/api/browser/profile` | Closes the browser and deletes its saved profile (cookies, cache, sign-ins) |

### Assistant

| Method & path | Purpose |
|---|---|
| POST `/api/assistant` | `{prompt, followUpOf?, model?: main\|fast, page, rows?: {source, columns, items[] (up to 2000; about 40 000 characters reach the model)}, focus?: {kind, id?, title, body?, url?}}` starts an agent run with the page you are on, recent alerts, changes to review, running jobs and your selection. Poll `/api/agent/runs/:id` |

### File finder

| Method & path | Purpose |
|---|---|
| GET `/api/files` | Recent file searches (jobs of kind `files`, result in `result`) and whether the AI and Firecrawl pickers are ready |
| POST `/api/files` | Start a search `{urls[], kinds[]: pdf\|ebook\|image\|video\|audio\|document\|archive, extensions[], instruction, picker: rules\|ai\|firecrawl, mode: fast\|browser\|firecrawl, depth: 0-3, followNext, sameSite, maxPages, maxFiles, probe, download, folder}`; returns `{job}`. Poll `/api/jobs/:id`: `result.files[]` has `url, name, ext, kind, from, text, size, contentType` and `result.pages[]` each page read, with errors |
| POST `/api/system/browser` | `{action: install, which: chromium\|firefox}` installs Playwright's Chromium or Firefox; `{action: test}` |

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
| GET `/api/agent` · POST `/api/agent` | Tool catalog, approval mode and step limit · start a run `{prompt, model?: "main"\|"fast"\|"<providerId>::<model>", followUpOf?, private?}`; poll the run | 10/min |
| POST `/api/agent/runs/:id/approve` | Answer a pending approval `{decision: allow\|allow_all\|deny}`; 409 when nothing is waiting | – |
| GET `/api/agent/runs?q&limit` · GET/DELETE `/api/agent/runs/:id` | History · one run with its earlier turns (`thread`), its helpers (`team`) and its self-review (`review`) · delete | – |
| POST `/api/agent/runs/:id/stop` | Stop a running agent after its current step; its helpers stop too | – |
| GET `/api/agent/runs/:id` → `team` | `{workers, memory}` when the run started helpers: each helper's name, role, instructions, task, examples, decision questions, tools, model, status, steps, report, tokens and cost, plus the shared memory notes; `null` otherwise | – |
| POST `/api/agent/runs/:id/helpers/:wid/stop` | Stop one helper | – |
| GET `/api/playbooks?q` · POST `/api/playbooks` | List playbooks (best success rate first when searching) · create `{name, kind?, instructions, examples?, questions?, notes?}` | – |
| PUT/DELETE `/api/playbooks/:id` | Save a new version (name kept) · delete | – |
| GET `/api/bots` · POST `/api/bots` | Your bots (with `scheduleText`), the active-bot limit and what event triggers can point at (`targets`: tasks, watchers, products, deal searches) · create `{name, emoji?, role, task, instructions?, schedule: {type: manual} \| {type: interval, minutes ≥ 5} \| {type: daily, time: "HH:MM", days?: [0-6]}, triggers?: [{event: task.finished\|task.failed\|task.alert\|watcher.change\|price.alert\|deal.found, refId?}], condition?, stopWhen?, permission: read\|ask\|auto, model?, maxSteps?, helpers?, memory?, notify?, notifyMode: always\|important\|off, cooldownMinutes?}`; 409 past 20 active bots | – |
| GET/PUT/DELETE `/api/bots/:id` | One bot with its last 40 runs (agent runs with `bot_id` and `trigger`), its memory and its run grades (`evals`) · change any fields or `{enabled}` (only the fields you send) · delete it and its memory (runs stay) | – |
| POST `/api/bots/:id/run` | Run now `{}` or chat `{prompt, followUpOf?}`; 409 when it is already running, paused for its schedule, in private mode or past 100 runs today. Approvals use `/api/agent/runs/:id/approve` | – |
| GET/POST/DELETE `/api/bots/:id/memory` · DELETE `/api/bots/:id/memory/:memId` | The bot's facts, run summaries and lessons · add or replace a fact `{key, value}` (secrets refused) · forget everything · forget one (a lesson too) | – |
| POST `/api/bots/:id/runs/:runId/feedback` | Your verdict on one run `{rating: 1\|-1\|0, note?}`; a note becomes a lesson the bot reads from its next run on, an empty note removes it. `GET /api/bots/:id` returns `evals`: each run's grade (score 1-5, did its job, summary, lessons, suggestion) and your rating | – |
| GET `/api/ai/usage` | Requests, tokens and cost today, this month and for 30 days, with limits and per-model stats | – |
| GET `/api/knowledge` | What the agent knows: the full guide, its topics, any pages or tools without help, notes, recent self-reviews and their average, the notes folder | – |
| POST `/api/knowledge/notes` · GET/PUT/DELETE `/api/knowledge/notes/:id` | Add a note `{title, kind: how-to\|site\|lesson\|reference, body}` · read · save a new version · delete (its `.md` file too). Bodies that look like keys or passwords are refused | – |
| POST `/api/ai/check` | "Test connection" before saving `{provider, model?}`: model list, one answer and tool calling, each as a step with a reason. A Decisions endpoint (`…/alpha/decisions`) or decisions model gets one test decision instead. Saves nothing; saving such a provider stores it as a chat provider (`…/api/v1`) and switches on the decision model | 10/min |
| GET/POST `/api/system/browser` | Scraping browser status (ready, which browser, browsers found on this computer, install progress) · `{action: "install"}` runs Playwright's installer in the background · `{action: "test"}` starts the browser once | install 3/min |
| POST `/api/ai/models` · POST `/api/ai/test` | List a provider's models `{provider}` · test a model `{providerId \| provider, model}` (answers, JSON mode, tools) | – |
| GET/DELETE `/api/ai/calls` · GET `/api/ai/calls/:id` | The AI log (`?purpose&status&model&q&before&limit&stats=30`); DELETE takes `?olderThanDays` · one call with prompt and reply | – |
| GET/POST `/api/ai/memory` · DELETE `/api/ai/memory/:id` | The agent's memory notes | – |
| GET `/api/history/timeline?types=&q&before&limit` | Everything Scaper did, newest first (scrape, agent, change, price, alert, ai) | – |
| POST `/api/privacy/wipe` | Delete history `{scopes, olderThanDays?}` (scrapes, agent, ai_log, ai_cache, jobs, alerts, changes, prices, logs, site_stats, memory, exports, backups, private), then compact the database | 6/min |
| GET/POST `/api/sites` · GET/DELETE `/api/sites/:host` · POST `/api/sites/:host/reset` | Per-site rules (slower delay, mode, headers, cookies, pause) and 30-day stats · reset backoff | – |
| GET/PUT `/api/settings` | Settings (secrets masked; a masked value sent back means "unchanged") | – |
| POST `/api/settings/test` | Test `ai`, `ai_fast`, `webhook`, `telegram`, `discord`, `slack`, `ntfy`, `email` or `whatsapp` | 10/min |
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

Events: `task.finished`, `task.failed` (with the failure report), `task.health`, `watcher.change`, `price`, `alert`. Named endpoints (Integrations → Webhooks) choose which events they get. Every request carries `x-scaper-event` and `x-scaper-delivery` (the same id on every retry, so receivers can drop duplicates). Endpoints with a secret get `x-scaper-signature: hex(HMAC-SHA256(secret, body))`; the default URL in Settings → Alerts is signed with `SCAPER_SESSION_SECRET` when that is set. Failed deliveries are retried after 30 s, 2 min, 10 min, 1 h and 6 h and are kept in the delivery log for 30 days.
