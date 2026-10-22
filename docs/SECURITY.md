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
| Clickjacking etc. | `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy | `next.config.ts` |

## AI and private mode

| Concern | What Scaper does | Where |
|---|---|---|
| Provider keys | Stored in the local database only; the browser sees `••••last4`. Header values named like key/token/auth/secret/cookie are masked too. A masked value sent back means "keep the saved one" | `repo/settings.ts` |
| Prompt injection | Page text is wrapped as untrusted data with an instruction to ignore what it says; tools that change things wait for your OK in "Ask me first" mode (the default) | `ai/extract.ts`, `ai/agent.ts` |
| Model output | Never executed. Selectors are tested with a static parser; extracted values are type-checked and compared with the page | `ai/suggest.ts`, `ai/extract.ts` |
| Agent browser | Every navigation, including where a click lands, passes the same checks as a scrape (public address, robots.txt, site pause, backoff, polite delay). Bot checks stop the session. Passwords are never typed; downloads are off; 40 actions per request | `ai/browser-session.ts` |
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
- Content-Security-Policy is not set yet because Next.js dev mode needs inline scripts; add a nonce-based CSP before public hosting (tracked in PROJECT_STATE.md).
