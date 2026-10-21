# Compact product research

Checked on 21 Oct 2026. Mode B (a category: website-change monitors, scrapers and price trackers), compact pass: fewer sources than a full research report, so treat numbers as indicative.

Legend: ✅ confirmed on an official page · 🟡 reported by a third party · 🔵 inferred · ⚪ unknown

## Top line

Website monitoring and price tracking are crowded, but almost every option is a cloud subscription with check limits, and the few self-hosted ones need DevOps skills. A free, local, one-command app with a modern UI, bring-your-own-LLM and honest deal judging (own price history instead of the shop's M.R.P.) is a real gap for solo users in India. The biggest risk is sites (Amazon above all) blocking automated access; the answer is polite low-volume scraping plus official APIs, not evasion.

## Market map

| Product | Type | Free tier | Paid from | Strength | Weakness | Source |
|---|---|---|---|---|---|---|
| Visualping | Cloud monitor | 5 pages, 150 checks/mo | ~$14/mo | Visual compare, easy | False positives, price | 🟡 [PageCrawl guide](https://pagecrawl.io/blog/complete-guide-website-monitoring-2026.md) |
| Distill.io | Extension + cloud | 25 monitors (5 cloud) | $15/mo | Local checks in browser | Reliability and UI complaints | 🟡 same |
| ChangeDetection.io | Open source (self-host) / hosted | Self-host free | $8.99/mo hosted | Open source, CSS/XPath | Needs DevOps, no visual picker, no AI | 🟡 same |
| PageCrawl | Cloud monitor | 6 pages | $80/yr | AI on all plans | Vendor of the guide (biased) | 🟡 same |
| Fluxguard | Enterprise monitor | 3 sites | $110/mo | AI filtering | Credit pricing | 🟡 same |
| Keepa / PriceHistory-type tools / BuyHatke (India) | Price trackers | Yes | Varies | Large shared price history | Cloud-only, store-specific, no general scraping | 🟡 [AlternativeTo](https://alternativeto.net/software/keepa-com/) |
| How people do it today | Manual refresh, spreadsheets, Telegram deal channels | – | – | Free | Slow, noisy | 🔵 |

## What users complain about (from the guide's review summaries, 🟡)

1. False positives from ads, dates and counters → Scaper: watch a selector, "ignore lines containing", AI "does this change matter?" rule.
2. Pricing and check limits → Scaper: free, unlimited, local.
3. Self-hosting is hard → Scaper: `npm install && npm run dev`, SQLite, no Docker needed.
4. No AI or locked-in AI → Scaper: any OpenAI-compatible model, including free local ones.
5. Fake discounts → Scaper: deal score from its own price history; flags inflated M.R.P.

## Amazon data

- Amazon's Product Advertising API 5.0 is deprecated; the Creators API is its successor ✅ [Amazon Associates](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation). A third-party article reports the PA-API shutdown date as 30 April 2026 🟡 [DEV Community](https://dev.to/th3nate/amazon-pa-api-v5-is-shutting-down-april-30-2026-here-is-what-changes-at-the-auth-layer-22ek). Eligibility rules for the Creators API were not checked ⚪.
- Amazon's Conditions of Use restrict robots and data mining 🔵 (well known; check the current text yourself). Scaper therefore keeps volume low, respects robots.txt, stops at robot checks, and recommends the official API for scale.

## Legal and policy notes (India)

- Scraping public pages for personal price tracking is low risk; republishing scraped data or running it at scale is not. Respect each site's terms.
- If you later add accounts for other people, India's DPDP Act applies to their personal data.
- If you add Amazon affiliate links, follow the Associates programme's disclosure rules.
- Check the name "Scaper" in the Indian trademark registry before a public launch.

## Build brief (what was built)

```
# PROJECT BRIEF
Use with: build-web-app (adapted: local-only, no Postgres/Redis)
## 1. Summary
- Working name: Scaper (check trademarks before final)
- In one sentence: A local web app that scrapes any page, watches sites for changes, tracks prices with its own history, and runs an AI agent on your own model.
- Our winning angle: free, local, one command, bring-your-own-LLM, honest deal scores.
## 4. Features
- Must-have: scraper (auto/selectors/AI, export, recipes); watchers (page/selector/price, 7 rule types, diff, ignore lines); alerts (inbox, desktop, webhook, Telegram); deals (track, history, deal score, listing scan, AI ranking); agent (tool calling); settings; polite fetcher; optional password.
- Later: visual element picker, scheduled recipe runs with export to Google Sheets, email alerts, multi-user accounts, Amazon Creators API integration, browser extension, Postgres/Redis for scale.
- Not now: CAPTCHA solving, fingerprint spoofing, proxy rotation pools (ToS and ban risk).
## 9. AI
- What the AI does: extraction, change relevance, deal ranking, agent with Scaper tools.
- Limits: daily request cap, max tokens, agent step limit; provider-side spending limit by the user.
- Never: execute model output, follow instructions inside scraped pages, bypass site protections.
## 14. Limits
- Budget: ₹0 (local); AI cost depends on the user's provider (local models are free).
```
