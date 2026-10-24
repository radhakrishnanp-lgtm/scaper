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
| Health alerts once per problem, only for scheduled/API runs | No alert storms; manual runs update state without paging you |
| Self-repair tested against the last good run, 6 h cooldown, versioned | An AI fix is never applied blind; anything it changes can be rolled back |
| Decision model can only add caution | Probabilities are estimates; hard rules (robots.txt, refusals, deleting asks) must not depend on them |
| Deleting by the agent always asks | Irreversible; matches the guardrail spec even in "Go ahead" mode |
| Decision endpoint derived from the OpenRouter base URL | One key, one provider entry; override field for other hosts |
| MCP write tools gated by "Allow changes" | MCP apps have no approval card like the built-in agent |
| Old webhook event names kept (`scaper.watcher` …) | Existing receivers keep working |
| Helpers are read-only; the supervisor does every change | One approval path; a helper following a bad instruction can't change anything |
| Playbooks ranked by (wins+1)/(uses+2) | New playbooks get a fair start; ones that keep failing sink |
| Team id = the agent run id | Shared memory and helpers are deleted with the run |
| Video not sent to the decision model | `gpt-6-luna-decisions` takes text and images; helpers send a page screenshot instead |
| Browser install runs Playwright's CLI, not a shell | Same browser build as `npm run setup:browser`, no command injection |
| Page text budget up to 800k tokens | 1M-token models get 60% of their window; the rest is for prompt, history and answer |
| Guide built from the app (menu, tool list, settings) plus curated topics | New pages and tools show up for the agent without anyone editing a prompt; a test makes sure each has help text |
| Notes in SQLite, mirrored to .md files | Backups include them, and they are still plain files you can open |
| Self-review on the fast model, without page text | Cheap, and a page cannot plant instructions in the lessons |
| Link prefetch off | Prefetching every route crowded out API calls on the browser's 6-connection limit (found in the walkthrough: saves took 7 s) |

## Status (13 layers)
| Layer | Status |
|---|---|
| Frontend | ✅ 24 pages with loading/empty/error states, light/dark, phone width, command palette (Ctrl K), URL-kept tabs and filters |
| APIs | ✅ 80 route files, Zod validation, one error format with request id and field errors, rate limits, Bearer tokens |
| Database | ✅ 8 numbered migrations (agent notes and self-reviews; agent team: helpers, shared memory, playbooks; AI log, cache, memory; operations: versions, issues, repairs, deliveries, saved views, triage), `secure_delete`, indexes, retention pruning every 6 h |
| Auth | ✅ optional password (signed cookie) + API tokens; ➖ multi-user not needed |
| Hosting | ⏳ VPS steps documented in RUNBOOK |
| Compute / jobs | ✅ job queue with concurrency, per-site turns, cancel/retry, crash recovery; scheduler with leases; interval or cron |
| CI/CD | ✅ `.github/workflows/ci.yml` (typecheck, lint, tests, build, audit); runs once pushed to GitHub |
| Security | ✅ see docs/SECURITY.md (red-team checks re-run this round); ⏳ nonce-based CSP before public hosting |
| Rate limiting | ✅ per endpoint + per host + AI daily cap |
| Caching | ➖ local app; static assets cached by Next.js |
| Scaling | ⏳ worker process + Postgres when needed |
| Observability | ✅ Operations page, per-task Health tab with anomaly band, failure reports with screenshots, health alerts, delivery log, JSON logs, audit log, per-job logs, Sites stats, health endpoint |
| Recovery | ✅ daily backups with retention, download, restore steps, setup export/import, JSON export |

