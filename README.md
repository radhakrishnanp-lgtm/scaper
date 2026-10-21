# Scaper

Scaper is a local-first web scraper, website watcher and price tracker with an AI agent that runs on **your own** OpenAI-compatible model. It runs on your computer with `npm run dev`. No cloud services, no Postgres, no Redis: everything is stored in one SQLite file.

**What it does**

- **Scrape any page.** Paste a URL and choose Auto (finds product lists, tables, structured data, links and images), CSS selectors (exact fields, one row per item) or AI (describe what you want). Export to CSV or JSON. Save scrapes as reusable recipes.
- **Watch websites.** Check a page, a part of a page or a price on a schedule. Alert on any change, text appearing or disappearing, a value going above or below a number, a % drop, or "the AI says this change matters". Ignore noisy lines. See a line-by-line diff of every change.
- **Alerts and triggers.** In-app inbox, desktop notifications, a webhook (n8n, Zapier, Make, your own server) and Telegram.
- **Deals and price history.** Track Amazon or any shop's product pages. Scaper builds its own price history (Keepa-style) and gives a deal score that compares today's price with the item's usual price, and flags inflated "M.R.P." discounts. Scan a listing page (for example an Amazon search) for the highest discounts, optionally ranked by your fast AI model.
- **AI agent.** "Find the best real deals on 55-inch TVs on Amazon India", "list the top 10 Hacker News stories", "watch this careers page for backend jobs". The agent uses Scaper's own tools (open page, extract, scan deals, price history, create watchers, notify) with any OpenAI-compatible API.

## Quick start (under 10 minutes)

Requirements: Node.js 20.9 or newer (22 LTS recommended).

```bash
npm install
npm run setup:browser   # one time: downloads the headless Chromium used by Browser mode
npm run dev             # open http://127.0.0.1:3000
```

Then, in the app:

1. **Scrape** → paste a URL → Scrape.
2. **Watchers** → New watcher.
3. **Settings → AI model** → choose a provider, paste your key, set a main model and a fast model, then press "Test".

Fast mode (plain HTTP) works even before you install the browser.

## Using your own AI model

Any service that speaks the OpenAI Chat Completions API works. Set the base URL in Settings:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Ollama (local, free) | `http://localhost:11434/v1` |
| LM Studio (local, free) | `http://localhost:1234/v1` |

- **Main model**: used by the agent and AI extraction. The agent needs a model with tool-calling support.
- **Fast model**: a small, cheap model for quick jobs (deal ranking, "does this change matter?" checks, simple extraction, and the agent's Fast mode).
- A **daily request limit** (default 300) stops runaway costs. Also set a spending limit with your provider.

## Scraping politely (and why your IP stays healthy)

Scaper is built to look like a careful person, not a flood:

- one request at a time per site, with a gap between requests (default 5 s, with random jitter), across at most 2 sites at once;
- respects `robots.txt` and its crawl delay;
- backs off exponentially when a site answers 429/503 or shows a bot check, and pauses that site;
- low-footprint Browser mode: one shared headless browser, images, fonts and video skipped;
- an optional proxy you own (for example on your VPS).

Scaper does **not** solve CAPTCHAs, fake browser fingerprints or bypass bot protection. When a site shows a robot check, Scaper stops, tells you and backs off. Getting around those checks breaks most sites' terms (Amazon's included) and is the fastest way to get an IP banned. For large-scale Amazon data, use Amazon's official Creators API (the successor to PA-API 5).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Scaper at http://127.0.0.1:3000 (scheduler included) |
| `npm run build` / `npm start` | Production build and server |
| `npm run setup:browser` | Install headless Chromium for Browser mode |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run check` | All of the above |

## Environment variables

All optional. Copy `.env.example` to `.env.local`.

| Name | Default | Purpose |
|---|---|---|
| `SCAPER_DATA_DIR` | `./data` | Where `scaper.db` lives |
| `SCAPER_APP_PASSWORD` | empty | Require a login. Set this before putting Scaper on a VPS |
| `SCAPER_SESSION_SECRET` | empty | 32+ random characters, signs the login cookie (required with a password) |
| `SCAPER_ALLOWED_HOSTS` | empty | Extra host names allowed to reach the app, e.g. your domain |
| `PLAYWRIGHT_EXECUTABLE_PATH` | empty | Use an existing Chrome/Chromium |
| `SCAPER_SCHEDULER` | `on` | Set `off` to stop background checks |

## Stack

Next.js 16 (App Router, TypeScript strict), Tailwind CSS 4, SQLite via better-sqlite3, Playwright (Chromium), Cheerio, Zod, Vitest. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## More docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together and why
- [docs/API.md](docs/API.md): every endpoint
- [docs/SECURITY.md](docs/SECURITY.md): threat model and protections
- [docs/RUNBOOK.md](docs/RUNBOOK.md): backups, VPS deploy, troubleshooting
- [docs/RESEARCH.md](docs/RESEARCH.md): market research and build brief
- [PROJECT_STATE.md](PROJECT_STATE.md): status, decisions and next steps
