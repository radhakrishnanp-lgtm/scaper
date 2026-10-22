# PROJECT_STATE

## Summary
Scaper: local-first scraper, website watcher, price tracker and bring-your-own-LLM agent for one person's own use. Next.js 16 + SQLite + Playwright. Run with `npm run dev`.

## Stage and targets
Personal use on your own machine ("enterprise level" features, not a public release). VPS-ready with password login and API tokens. Targets: API reads under 300 ms locally (✅ observed 5–40 ms), RPO 24 h via the built-in daily backup (copy `data/backups/` off the machine for disk failure).

## Assumptions
- "jev model" was read as a fast/cheap model for quick tasks, so there is a separate **Fast model** setting.
- "Stealth" means polite, low-footprint scraping that avoids bans, not bypassing bot protection. No CAPTCHA solving, fingerprint spoofing or proxy rotation pools.
- "Without the server" means no cloud services: everything runs locally in one process.
- "Stealth model, no trace" was read as **private mode**: nothing about private work is kept on this computer. Scaper still identifies itself to websites and scrapes politely; hiding from sites is out of scope.
- "Full control and the correct context" was read as: the agent gets 40 tools including its own browser, page text arrives as clean Markdown with numbered links sized to the model, and changes wait for your OK by default.
- "Enterprise level" for private use was read as: the features of Apify, Browse AI, Octoparse, Visualping/Distill and Keepa that matter for one person, plus operations (jobs, logs, backups, tokens), not multi-user accounts or billing.

## Decision log
| Decision | Reason |
|---|---|
| Next.js 16 full-stack, scheduler via `instrumentation.ts` | One command runs everything |
| SQLite (better-sqlite3) behind `src/server/repo` | No DB server now; swappable later |
| Durable job queue in SQLite | One place for progress, logs, cancel, retry and crash recovery; no Redis |
| Playwright Chromium + undici fast mode | JS-heavy and light pages both covered |
| Own price history for deal scores | Store M.R.P. is often inflated |
| No CAPTCHA solving, fingerprint spoofing or proxy pools | ToS, legality and ban risk; stop-and-back-off instead |
| No "run JavaScript" page action; AI selectors tested with a static parser | Never execute model output or page-supplied code |
| SSE for live alerts | Simple, one-way, no extra server |
| Same-origin + Host checks in proxy, hashed `scp_` API tokens | Protects a localhost app from malicious websites while allowing scripts |
| Site rules can only slow Scaper down | Keeps the polite defaults the floor for every site |
| Many providers, OpenAI-compatible only | One protocol covers cloud, gateways and local models; legacy single-provider settings migrate to a provider called "default" |
| Agent changes need approval by default | Prompt injection from a page cannot make changes without you seeing them |
| Private work in memory (AsyncLocalStorage context) | One flag covers every write path (runs, jobs, AI log, stats, audit) without a second database |
| Link prefetch off | Prefetching every route crowded out API calls on the browser's 6-connection limit (found in the walkthrough: saves took 7 s) |

## Status (13 layers)
| Layer | Status |
|---|---|
| Frontend | ✅ 24 pages with loading/empty/error states, light/dark, phone width, command palette (Ctrl K), URL-kept tabs and filters |
| APIs | ✅ 80 route files, Zod validation, one error format with request id and field errors, rate limits, Bearer tokens |
| Database | ✅ 5 numbered migrations (AI log, cache, memory), `secure_delete`, indexes, retention pruning every 6 h |
| Auth | ✅ optional password (signed cookie) + API tokens; ➖ multi-user not needed |
| Hosting | ⏳ VPS steps documented in RUNBOOK |
| Compute / jobs | ✅ job queue with concurrency, per-site turns, cancel/retry, crash recovery; scheduler with leases; interval or cron |
| CI/CD | ✅ `.github/workflows/ci.yml` (typecheck, lint, tests, build, audit); runs once pushed to GitHub |
| Security | ✅ see docs/SECURITY.md (red-team checks re-run this round); ⏳ nonce-based CSP before public hosting |
| Rate limiting | ✅ per endpoint + per host + AI daily cap |
| Caching | ➖ local app; static assets cached by Next.js |
| Scaling | ⏳ worker process + Postgres when needed |
| Observability | ✅ JSON logs, Logs page (audit log), per-job logs, Sites stats, health endpoint with version |
| Recovery | ✅ daily backups with retention, download, restore steps, setup export/import, JSON export |

## Tests
`npm test`: 133 tests across 10 files. New this round (`tests/ai-gateway.test.ts`): per-provider keys and headers, fallback on outage, JSON-mode adaptation, cache, monthly budget, secret masking, legacy migration, page context, typed AI extraction with link references and grounding, category plan and run, private mode leaving no rows, timeline and wipe. Earlier: extraction, task engine (pagination, detail pages, crawl, inputs, quality, new/removed rows), watchers (all target types, rules, noise filters, visual diff), deals and scores, politeness (robots.txt, backoff, bot-check stop, SSRF guard), AI (agent tool loop, follow-ups, stop, Build with AI, daily cap) against a mock OpenAI-compatible server, ops (tokens, backups, config import/export, secret masking), and the line diff.

A full browser walkthrough was run with Playwright against a local fixture site and a mock model (`/tmp` scripts, not in the repo): every page, the main flows end to end, phone width (390 px) and dark mode. Bugs it found and that are fixed: auto mode showing a 1-item structured-data list before the 5-card list; duplicate job log lines from overlapping polls; channel test errors returning 500 instead of a clear message; proxy errors not shown on the field; bookmarklets blocked by React's `javascript:` URL guard; charts scaling their text down to unreadable sizes in narrow cards; broken product images showing alt text; duplicate tab element ids when a dialog has its own tabs; site rules able to make a site faster than the default; "1 rows"/"1 checks" wording and uneven discount decimals; health check missing the version.

The AI upgrade was walked through the same way (18 flows: provider setup with Load models and Test, routing and fallbacks, memory, privacy wipe, category plan and run, save as task, agent approval, private agent chat, AI log transcript, timeline, Fix with AI, run compare, task AI columns, AI extract columns, private-mode indicator, phone width). Bugs it found and that are fixed: small pages lost their headings in the model's context; the capability test marked models "no tools" when they simply chose not to call the test tool; saves stalling behind route prefetching; selector inputs too narrow on the category plan.

## Known issues / not verified
- Not tested against live Amazon or other public sites from the build environment (its network blocks outside sites). Amazon selectors follow Amazon's current public markup and may need updates when Amazon changes its layout.
- Email, Telegram, Discord, Slack and ntfy were tested for their error paths and payloads, not against the real services.
- Desktop notifications appear only while a Scaper tab is open.
- The AI features were tested against a mock OpenAI-compatible server, not real providers. Providers differ in small ways; the client adapts to the common ones (JSON mode, `max_completion_tokens`, temperature), and **Test** shows what a model supports.
- Editing the model routing while a provider save is still in flight can be overwritten by the save's result.

## Next steps (in order)
1. Connect a GitHub repo and push (CI file is ready).
2. Google Sheets export for tasks.
3. Amazon Creators API integration (needs an Associates account).
4. Nonce-based CSP, then VPS deploy behind Caddy.