## Tests
`npm test`: 193 tests across 15 files. New in the learning round (`tests/knowledge.test.ts`): every page has help and every tool a description (fails when a new feature is added without it), the guide lists every tool and page from the app itself and goes into the system prompt with the live set-up, topic and search lookups, notes versioned and mirrored to `.md` files, lessons de-duplicated, helpers read but never write notes, a full run that reads the guide, writes a note and is reviewed (score, lesson, site note), the reviewer never sees page text, reviews add to notes instead of replacing them, secrets refused, private runs write and review nothing, simple questions not reviewed. The walkthrough also found that opening an editor from a dialog (new note, new playbook) closed the whole dialog; fixed in the shared Dialog. New in the set-up round (`tests/setup.test.ts`): Test connection before saving (good key, refused key stops early, servers without a model list, nothing saved), 1M-token page budget, partial settings saves keep the rest, SOCKS5 proxy saves, only real browser files accepted, the in-app browser installer (one run at a time, progress, plain failure reasons). The real download could not be tried here because this sandbox blocks `cdn.playwright.dev`; the walkthrough showed that failure explained in the app, then used an existing Chromium. New in the team round (`tests/team.test.ts`): supervisor starts helpers with its own instructions and decision questions, helper prompts put Scaper's rules first, helpers only get read-only tools and are refused change tools, shared memory, decision calls with the supervisor's questions, playbook save, reuse, counting, rating and versioning, the 5-helper limit, stopping the supervisor stops its helpers, no team in private mode or when switched off. The walkthrough also found and fixed two settings bugs: saving one part of the AI settings through the API reset the rest (the provider was lost), and a `socks5://` proxy was refused on save. New in the decisions round (`tests/decisions.test.ts`, against a mock Decisions API): threshold reading, guardrail rules, scrape-check combining, request shape and key, retries on 429 only, bad answers and question limits, private mode, link scoring in one request, category planning by the decision model and fallback to chat, robots.txt stop before any model call, account-page cautions, rules-only mode, agent guard (delete always asks, mismatch flagged, unreachable model asks), SOCKS5 and masked proxy. Before that: New in the enterprise round (`tests/enterprise.test.ts`): data checks (suggest, score, mostly, severity), failure reports by cause, usual-range learning, error grouping, versions and restore, issues opening and resolving across runs with one alert each, health alert once per problem and recovery, AI repair checked against the last good run and applied in auto mode (and rejected when items don't match), change triage and ignore-from-feedback keeping history, briefings with AI summary, webhook signing, retries, delivery log and redeliver, Google Sheets replace and upsert against a mock Google with real JWT signatures, MCP initialize/list/call with write gating, saved views. Earlier (133): New this round (`tests/ai-gateway.test.ts`): per-provider keys and headers, fallback on outage, JSON-mode adaptation, cache, monthly budget, secret masking, legacy migration, page context, typed AI extraction with link references and grounding, category plan and run, private mode leaving no rows, timeline and wipe. Earlier: extraction, task engine (pagination, detail pages, crawl, inputs, quality, new/removed rows), watchers (all target types, rules, noise filters, visual diff), deals and scores, politeness (robots.txt, backoff, bot-check stop, SSRF guard), AI (agent tool loop, follow-ups, stop, Build with AI, daily cap) against a mock OpenAI-compatible server, ops (tokens, backups, config import/export, secret masking), and the line diff.

A full browser walkthrough was run with Playwright against a local fixture site and a mock model (`/tmp` scripts, not in the repo): every page, the main flows end to end, phone width (390 px) and dark mode. Bugs it found and that are fixed: auto mode showing a 1-item structured-data list before the 5-card list; duplicate job log lines from overlapping polls; channel test errors returning 500 instead of a clear message; proxy errors not shown on the field; bookmarklets blocked by React's `javascript:` URL guard; charts scaling their text down to unreadable sizes in narrow cards; broken product images showing alt text; duplicate tab element ids when a dialog has its own tabs; site rules able to make a site faster than the default; "1 rows"/"1 checks" wording and uneven discount decimals; health check missing the version.

The AI upgrade was walked through the same way (18 flows: provider setup with Load models and Test, routing and fallbacks, memory, privacy wipe, category plan and run, save as task, agent approval, private agent chat, AI log transcript, timeline, Fix with AI, run compare, task AI columns, AI extract columns, private-mode indicator, phone width). Bugs it found and that are fixed: small pages lost their headings in the model's context; the capability test marked models "no tools" when they simply chose not to call the test tool; saves stalling behind route prefetching; selector inputs too narrow on the category plan.

The enterprise round was walked through in the browser too (Health tab, Checks with suggestions, a site redesign producing a failure report and an AI repair, Versions, the data grid with filters, pins and a saved view, Operations, the Changes inbox with AI importance and a briefing, Integrations with the MCP test, webhook test and delivery log, briefing settings, the task editor, phone width in dark mode). Bugs it found and that are fixed: the briefing preview re-requesting itself until rate-limited; "from undefined good runs" on the Health tab; a double full stop in the repair banner.

## Known issues / not verified
- Not tested against live Amazon or other public sites from the build environment (its network blocks outside sites). Amazon selectors follow Amazon's current public markup and may need updates when Amazon changes its layout.
- Email, Telegram, Discord, Slack and ntfy were tested for their error paths and payloads, not against the real services.
- Desktop notifications appear only while a Scaper tab is open.
- The AI features were tested against a mock OpenAI-compatible server, not real providers. Providers differ in small ways; the client adapts to the common ones (JSON mode, `max_completion_tokens`, temperature), and **Test** shows what a model supports.
- Google Sheets sync was tested against a mock of Google's token and Sheets endpoints, not the real API.
- A run whose selectors find nothing still counts as "ok" in success rates; its failure report and data score show the problem.
- Editing the model routing while a provider save is still in flight can be overwritten by the save's result.

## Next steps (in order)
1. Connect a GitHub repo and push (CI file is ready).
2. Team features if Scaper moves to a server: users, roles, per-user audit.
3. Amazon Creators API integration (needs an Associates account).
4. Nonce-based CSP, then VPS deploy behind Caddy.
