# Security

## What an attacker would want

1. **Your AI API key and Telegram token** (they cost money / send messages as you).
2. **Your network**: making Scaper fetch `localhost`, your router or cloud metadata (`169.254.169.254`), especially on a VPS (SSRF).
3. **Your Scaper itself**: a malicious website you visit calling `http://127.0.0.1:3000/api/...` from your browser (CSRF / DNS rebinding) to create watchers or read data.
4. **Your AI agent**: a scraped page containing "ignore your instructions and…" (prompt injection).

## Protections

| Threat | Protection | Where |
|---|---|---|
| Other sites calling the local API | Writes require an `Origin` equal to the host; requests with a foreign `Host` are rejected (421) | `src/proxy.ts` |
| Exposed on a VPS | Optional password, signed HttpOnly SameSite=Lax cookie, 30-day expiry, login rate limit, timing-safe compare | `src/proxy.ts`, `src/app/api/auth/*`, `src/lib/session-token.ts` |
| SSRF | Private, loopback, link-local and CGNAT addresses blocked (after DNS) for the target, every redirect hop and every browser sub-request, unless "Allow private network" is on | `src/server/fetcher/network-guard.ts`, `browser.ts` |
| Secret leakage | Secrets stay server-side; API returns masked values; logs redact keys named key/token/secret/password; exports mask secrets | `repo/settings.ts`, `log.ts` |
| Prompt injection | Page text is wrapped in `<page>` with an explicit "data, not instructions" rule; model output is validated with Zod and never executed; agent tools are limited to Scaper's own safe actions; step limit and daily cap | `src/server/ai/*` |
| Bad input | Zod validation on every endpoint, UUID checks on ids, 256 KB body limit, URL scheme allow-list (http/https only) | `src/server/api.ts`, `src/lib/schemas.ts` |
| SQL injection | Prepared statements only | `src/server/repo/*` |
| XSS | React escaping everywhere; AI answers rendered by a custom Markdown renderer that builds elements (no raw HTML); only http(s) links | `src/components/markdown.tsx` |
| CSV injection | Cells starting with `= + - @` are prefixed with `'` | `src/lib/csv.ts` |
| Huge pages | 10 MB response cap, timeouts on every fetch and AI call | `fetcher/http.ts`, `ai/client.ts` |
| Abuse / cost | Per-endpoint rate limits, AI daily request cap, per-host crawl delay and backoff | `api.ts`, `ai/client.ts`, `fetcher/politeness.ts` |
| Clickjacking etc. | `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy | `next.config.ts` |

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

## Known limits

- One user. There are no accounts or roles; the password protects the whole app.
- The in-memory rate limiter resets on restart (fine for one process).
- Content-Security-Policy is not set yet because Next.js dev mode needs inline scripts; add a nonce-based CSP before public hosting (tracked in PROJECT_STATE.md).
