# Architecture

```
Browser (React UI, client components)
   │  fetch JSON  ·  EventSource (/api/notifications/stream)        Scripts, n8n, cron
   ▼                                                                  │  Authorization: Bearer scp_…
src/proxy.ts ── host check · same-origin check on writes · optional password session · API tokens
   ▼
Next.js route handlers (src/app/api/**)  ── Zod validation, one error format, rate limits, token check
   ▼
Job queue (src/server/jobs) ── every run is a row in `jobs`: queued → running → succeeded/failed/cancelled,
   │                           progress + log lines, cancel/retry, N at a time (one per site), recovery on restart
   ▼
Services (src/server)
   ├─ tasks/engine.ts ...... start URLs, CSV inputs, sitemap, pagination, crawl, detail pages, quality checks,
   │                         new/removed rows, files and webhook output
   ├─ watch/runner.ts ...... fetch → read target (page, selector, price, visual, JSON, feed, sitemap, uptime)
   │                         → noise filters → diff → rules (all/any) → alert
   ├─ deals/tracker.ts ..... product checks, price points, listing scans with filters, saved searches, deal score
   ├─ ai/ .................. OpenAI-compatible client, AI extraction, "Build with AI" selectors, agent loop
   ├─ notify/ .............. inbox + live bus + webhook, Telegram, Discord, Slack, ntfy, email; quiet hours, digest
   ├─ ops/ ................. backups, storage, setup import/export
   └─ scheduler.ts ......... 15 s tick: enqueues due tasks, watchers, products and searches; maintenance every 6 h
   ▼
fetcher/ ── network guard → robots.txt → site rule → per-host turn (delay, jitter, backoff) → HTTP or Chromium → bot-check detection
   ▼
repo/ ── prepared statements only ── SQLite (data/scaper.db, WAL)
```

## Key decisions

| Decision | Why |
|---|---|
| Next.js full-stack, one process | `npm run dev` starts UI, API and scheduler together; no separate worker to forget. |
| SQLite + a repo layer | No database server to install. All SQL sits in `src/server/repo`, so moving to Postgres later touches one folder. |
| In-process scheduler with leases | Due rows are "claimed" by pushing `next_check_at` forward in a transaction, so a slow check never runs twice. Survives hot reload via a `globalThis` singleton. |
| A durable job queue in SQLite | Every piece of work (task run, quick scrape, watcher check, price refresh, deal search, backup) is a job row. The Runs page, progress, logs, cancel and retry all come from one place, `unique` stops the same item running twice, and jobs left "running" by a crash are marked failed at start-up. A small in-process pump runs up to "Jobs at the same time" jobs; the per-host turn still keeps one request at a time per site. |
| Two fetch modes | Fast (undici HTTP) is cheap and light; Browser (Playwright Chromium) runs JavaScript. Each job picks one. |
| Politeness in one place | `fetchPage` is the only way to load a page, so every feature (scraper, watchers, deals, agent) gets robots.txt, rate limits and backoff. |
| Own price history | Store "M.R.P." values are often inflated. Scaper judges deals against its own snapshots. |
| OpenAI-compatible client | One small client works with OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio and vLLM. |
| SSE for live updates | One-way server → browser events are enough; no WebSocket server needed. |
| No auth by default, optional password | It binds to 127.0.0.1 for local use. A signed HttpOnly cookie protects it on a VPS. |

## Data model

| Table | Purpose | Notes |
|---|---|---|
| `settings` | AI, scraping, notification and data settings | One JSON row per section |
| `recipes` | Tasks (saved scrapes with options, tags, schedule or cron) | Older name kept for compatibility |
| `scrape_runs` | Scraped data per run | Latest N kept (Settings → Data) |
| `task_seen` | Rows and detail pages a task has already seen | Powers "new rows" alerts and "only new detail pages" |
| `jobs` · `job_logs` | Job queue and per-job log lines | Kept N days |
| `watchers` | Watch jobs | `next_check_at` indexed for the scheduler |
| `snapshots` | Content per check, verdict, screenshot path, visual change | Unchanged checks bump the latest row instead of duplicating; N kept per watcher |
| `products` · `price_points` | Tracked products and their price history | Unique canonical URL; one point per successful check |
| `deal_searches` | Saved deal searches | Alert on new matches |
| `site_rules` · `host_stats` | Per-site rules (slower delay, mode, headers, cookies, pause) and daily request stats | Stats kept 90 days |
| `notifications` | Alert inbox | Read alerts older than 90 days pruned |
| `agent_runs` | Agent transcripts; `parent_id` links follow-ups; `bot_id` and `trigger` mark bot runs | Bot runs are left out of the agent page's list |
| `bots` · `bot_memory` | Your bots (settings as JSON, `next_run_at` for the scheduler, last outcome) and each bot's own memory (facts, plus a summary of each of its last 20 runs) | Memory is deleted with the bot |
| `ai_usage` | Requests and tokens per day | Enforces the daily cap |
| `api_tokens` | Hashed API tokens | |
| `event_log` | Audit log (Logs page) | Kept N days |

Migrations live in `src/server/db.ts` (numbered, applied in a transaction at startup).

## Bots

A bot run is an ordinary agent run (`startAgent` with a `bot` option): the bot's section (role, job, instructions, permission, alert and end conditions, its memory and recent runs) is added after the usual system prompt, its tools are filtered by `toolsFor` (bot-only memory and message tools in, bot-management tools out, changing tools out for read-only bots), and two hooks tell the bot when the run waits for an approval and when it ends. The scheduler starts due bots every tick (`runDueBots`); `startBotEvents` listens on the in-process bus for `task_run` events and alerts (`notification` with its kind), maps them to bot events and wakes the bots that subscribe, respecting each bot's cooldown. Alerts go through `deliver`, which adds the channels from Settings → Alerts → "Where each alert goes" (`routeChannels`) to the item's own channels.

## First bottleneck and plan

The first limit is one Chromium on one machine (about 2–4 pages at a time). Next steps when needed: move the scheduler into a separate worker process, swap the in-memory rate limiter and bus for Redis, and Postgres for SQLite via the repo layer.

## Keeping the agent's guide complete

The agent learns the app from `src/server/ai/knowledge.ts`. Tools (`ai/tools.ts`, `ai/team.ts`), menu pages (`components/nav.ts`) and the live set-up are read automatically. When you add a feature:

1. A new page in the menu needs one line in `PAGE_HELP`.
2. A new tool needs a clear description (at least a sentence); it then appears in the guide, the system prompt's tool map and `app_guide`.
3. A new area worth explaining gets a topic in `CURATED` (how to use it, which tools, limits).

`tests/knowledge.test.ts` fails if a page has no help, a tool has no description or a topic is empty, so the guide cannot fall behind.
