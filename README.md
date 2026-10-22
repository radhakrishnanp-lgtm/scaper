# Scaper

Scaper is a local-first web scraper, website watcher and price tracker with an AI agent that runs on **your own** OpenAI-compatible model. It runs on your computer with `npm run dev`. No cloud services, no Postgres, no Redis: everything is stored in one SQLite file.

**What it does**

| Area | What you get |
|---|---|
| **Quick scrape** | Paste a URL. Auto finds product lists, tables, structured data, links and images; Selectors gives exact columns; AI takes a plain-language description. **Pick on page** lets you click elements on a screenshot, **Build with AI** proposes selectors and tests them, and live match counts show as you type. Next pages, page actions (click, type, scroll, wait…) and screenshots. Export CSV, Excel, JSON or NDJSON. |
| **Category scrape** | Give a site and say what you want. Your AI picks the category pages from the site's menus, Scaper works out the item layout and the next-page link, and reads every category page by page. Run it once, privately, or save it as a scheduled task. |
| **Tasks** | Saved scrapes with a full editor and seven templates (listing, list → detail pages, tables, crawl a section, many inputs from a CSV, alert on new listings, AI). Start URL ranges like `/page/{1..20}`, sitemaps, crawl rules with include/exclude patterns, open each row's detail page, dedupe, 12 clean-up transforms per field, data quality checks, "new rows" and "removed rows" alerts, files and webhook output, retries, interval or cron schedules. **Test run** before saving. |
| **Runs** | Every task run, check and refresh is a job you can watch live with progress and logs, cancel or retry. Several sites run in parallel, each site one request at a time. |
| **Watchers** | Whole page, part of a page, price & stock, visual (screenshot pixel diff), JSON API value, RSS/Atom feed, sitemap and uptime. Rules: any change, text appears/disappears, pattern, above/below, % drop/rise, back in stock, "AI decides it matters", combined with all/any. Noise filters, active hours and days, page actions before reading, quiet period after an alert. Side-by-side or inline diff of any two checks. |
| **Prices & deals** | Track products from Amazon or any shop. Scaper builds its own price history (Keepa-style): all-time low and high, 30/90/180/365-day averages, real discount vs the shop's claimed M.R.P. discount, a deal score. Scan a listing with filters (discount, price, rating, reviews, words, sponsored), save it as a search that alerts on new matches. |
| **Alerts** | In-app inbox and desktop pop-ups, plus Telegram, email (SMTP), Discord, Slack, ntfy push and webhooks (n8n, Make, Zapier, Home Assistant). Quiet hours, a daily digest, mute all, failure alerts. |
| **AI agent** | Ask in plain words. It has 40 tools: read and extract pages, its own browser (click, type, choose, scroll), map a site, plan category scrapes, create and schedule tasks, compare runs, watchers, prices and deals, memory. It asks before changing anything (or not, if you say so), shows every step, takes follow-ups, and runs on any model you choose. |
| **AI log & history** | Every model call with tokens, cost, time and the full prompt and reply. A timeline of everything Scaper did, and a comparison of any two runs of a task. |
| **Private mode** | Private scrapes, category scrapes and agent chats stay in memory only: nothing in Data, the AI log, site statistics or the activity log. Delete history by kind and age, with the database compacted afterwards. |
| **Sites & logs** | Per-site stats and rules (slower delay, mode, headers, your own cookies for sites you log in to, pause). An audit log of what Scaper did and why. |
| **Settings** | Any number of AI providers and models with routing, fallbacks, limits, budget and usage charts; privacy; scraping defaults; every alert channel with a test button; data retention, daily backups, restore; API tokens, bookmarklets and setup import/export. |

## Quick start (under 10 minutes)

Requirements: Node.js 20.9 or newer (22 LTS recommended).

```bash
npm install
npm run setup:browser   # one time: downloads the headless Chromium used by Browser mode
npm run dev             # open http://127.0.0.1:3000
```

Then, in the app:

