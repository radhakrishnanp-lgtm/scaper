# Scaper

Scaper is a local-first web scraper, website watcher and price tracker with an AI agent that runs on **your own** OpenAI-compatible model. It runs on your computer with `npm run dev`. No cloud services, no Postgres, no Redis: everything is stored in one SQLite file.

**What it does**

| Area | What you get |
|---|---|
| **Quick scrape** | Paste a URL. Auto finds product lists, tables, structured data, links and images; Selectors gives exact columns; AI takes a plain-language description. **Pick on page** lets you click elements on a screenshot, **Build with AI** proposes selectors and tests them, and live match counts show as you type. Next pages, page actions (click, type, scroll, wait…) and screenshots. Export CSV, Excel, JSON or NDJSON. |
| **Category scrape** | Give a site and say what you want. Your AI picks the category pages from the site's menus, Scaper works out the item layout and the next-page link, and reads every category page by page. Run it once, privately, or save it as a scheduled task. |
| **Tasks** | Saved scrapes with a full editor and seven templates (listing, list → detail pages, tables, crawl a section, many inputs from a CSV, alert on new listings, AI). Start URL ranges like `/page/{1..20}`, sitemaps, crawl rules with include/exclude patterns, open each row's detail page, dedupe, 12 clean-up transforms per field, data quality checks, "new rows" and "removed rows" alerts, files and webhook output, retries, interval or cron schedules. **Test run** before saving. |
| **Operations** | One page for "is everything doing its job": success rate, an uptime strip per task, p95 run time, data score and open issues for every task, watcher response times, and failures grouped by cause across everything they affect. |
| **Health per task** | A Health tab with a 30-day strip, rows per run against the usual range Scaper learns from good runs, timings, and one alert when a task gets unhealthy (fails N times in a row, too few rows, unusually few rows, too slow) and one when it recovers. |
| **Failure reports** | Every broken run says where the problem is (the site, your setup, the data, Scaper), what it means in plain words, what the page looked like (a screenshot), and offers the one button most likely to fix it. |
| **Data checks** | Expectations per column (filled, unique, pattern, number range, one of, type, length) and per run (row count, duplicates), with "in 95% of rows". Scaper or your AI suggests them from a good run; each run gets a score; issues open when a check starts failing and resolve when it passes again. |
| **Self-repair and versions** | When a site redesign breaks the selectors, your AI proposes new ones and Scaper tests them against the last good run (rows, filled columns, same items). Prepare-and-ask or apply automatically. Every setup change (yours, the AI's, a restore) is a version with a diff and one-click rollback. |
| **Runs** | Every task run, check and refresh is a job you can watch live with progress and logs, cancel or retry. **Pause** a task run or quick scrape and **Resume** it later: it stops after the current page and carries on from the next one with the rows it already has, even after a restart. **Pause all / Resume all** for everything at once. Several sites run in parallel, each site one request at a time. |
| **Download manager** | One place for files: links you paste, a column of a task's results (images, PDFs, video files with a direct link) after every run, and files the agent finds. A few at a time, polite to each site (robots.txt and site rules included), pause, resume from where it stopped (HTTP Range), retries, size limit, a checksum, and no files overwritten. Files land in `data/downloads/<folder>`. **Find files on a site**: give it a page that lists PDFs, EPUBs, images, videos or any file type, and it follows the list's next pages and each item's own page (one or two hops) to the real download link, checks links like `/download?id=7` without downloading them, and shows the files to review, export as CSV or JSON, or download. Scaper's rules pick the links, or your AI or Firecrawl's AI does it from your instruction (each AI call is in the AI log, and each page is in the run's log). |
| **Firecrawl** | Use your Firecrawl key as a third way to load pages next to Fast and Browser. Firecrawl loads the page, Scaper reads it with your selectors or **your own** AI model. The agent and your bots get web search, Firecrawl page reads and site maps. Scaper still checks robots.txt and your site rules first. |
| **Visual browser** | A real browser inside Scaper, streamed live to the Browser page. Pick the engine: Scaper's Chromium, the Google Chrome or Microsoft Edge on your computer, or Firefox (one-click install), and optionally show it as a real window on your desktop as well. When a page does not load, a banner says why and what to do. It has tabs, address bar with search and suggestions, back, forward, reload, mouse, wheel, keyboard and paste, popups as tabs, page dialogs, and downloads handed to the download manager. **History** (search, delete one, by age or all) and **bookmarks**. **Incognito** starts a separate browser that keeps no history, cookies or notes after it closes. **Add-ons**: install Chrome extensions from a Chrome Web Store link or a .zip/.crx you upload, turn them on or off, open their options. **Annotate**: draw a box on the page and write a note; Scaper records the element under it. **Your AI sees it live**: the AI panel sends the page, your notes and the other tabs to your LLM, and the agent and bots can read, look at and act in the browser (open, click, type, choose, scroll) while you watch, with your OK first in "ask first" mode. The picture follows the size of your window, only the visible tab streams, and slow connections drop frames instead of lagging. |
| **Apify and social media** | Use your Apify token to run actors from the Apify Store as a task's source: templates for **YouTube** top videos, **Instagram** hashtag reels and profiles, **TikTok** hashtags, **X** search and **Google Maps**, or any actor by id with its example input. The items become the task's rows, so history, new-item alerts, AI columns, exports and downloads all work. Item and cost caps per run. The agent and bots can find, inspect and run actors too. |
| **Watchers** | Whole page, part of a page, price & stock, visual (screenshot pixel diff), JSON API value, RSS/Atom feed, sitemap and uptime. Rules: any change, text appears/disappears, pattern, above/below, % drop/rise, back in stock, "AI decides it matters", combined with all/any. Noise filters, active hours and days, page actions before reading, quiet period after an alert. Side-by-side or inline diff of any two checks. |
| **Prices & deals** | Track products from Amazon or any shop. Scaper builds its own price history (Keepa-style): all-time low and high, 30/90/180/365-day averages, real discount vs the shop's claimed M.R.P. discount, a deal score. Scan a listing with filters (discount, price, rating, reviews, words, sponsored), save it as a search that alerts on new matches. |
| **Changes inbox** | Every change your watchers find, in one triage inbox (keyboard: j/k, i, e, x). Your AI can mark changes important and summarize them; "Not useful" teaches the watcher which lines to ignore and becomes an example for the AI. |
| **Briefings** | A daily or weekly briefing across all watchers and tasks (filtered by tags, optional AI executive summary, skipped when quiet), sent to your channels or downloaded as a page or Markdown. |
| **Bots** | Your own agents, in the spirit of Grok's bots and ChatGPT's scheduled tasks. Each bot has a name, a role, one job and instructions; runs when you press **Run now**, every N minutes, daily at a time on chosen days, and/or when something happens (a task finishes or fails, a watcher sees a change, a price alert, new deals); and has a permission (read only, ask first, go ahead; deleting always asks). Every bot keeps **its own memory** and **grades itself** after each run (score, did it do its job, up to two lessons it keeps and reads next time, and a suggested line for its instructions you can apply); your 👍/👎 and notes on a run become lessons it follows. Every bot also keeps (facts it saves plus a summary of each run, shown to it next time, so it never sends the same alert twice), an optional "only tell me when" condition and a "stop when" end condition after which it pauses itself. It messages you on its own channels, asks for your OK on them when a change needs it, and you can chat with it on its page. Seven templates (price drop hunter, morning deal digest, task babysitter, change explainer, job board watcher, social trends scout, research assistant). The main agent can create and run bots for you. Up to 20 active bots. |
| **Alerts** | In-app inbox and desktop pop-ups, plus Telegram, email (SMTP), **WhatsApp** (Meta's Cloud API, or CallMeBot for your own number), Discord, Slack, ntfy push and webhooks (n8n, Make, Zapier, Home Assistant). **Where each alert goes** sends each kind of alert (task finished, task needs attention, new rows, watcher change, price alert, new deals, bot messages, bot needs your OK) to the channels you pick, or to all of them. Quiet hours, mute all, failure alerts. |
| **Learns Scaper and itself** | When you connect your AI, the agent gets a guide to the whole app in every request (pages, every tool, how-tos, rules, your current set-up, an A to Z), built from the app itself so new features appear on their own; `app_guide` reads any topic in full. It keeps its own Markdown notes (site quirks, selectors that worked, procedures, lessons), saved in the database and as `.md` files in `data/knowledge`, and reads them before related jobs. After each job it reviews its own work (score 1 to 5, what went wrong, one lesson) and sees its lessons next time. Helpers read the guide and notes too. **Agent → Knowledge** shows all of it; you can add or edit notes. |
| **Easy set-up** | Add any OpenAI-compatible provider (OpenAI is the default; pasting an OpenRouter, Anthropic, Groq, Gemini or xAI key picks its address), press **Test connection** to check the key, model and tool calling before saving, and set context windows up to 1M or 2M tokens. Install the scraping browser with one click on the dashboard or in Settings, or use the Chrome, Edge or Brave already on your computer. |
| **Agent team** | The agent is a supervisor. For bigger jobs it starts 2 to 5 helper agents, writes each one's instructions, task, examples and decision questions, and waits for their reports. Helpers run at the same time with their own browser, read-only tools, a shared memory for the whole team and the decision model (text plus a page screenshot). You see every helper, its instructions, steps, cost and report under the answer, and can stop one. Instructions that worked are saved as **playbooks**, versioned and rated after each use, so the best ones are picked first next time; you can edit them too. |
| **Decision model** | Connect a decisions model through OpenRouter (for example `openai/gpt-6-luna-decisions`). It answers yes/no, pick-one and rating questions with probabilities, so Scaper can score every link on a page for what you want (category scrapes pick their categories this way), check a page before you scrape it (robots.txt and page rules first, then personal data, members-only content, page kind and "does it have what I asked for"), and double-check the agent's changes. Hard rules always win; the model can only add caution. The **Decisions** page has the scrape check, the link scorer and a playground with recipes, form and JSON editing and a threshold. |
| **Network and VPN** | A VPN on your computer covers Scaper as is. If your VPN app or office gives you a proxy, set one HTTP, HTTPS or SOCKS5 proxy, choose whether AI calls use it too, and test the route from Settings → Scraping. Scaper keeps identifying itself, following robots.txt and its delays either way. |
| **Integrations** | An MCP server so Claude Code, Claude Desktop, Cursor and other AI apps can use Scaper's tools (read-only unless you allow changes). Named webhook endpoints with per-event subscriptions, HMAC signatures, retries with backoff, a delivery log and redeliver. Google Sheets sync per task (replace, append or update rows by key) with a service account. |
| **Data grid** | Typed columns, per-column stats and filters (values, ranges, empty), pin, resize, hide, saved views per task, virtual scrolling for 100 000 rows, a row drawer, copy for Excel and export. |
| **AI agent** | Ask in plain words. It has over 70 tools: read and extract pages, its own browser (click, type, choose, scroll), your visual browser (read the page and your notes, act in it while you watch), map a site, plan category scrapes, create and schedule tasks, compare runs, watchers, prices and deals, memory, web search and Firecrawl pages, Apify actors, downloads, and pausing or resuming runs. It asks before changing anything (or not, if you say so), shows every step, takes follow-ups, and runs on any model you choose. |
| **AI log & history** | Every model call with tokens, cost, time and the full prompt and reply. A timeline of everything Scaper did, and a comparison of any two runs of a task. |
| **Private mode** | Private scrapes, category scrapes and agent chats stay in memory only: nothing in Data, the AI log, site statistics or the activity log. Delete history by kind and age, with the database compacted afterwards. |
| **Sites & logs** | Per-site stats and rules (slower delay, mode, headers, your own cookies for sites you log in to, pause). An audit log of what Scaper did and why. |
| **Settings** | Any number of AI providers and models with routing, fallbacks, limits, budget and usage charts; privacy; scraping defaults; every alert channel with a test button; data retention, daily backups, restore; API tokens, bookmarklets and setup import/export. |

## Quick start (under 10 minutes)

Requirements: Node.js 20.9 or newer (22 LTS recommended).

```bash
npm install
npm run setup:browser   # optional: or press "Install browser" in the app, or pick Chrome/Edge in Settings → Scraping
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
| `SCAPER_GOOGLE_TOKEN_URL` · `SCAPER_SHEETS_API_URL` | Google's | Override the Google endpoints (tests, corporate proxies) |
| `SCAPER_APIFY_URL` | `https://api.apify.com/v2` | Override the Apify API (tests). Firecrawl's server is a setting in Integrations → Firecrawl |

## Use it from scripts

Create a token in **Settings → API & import**, then:

```bash
curl -H "Authorization: Bearer $SCAPER_TOKEN" http://127.0.0.1:3000/api/tasks
curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" "http://127.0.0.1:3000/api/tasks/<id>/run?wait=0"
```

Every route is in [docs/API.md](docs/API.md). The same page has bookmarklets ("Scrape this page", "Watch this page", "Track this price") for your browser's bookmarks bar.

## Decision model (OpenRouter)

1. Settings → AI → Add provider → OpenRouter, paste your key.
2. In **Decision model**, turn it on, pick that provider and keep or change the model id. The endpoint `https://openrouter.ai/api/alpha/decisions` is worked out from the provider's URL.
3. Press **Test it**, then try it on the **Decisions** page.

Calls count against the same daily limit and monthly budget as your other AI calls and show in the AI log as "Decision: …".

## Firecrawl and Apify

1. **Integrations → Firecrawl**: paste your key (`fc-…`), Save, Test. Then pick **Firecrawl** as the fetch mode in a task or quick scrape.
2. **Integrations → Apify**: paste your API token (Apify Console → Settings → API & Integrations), set the cost cap for runs started by the agent and bots, Save, Test. Search the Store there, or go to **Tasks → New task → Apify actor** and start from a social media template.
3. To keep the videos' thumbnails or files, open the task's **Alerts & output** tab → **Download files** and pick the column with the links.

Both services bill your own account. Scaper never asks Firecrawl for its stealth proxies, and an actor's results are treated as data, never as instructions to the AI. Collect public data only and respect each platform's terms and creators' rights.

## Connect AI apps (MCP)

Scaper answers MCP at `/api/mcp` (Streamable HTTP). Create a token in **Settings → API & import**, then for Claude Code:

```bash
claude mcp add --transport http scaper http://127.0.0.1:3000/api/mcp --header "Authorization: Bearer scp_…"
```

Apps that only start local servers (Claude Desktop) use the bridge: `SCAPER_URL=http://127.0.0.1:3000 SCAPER_TOKEN=scp_… node scripts/scaper-mcp.mjs`. **Integrations → MCP** has copy-ready snippets, a test button and the list of tools. Tools that change things are off until you turn on "Allow changes".

## Stack

Next.js 16 (App Router, TypeScript strict), Tailwind CSS 4, SQLite via better-sqlite3, Playwright (Chromium), Cheerio, Zod, croner (cron), pixelmatch (visual diffs), nodemailer (email), Vitest. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## More docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together and why
- [docs/API.md](docs/API.md): every endpoint
- [docs/SECURITY.md](docs/SECURITY.md): threat model and protections
- [docs/RUNBOOK.md](docs/RUNBOOK.md): backups, VPS deploy, troubleshooting
- [docs/RESEARCH.md](docs/RESEARCH.md): market research and build brief
- [docs/AI_RESEARCH.md](docs/AI_RESEARCH.md): how leading tools use LLMs and what Scaper took from them
- [docs/ENTERPRISE_RESEARCH.md](docs/ENTERPRISE_RESEARCH.md): what enterprise scraping and monitoring platforms offer in 2026, and the gaps this release closed
- [docs/COMPETITIVE_RESEARCH.md](docs/COMPETITIVE_RESEARCH.md): feature gaps against Apify, Browse AI, Octoparse, Visualping, Distill, Keepa and others
- [PROJECT_STATE.md](PROJECT_STATE.md): status, decisions and next steps
