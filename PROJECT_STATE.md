# PROJECT_STATE

## Summary
Scaper: local-first scraper, website watcher, price tracker and bring-your-own-LLM agent. Next.js 16 + SQLite + Playwright. Run with `npm run dev`.

## Stage and targets
Personal "Launch" quality for a single user on their own machine; VPS-ready with password login. Targets: API reads under 300 ms locally (✅ observed 5–40 ms), Lighthouse 90+ (To verify), RPO 24 h via daily backup on a VPS (see RUNBOOK).

## Assumptions
- "jev model" was read as a fast/cheap model for quick tasks, so there is a separate **Fast model** setting used for ranking, change checks, simple extraction and the agent's fast mode.
- "Stealth" was read as low-footprint, polite scraping that avoids bans, not bypassing bot protection.
- "Without the server" was read as no cloud services: everything runs locally in one process.
- Single user; no accounts. Password login is optional and meant for a VPS.

## Decision log
| Decision | Reason |
|---|---|
| Next.js 16 full-stack, scheduler via `instrumentation.ts` | One command runs everything |
| SQLite (better-sqlite3) behind `src/server/repo` | No DB server now; swappable later |
| Playwright Chromium + undici fast mode | JS-heavy and light pages both covered |
| Own price history for deal scores | Store M.R.P. is often inflated |
| No CAPTCHA solving or fingerprint spoofing | ToS, legality and ban risk; stop-and-back-off instead |
| SSE for live alerts | Simple, one-way, no extra server |
| Same-origin + Host checks in proxy | Protects a localhost app from malicious websites |

## Status (13 layers)
| Layer | Status |
|---|---|
| Frontend | ✅ all pages, loading/empty/error states, light/dark, mobile |
| APIs | ✅ Zod validation, error format with request id, rate limits |
| Database | ✅ migrations, indexes, retention pruning |
| Auth | ✅ optional password (signed cookie); ➖ multi-user not needed yet |
| Hosting | ⏳ VPS steps documented in RUNBOOK |
| Compute / jobs | ✅ in-process scheduler with leases and backoff |
| CI/CD | ⏳ GitHub Actions once a repo is connected (`npm run check`) |
| Security | ✅ see docs/SECURITY.md; ⏳ nonce-based CSP before public hosting |
| Rate limiting | ✅ per endpoint + per host + AI daily cap |
| Caching | ➖ local app; static assets cached by Next.js |
| Scaling | ⏳ worker process + Redis + Postgres when needed |
| Observability | ✅ JSON logs, audit log, health endpoint; ⏳ Sentry when hosted |
| Recovery | ✅ backup/restore documented; JSON export |

## Tests
`npm test`: 58 tests (parsers, diff, rules, deal score, robots.txt, bot-check stop, SSRF guard, charset decoding, session tokens, CSV, integration with a local fixture site in fast and browser mode, agent tool loop against a mock OpenAI-compatible server, AI daily cap). A full UI click-through was run with Playwright.

## Known issues / not verified
- Not tested against live Amazon or other public sites from the build environment (its network blocks outside sites). Amazon selectors follow Amazon's current public markup and may need updates when Amazon changes its layout.
- Desktop notifications appear only while a Scaper tab is open.

## Next steps (in order)
1. Connect a GitHub repo, push, add CI (`npm run check`).
2. Visual element picker on a screenshot to build selectors by clicking.
3. Scheduled recipe runs with CSV/Google Sheets export.
4. Amazon Creators API integration (needs an Associates account).
5. Nonce-based CSP, then VPS deploy behind Caddy.