1. **Settings → AI → Add provider**: pick a preset (or Custom), paste your key, press **Load models**, tick the models you want, **Test** one and save. Then choose the main and fast model.
2. **Quick scrape**: paste a URL → Scrape. Like the result? **Save as task**.
3. **Tasks → New task**: start from a template, press **Test run**, then **Create task** and add a schedule.
4. **Watchers → New watcher** and **Prices & deals → Track**.
5. **Settings → Alerts**: set up Telegram, email or ntfy and press **Send test**.

Press `Ctrl K` anywhere to search or jump.

Fast mode (plain HTTP) works even before you install the browser.

## Using your own AI model

Any service that speaks the OpenAI Chat Completions API works, and you can add as many as you like. Settings → AI → **Add provider** has presets:

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| Azure OpenAI | `https://YOUR-RESOURCE.openai.azure.com/openai/v1` (key sent as `api-key`) |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq, Together, DeepSeek, Mistral, xAI, Fireworks, Cerebras | their `/v1` endpoints |
| Ollama (local, free) | `http://localhost:11434/v1` |
| LM Studio (local, free) | `http://localhost:1234/v1` |
| vLLM, LiteLLM or any gateway | your server's `/v1` |

- Each provider has its own key, auth style, extra headers and timeout. Keys are stored only in the local database and never sent to the browser.
- **Load models** reads the provider's model list (with context sizes and prices where the provider gives them). **Test** checks that a model answers, supports JSON mode and calls tools.
- **Main model**: the agent, category planning and Fix with AI. Use a model with tool calling.
- **Fast model**: AI extraction, selectors, AI columns, change summaries and deal ranking.
- **Fallbacks**: up to three models tried in order when a provider is down or rate-limited.
- **Limits**: a daily request cap (default 300) and an optional monthly budget in US$. Every call is in the **AI log**.
- Page text goes to the model as untrusted data; the model never runs code, and its answers are checked against the page.

## Scraping politely (and why your IP stays healthy)

Scaper is built to look like a careful person, not a flood:

- one request at a time per site, with a gap between requests (default 5 s, with random jitter); several different sites can run at once;
- per-site rules on the Sites page can only make Scaper slower or pause a site, never faster than your default;
- respects `robots.txt` and its crawl delay;
- backs off exponentially when a site answers 429/503 or shows a bot check, and pauses that site;
- low-footprint Browser mode: one shared headless browser, images, fonts and video skipped;
- an optional single proxy you own (for example on your VPS). No proxy rotation pools.

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

## Use it from scripts

Create a token in **Settings → API & import**, then:

```bash
curl -H "Authorization: Bearer $SCAPER_TOKEN" http://127.0.0.1:3000/api/tasks
curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" "http://127.0.0.1:3000/api/tasks/<id>/run?wait=0"
```

Every route is in [docs/API.md](docs/API.md). The same page has bookmarklets ("Scrape this page", "Watch this page", "Track this price") for your browser's bookmarks bar.

## Stack

Next.js 16 (App Router, TypeScript strict), Tailwind CSS 4, SQLite via better-sqlite3, Playwright (Chromium), Cheerio, Zod, croner (cron), pixelmatch (visual diffs), nodemailer (email), Vitest. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## More docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together and why
- [docs/API.md](docs/API.md): every endpoint
- [docs/SECURITY.md](docs/SECURITY.md): threat model and protections
- [docs/RUNBOOK.md](docs/RUNBOOK.md): backups, VPS deploy, troubleshooting
- [docs/RESEARCH.md](docs/RESEARCH.md): market research and build brief
- [docs/AI_RESEARCH.md](docs/AI_RESEARCH.md): how leading tools use LLMs and what Scaper took from them
- [docs/COMPETITIVE_RESEARCH.md](docs/COMPETITIVE_RESEARCH.md): feature gaps against Apify, Browse AI, Octoparse, Visualping, Distill, Keepa and others
- [PROJECT_STATE.md](PROJECT_STATE.md): status, decisions and next steps
