# Architecture

```
Browser (React UI, client components)
   │  fetch JSON  ·  EventSource (/api/notifications/stream)
   ▼
src/proxy.ts ── host check · same-origin check on writes · optional password session
   ▼
Next.js route handlers (src/app/api/**)  ── Zod validation, one error format, rate limits
   ▼
Services (src/server)
   ├─ scrape.ts ............ fetch → extract (auto | selectors | AI) → save run
   ├─ watch/runner.ts ...... fetch → read target → diff → evaluate rule → deliver alert
   ├─ deals/tracker.ts ..... product checks, price points, listing scans, deal score
   ├─ ai/agent.ts .......... tool-calling loop over the services above
   ├─ notify/ .............. inbox + live bus + webhook + Telegram
   └─ scheduler.ts ......... 15 s tick, claims due watchers/products (started by instrumentation.ts)
   ▼
fetcher/ ── network guard → robots.txt → per-host turn (delay, jitter, backoff) → HTTP or Chromium → bot-check detection
   ▼
repo/ ── prepared statements only ── SQLite (data/scaper.db, WAL)
```

## Key decisions

| Decision | Why |
|---|---|
| Next.js full-stack, one process | `npm run dev` starts UI, API and scheduler together; no separate worker to forget. |
| SQLite + a repo layer | No database server to install. All SQL sits in `src/server/repo`, so moving to Postgres later touches one folder. |
| In-process scheduler with leases | Due rows are "claimed" by pushing `next_check_at` forward in a transaction, so a slow check never runs twice. Survives hot reload via a `globalThis` singleton. |
| Two fetch modes | Fast (undici HTTP) is cheap and light; Browser (Playwright Chromium) runs JavaScript. Each job picks one. |
| Politeness in one place | `fetchPage` is the only way to load a page, so every feature (scraper, watchers, deals, agent) gets robots.txt, rate limits and backoff. |
| Own price history | Store "M.R.P." values are often inflated. Scaper judges deals against its own snapshots. |
| OpenAI-compatible client | One small client works with OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio and vLLM. |
| SSE for live updates | One-way server → browser events are enough; no WebSocket server needed. |
| No auth by default, optional password | It binds to 127.0.0.1 for local use. A signed HttpOnly cookie protects it on a VPS. |

## Data model

| Table | Purpose | Notes |
|---|---|---|
| `settings` | AI, scraping, notification settings | One JSON row per section |
| `recipes` | Saved scrapes | |
| `scrape_runs` | Scrape history with results | Latest 500 kept |
| `watchers` | Watch jobs | `next_check_at` indexed for the scheduler |
| `snapshots` | Content per check | Unchanged checks bump the latest row instead of duplicating; 200 kept per watcher |
| `products` | Tracked products | Unique canonical URL |
| `price_points` | Price history | One per successful check |
| `notifications` | Alert inbox | Read alerts older than 90 days pruned |
| `agent_runs` | Agent transcripts | |
| `ai_usage` | Requests and tokens per day | Enforces the daily cap |
| `event_log` | Audit log | 30 days |

Migrations live in `src/server/db.ts` (numbered, applied in a transaction at startup).

## First bottleneck and plan

The first limit is one Chromium on one machine (about 2–4 pages at a time). Next steps when needed: move the scheduler into a separate worker process, swap the in-memory rate limiter and bus for Redis, and Postgres for SQLite via the repo layer.
