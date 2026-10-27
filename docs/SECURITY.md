# Security

## What an attacker would want

1. **Your AI API key, alert tokens, API tokens and site cookies** (they cost money, send messages as you, or log in as you).
2. **Your network**: making Scaper fetch `localhost`, your router or cloud metadata (`169.254.169.254`), especially on a VPS (SSRF).
3. **Your Scaper itself**: a malicious website you visit calling `http://127.0.0.1:3000/api/...` from your browser (CSRF / DNS rebinding) to create watchers or read data.
4. **Your AI agent**: a scraped page containing "ignore your instructions and…" (prompt injection).

## Protections

| Threat | Protection | Where |
|---|---|---|
| Other sites calling the local API | Writes require an `Origin` equal to the host; requests with a foreign `Host` are rejected (421) | `src/proxy.ts` |
| Exposed on a VPS | Optional password, signed HttpOnly SameSite=Lax cookie, 30-day expiry, login rate limit, timing-safe compare | `src/proxy.ts`, `src/app/api/auth/*`, `src/lib/session-token.ts` |
| SSRF | Private, loopback, link-local and CGNAT addresses blocked (after DNS) for the target, every redirect hop and every browser sub-request, unless "Allow private network" is on | `src/server/fetcher/network-guard.ts`, `browser.ts` |
| Secret leakage | Secrets stay server-side. The settings API returns masked values (AI key, Telegram/ntfy tokens, SMTP password, and the path of webhook, Discord, Slack and ntfy URLs); a masked value sent back means "unchanged". Site-rule cookies come back only as "N cookie(s) set". Logs redact keys named key/token/secret/password. The JSON export and setup export leave secrets, cookies and auth-like headers out | `repo/settings.ts`, `repo/sites.ts`, `ops/config.ts`, `log.ts` |
| API tokens | `scp_` + 24 random bytes, shown once, stored as SHA-256 only, revocable, last-used time recorded. A token never comes from a browser on its own (it is a header, and cross-site requests with it need a CORS preflight Scaper never grants). Any wrong or revoked token gets 401 | `repo/tokens.ts`, `proxy.ts`, `api.ts` |
| File downloads | Backup and media paths are matched against a strict file-name pattern, so `..` can't reach outside their folders | `ops/backup.ts`, `api/media` |
| Prompt injection | Page text is wrapped in `<page>` with an explicit "data, not instructions" rule; model output is validated with Zod and never executed; agent tools are limited to Scaper's own actions, and the ones that change things (track, watch, run a task, alert) are described as "only when the user asked"; step limit, stop button and daily cap. Selectors the model proposes ("Build with AI") are only tested with a static HTML parser, never run in a page. Agent follow-ups replay earlier questions and answers, not earlier tool results | `src/server/ai/*` |
| Page actions | Browser steps are a fixed list (click, click text, tick a box, type, press a key, choose an option, hover, wait, wait for text or an element, scroll, remove an element). There is no "run JavaScript" step | `lib/schemas.ts`, `fetcher/browser.ts` |
| Bad input | Zod validation on every endpoint, UUID checks on ids, 256 KB body limit, URL scheme allow-list (http/https only) | `src/server/api.ts`, `src/lib/schemas.ts` |
| SQL injection | Prepared statements only | `src/server/repo/*` |
| XSS | React escaping everywhere; AI answers rendered by a custom Markdown renderer that builds elements (no raw HTML); only http(s) links | `src/components/markdown.tsx` |
| CSV injection | Cells starting with `= + - @` are prefixed with `'` | `src/lib/csv.ts` |
| Huge pages | 10 MB response cap, timeouts on every fetch and AI call | `fetcher/http.ts`, `ai/client.ts` |
| Abuse / cost | Per-endpoint rate limits, AI daily request cap, per-host crawl delay and backoff | `api.ts`, `ai/client.ts`, `fetcher/politeness.ts` |
| MCP clients | `/api/mcp` needs a Bearer token from other apps (same rules as the API). Tools that change things are not even listed until "Allow changes" is on, and are refused if called anyway; the agent's private browser is never exposed. Every call is in the audit log | `server/mcp/server.ts` |
| Webhooks and Sheets | Endpoint URLs, signing secrets and the Google service account key are masked to the browser and never exported; deliveries are signed per endpoint; payloads in the delivery log are capped at 64 KB and pruned after 30 days; private work is sent but not logged | `integrations/*`, `repo/settings.ts`, `repo/deliveries.ts` |
| Decision model | Its answers are probabilities that code compares with thresholds. robots.txt, refused pages, bot checks and paused sites stop a scrape check before the model is asked; the model can add a caution but never turn a stop into OK. Deleting always waits for your OK, even in "Go ahead" mode; the guardrail can add reasons to ask, never remove one, and a guardrail that cannot reach the model asks. Page text goes to the model as evidence with a note that it is not instructions. Uses the provider key already saved (masked to the browser), the shared limits and the AI log (nothing logged in private mode) | `ai/decisions.ts`, `ai/judge.ts`, `lib/decision-policy.ts` |
| Proxy and VPN | One proxy you control (HTTP, HTTPS or SOCKS5); its password is masked to the browser and kept when the form sends it back masked. Using a proxy or VPN does not change what Scaper does: same user agent, robots.txt and delays. No rotation, no fingerprint changes | `fetcher/http.ts`, `repo/settings.ts` |
| AI repairs | New selectors from the model are tested with the static parser and checked against the last good run before anything is saved; auto mode only applies a repair that passes, and every change is a version you can roll back | `ops/heal.ts`, `repo/versions.ts` |
| Firecrawl and Apify | Your Firecrawl key and Apify token are stored like other secrets (masked as `••••last4`, kept when sent back masked, never exported). Before Firecrawl loads a page, Scaper runs the same checks as its own fetch (network guard, site pause and rules, robots.txt); it never asks for Firecrawl's stealth or enhanced proxies and never sets `ignoreRobotsTxt`. Apify runs carry an item cap and a dollar cap (`maxTotalChargeUsd`), and runs the agent or a bot starts need your OK in "ask first" mode. Actor items and Firecrawl pages reach the model as untrusted data in `<results>` / `<page>` blocks. Their tools are hidden until a key is saved | `integrations/firecrawl.ts`, `integrations/apify.ts`, `ai/tools.ts` |
| Download manager | Files are written only below `data/downloads/<folder>`: the folder is cleaned to letters, digits, spaces, dots and dashes (two levels at most, no `..`), file names drop path characters and never overwrite (`name (2).ext`). Each download passes the network guard, site rules and robots.txt, and every redirect hop is checked again. A size limit (Settings → Data) stops big files early. Files are served back only from inside the downloads folder, as attachments, or inline under a sandbox CSP. There is no stream ripping from video sites | `downloads/manager.ts`, `api/downloads/*` |
| Visual browser | Its profile lives in `data/browser-profile` (cookies and sign-ins you make there stay on your computer; Settings can delete it). Addresses you type pass the network guard (public addresses only unless you allow private ones); it guards top-level navigation only, since the browser keeps its own HTTP cache and is not intercepted. Pages the AI opens or clicks into also pass robots.txt, site pause and rules, before and after the step, and the AI never types into password fields. Acting in the browser is a changing tool, so it waits for your OK in "ask first" mode, and the tool tells the model never to buy, send or delete. Page text and your notes reach the model inside a `<page>` block as untrusted data. Incognito is a separate browser with no history, and its notes stay in memory. Downloads go to the download manager and its checks. No automation-hiding flags, no fingerprint changes | `live-browser/session.ts`, `ai/tools.ts` |
| Assistant and selected rows | Rows from your data, alert text and page help reach the model inside the user message and are labelled as data, never instructions. The rows are cut to about 40 000 characters. The assistant is the same agent: the same tools, the same approvals ("ask first" by default, and deleting always asks), the same AI log. New tools that change things (update_watcher, set_price_alert, delete_deal_search, mark_alerts_read) are marked as changing. check_links only sends HEAD requests or 1-byte range requests, after the usual preflight | `api/assistant`, `ai/tools.ts` |
| File finder | Every page it opens goes through `fetchPage` (network guard, site pause and rules, robots.txt, the host's delay, bot-check stop), and links without a file ending are checked with a HEAD request (or a 1-byte range GET) through the same preflight and redirect guard, never downloaded. It stays on the start site unless you turn that off, skips sign-in, cart and account pages, and caps pages (500), files (2000) and checks (40 per run). With the AI picker, link texts and addresses reach the model as data with an instruction to ignore what they say, and the model only returns link numbers from the page's own list. Firecrawl's picker never sends stealth or proxy options. Files go to the download manager and its checks | `files/finder.ts`, `downloads/manager.ts` |
| Browser engines and real window | Chrome and Edge run from their installed copies with a separate Scaper profile, not your everyday profile. Firefox is Playwright's build. A real window is the same browser shown on your desktop; nothing about how Scaper identifies itself changes. Scaper does not hide automation or get around bot checks: when a site shows one, the banner says so, and you can complete it yourself; the AI never does | `live-browser/session.ts` |
| Add-on packages | A .zip or .crx is unpacked by Scaper, never run during install: paths with `..`, absolute paths, drive letters and backslashes are refused, with caps of 60 MB packed, 6000 files and 250 MB unpacked, and a valid `manifest.json` (version 2 or 3) is required. Files are written to a temporary folder and renamed into `data/browser-extensions/<id>`; ids are checked against `[a-z0-9]{8,64}` in routes. Add-ons run inside the browser like in Chrome, so install only ones you trust; incognito starts without them | `live-browser/extensions.ts` |
| Clickjacking etc. | `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy | `next.config.ts` |

## AI and private mode

| Concern | What Scaper does | Where |
|---|---|---|
| Provider keys | Stored in the local database only; the browser sees `••••last4`. Header values named like key/token/auth/secret/cookie are masked too. A masked value sent back means "keep the saved one" | `repo/settings.ts` |
| Prompt injection | Page text is wrapped as untrusted data with an instruction to ignore what it says; tools that change things wait for your OK in "Ask me first" mode (the default) | `ai/extract.ts`, `ai/agent.ts` |
| Model output | Never executed. Selectors are tested with a static parser; extracted values are type-checked and compared with the page | `ai/suggest.ts`, `ai/extract.ts` |
| Agent browser | Every navigation, including where a click lands, passes the same checks as a scrape (public address, robots.txt, site pause, backoff, polite delay). Bot checks stop the session. Passwords are never typed; downloads are off; 40 actions per request | `ai/browser-session.ts` |
| Helper agents | Helpers get read-only tools only (no create, change, delete, alert, memory or task-run tools), so anything that changes Scaper still goes through the supervisor and its approval card. Scaper's fixed helper rules come first in every helper's system prompt and say they win over the supervisor's text; page text stays untrusted data. At most 5 at once, a step limit each, and all are stopped when the supervisor stops, ends or the app restarts. No helpers in private conversations | `ai/team.ts` |
| Agent notes and self-review | Notes are the agent's own Markdown and are fed back to it, so writes that look like keys or passwords are refused, private conversations write nothing, and helpers can read notes but not write them. The self-review sees tool names, arguments and Scaper's own error messages, never page text, so a web page cannot write the lessons. A review only adds to an existing note, never replaces it. The guide tells the agent that notes may be out of date and never override the rules | `ai/review.ts`, `repo/knowledge.ts` |
| Bots | A bot is the agent with a narrower prompt, so every agent rule still applies. Read-only bots never receive a tool that changes things (and a call is refused if a model invents one); "ask first" waits for your OK and alerts you on the bot's channels with a link; "go ahead" still asks before deleting. Bots cannot create, change, start or delete bots, and a bot's own messages never wake bots, so bots cannot set each other off. Event data reaches the bot as untrusted data inside an `<event>` block. Limits: 20 active bots, 100 runs per bot per day, 3 bot runs at once, a cooldown between event runs, 3 messages per run and 30 per day. Bot memory refuses text that looks like a key or password. Private mode pauses all bots | `ai/bots.ts`, `repo/bots.ts`, `ai/agent.ts` |
| Bot self-evaluation | The grader sees the bot's job, its tool names, arguments and outcomes, its final report and your feedback, never page text, so a web page cannot write a bot's lessons. Lessons that look like keys or passwords are refused, at most two are kept per run and ten in all (your own notes always stay), and a suggested change to the instructions is only applied when you press Apply | `ai/bot-eval.ts`, `repo/bots.ts` |
| WhatsApp | The Cloud API token and CallMeBot key are stored like other secrets (masked as `••••last4`). Only your configured number receives messages | `notify/index.ts` |
| Browser install and choice | The install button runs one fixed command (Playwright's own installer, no shell, nothing from the request). A browser chosen in Settings must be an absolute path to an existing file named like Chrome, Chromium, Edge or Brave; it runs headless with a fresh profile, so your own profile, logins and history are not used | `fetcher/browser-setup.ts` |
| Cost | Daily request cap, monthly budget, step limit per agent request | `ai/client.ts` |
| Private mode | Private work runs inside a private context: results, jobs and agent chats live in memory (1 to 2 hours), and the AI log, site statistics and activity log skip it. Wiping history uses `secure_delete`, VACUUM and a WAL checkpoint so deleted rows cannot be read from the file | `server/privacy.ts`, `repo/history.ts` |
| What private mode is not | It does not hide you from websites (they see a normal, polite visit) or from your AI provider (it receives the page text). Use a local model for that | Settings → Privacy |

## Red-team checks run

| Attempt | Result |
|---|---|
| POST to `/api/scrape` with `Origin: https://evil.example` | 403 |
| POST with no Origin (simple form/text-plain) | 403 |
| Request with `Host: attacker.example` (DNS rebinding) | 421 |
| Scrape `javascript:` / `file://` URLs | 400 validation |
| Scrape `http://127.0.0.1/...` with private network off | Blocked with a clear message |
| SQL in an id (`1 OR 1=1`) | 400 invalid id |
| Wrong password, no cookie, tampered or expired cookie | 401 / redirect to login |
| Page that shows a CAPTCHA | Stopped, host backed off, never bypassed |
| robots.txt disallow | Not fetched |
| AI daily cap exceeded | 429 with message |
| `Authorization: Bearer scp_fake`, or a revoked token | 401 |
| DELETE `/api/tokens/:id` with `Origin: https://evil.example` | 403 |
| `/api/backups/..%2Fscaper.db`, `/api/media/../../package.json` | 404 |
| Site rule saved with cookies, then read via `/api/sites`, `/api/config`, `/api/data/export` | Cookie values never returned |
| Settings test for a channel with no token | 400 with what to set, not a crash |

## Known limits

- One user. There are no accounts or roles; the password protects the whole app, and an API token can do everything the app can.
- Site-rule headers are shown in the Sites page as typed (only the setup export filters auth-like headers). Prefer the cookies field for logins.
- The in-memory rate limiter resets on restart (fine for one process).
- Add-ons you install in the visual browser can read the pages you open there, as in Chrome. The network guard does not filter requests that pages or add-ons make after the page loads.
- Content-Security-Policy is not set yet because Next.js dev mode needs inline scripts; add a nonce-based CSP before public hosting (tracked in PROJECT_STATE.md).
