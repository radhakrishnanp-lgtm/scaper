# Scaper: feature gaps against leading tools (research, Oct 2026)

Scope: scraping (Apify, Browse AI, Octoparse, ParseHub, Instant Data Scraper, Web Scraper/webscraper.io), monitoring (Visualping, Distill.io, changedetection.io, Wachete, PageCrawl.io) and price tracking (Keepa, CamelCamelCamel, PriceHistory, Buyhatke, Amazon.in's own price history).
The research comes from vendor docs, help centres, release notes and reviews (source numbers [n] link to section 7).
The "Scaper" column comes from a quick read of `src/lib/schemas.ts`, `src/server/watch/runner.ts` and `README.md`, not from testing. It uses: **Have**, **Part** (partly built), **No**, **?** (not checked).

---

## 1. Scraping

| Feature | Who has it | How it works for the user | Scaper |
|---|---|---|---|
| Point-and-click list capture | Browse AI, Octoparse, ParseHub, webscraper.io | Browse AI's "Capture list": you hover and a dotted outline wraps the repeating cards. One click selects them all and proposes a dataset you can rename. Then you set the **item count** and a **pagination method** [7]. | Part: "Pick on page" on a screenshot |
| Auto-detect lists, tables and pagination | Octoparse, Instant Data Scraper | Octoparse scans the DOM and layout for repeated regions and also finds a next-page button or infinite scroll, then builds a workflow you can edit [11]. Instant Data Scraper guesses a table, offers **"Try another table"** to switch candidates, and **"Locate 'Next' button"** asks you to click Next once, after which the icon turns green and it crawls [16][17]. | Part: Auto mode, but no candidate switcher and no auto-detected pagination |
| Pagination types | webscraper.io, Browse AI, Octoparse | webscraper.io offers Auto, Link (href), Scripted link, Attribute link, Text link, "Click multiple times on next/more button **until no new records are scraped**" and "Click once on multiple buttons". Pagination is recursive, with child selectors nested under it [14]. Browse AI offers Next / Load more / Scroll down / No more items [7]. | Part: next, click, scroll, loadMore with maxPages. Missing: auto type, stop when no new rows, item limit |
| Selector tree and record boundaries | webscraper.io | The sitemap is a tree of selectors. An Element selector with "Multiple" ticked marks one record each, and the fields under it share that record. Siblings run top to bottom, so a click selector placed above a field reveals that field's content [13]. | Part: item selector + fields |
| List to detail ("deep scraping") | Browse AI, webscraper.io, Octoparse | Browse AI: Robot A captures the list and its URL column, Robot B scrapes one detail page, and a **Workflow** chains A to B on a schedule. There is no fixed limit on chain depth [6]. | Part: one detail level |
| Bulk run from a CSV of inputs | Browse AI, Apify tasks | "Bulk Run Tasks" or "Import CSV" takes a column of URLs or input parameters, up to 500k rows, and a sample CSV is provided [5][6]. | Part: start URLs with `{1..5}` ranges, sitemap. No CSV with parameter columns |
| Interaction commands | ParseHub, Octoparse, Distill | ParseHub: Select, Relative Select, Click, Input, Hover, Scroll, Wait, **Conditional**, **Loop**, Go To Template, Begin New Entry, Jump, Stop [15]. Octoparse: Enter Text, Scroll (full page or one area, repeat count, stops when nothing new loads), Wait, Clean Data [10]. | Part: 8 step types, no branches or loops |
| Selector editing with live test | Octoparse | You switch a field into XPath mode and test the edited selector against the live page before saving. **Field Fixer** lets you describe the fix in plain language and review it before applying [10][11]. | ? |
| Per-field clean-up | Octoparse, webscraper.io Parser | "Clean Data" trims, reformats or extracts part of a value. webscraper.io Parser applies no-code rules per column [10][19]. | Have: 12 transforms |
| Incremental extraction | Octoparse | "Incremental Extraction" (Settings → Run Options) skips URLs seen in earlier runs. Dedup separately drops records with identical fields. Run details show **extracted / saved / duplicate** counts [12]. | Part: `dedupeBy`. No skip-seen and no counts |
| Data quality control | webscraper.io Cloud, Apify | Per-sitemap thresholds: min record count, max failed-page %, max empty-page %, min % of fields filled. **"Fill with suggested values"** fills them in from the last run. A job that breaks a threshold is flagged and an alert is sent, while the job still counts as "finished" [18]. | No |
| Storage model | Apify | Each run gets an append-only **dataset** (Table and JSON views) plus a **key-value store** for files and screenshots. Export to JSON, JSONL, CSV, XML, Excel, HTML or RSS, with **Select fields**, **Omit fields** (nested paths allowed) and **Clean items**. Unnamed storage is deleted after 7 days, named storage is kept [22]. | Part: CSV and JSON only |
| Preview grid before export | Instant Data Scraper, Octoparse | Rename or remove columns in the preview, then CSV, XLSX or **"Copy all data"** to the clipboard [17]. Octoparse Data Preview lets you re-select, delete fields or rows, and add missing fields [11]. | ? |
| Templates / prebuilt robots | Browse AI (200+), Octoparse, Apify Store | You pick a site template and fill in the inputs, with no selectors to write [4][9]. | Part: Amazon-style parsers, saved recipes |
| First-run approval | Browse AI | After training, you review the robot's sample output and **approve** it before it is scheduled [6]. | No |

## 2. Monitoring

| Feature | Who has it | How it works for the user | Scaper |
|---|---|---|---|
| Monitor types | Distill, changedetection.io, PageCrawl | Distill: Web page, PDF, JSON, Word, XML, **Feed**, **Uptime**, **Sitemap** (crawler) [24]. changedetection.io: text/JSON diff, **restock_diff**, **image_ssim_diff** (SSIM, default 0.95), and PDF text, size and checksum [1][2]. PageCrawl: feeds/sitemaps alert on **added or removed items**, plus file checksums and SSL/security headers [34]. | Part: page, selector, price, visual (pixel), JSON |
| Visual selector | changedetection.io, Distill, Visualping | changedetection.io: "Open Visual Selector" shows the rendered page. Clicking an element highlights it, and each extra click adds a comma-joined selector. The CSS/XPath appears at the bottom and can be edited, and a Preview tab shows what will be compared [29]. Distill lets you *deselect* noisy parts (timestamps, ads) [27]. Visualping: drag a box over the area [32]. | Part: screenshot picker |
| Browser steps (form) | changedetection.io | An ordered list of rows, each with an Operation dropdown, a selector and a value: Goto URL/site, Click (fail / **if exists** / **by text** / **at X,Y**), Enter text, Check/uncheck, Select by label, Wait seconds / **for text** / for text in element, **Execute JS**, **Remove elements**, Make children visible, Scroll, Press Enter. Values accept Jinja2, e.g. today's date [28]. | Part: click(optional), type, press, select, hover, waitFor, wait, scroll |
| Macro recorder | Distill, Visualping extension | Distill opens a remote browser, and each action you take appears as a step in a right-hand panel. You replay it to check: passed steps get a green tick. Steps can be edited (Replace, Insert before/after, Delete). It supports **IF/ELSE IF/ELSE**, **Assert** (halts with E_ASSERT), and **For/While loops** (e.g. click "Load more" while it exists). A failure shows `EMACRO` with the failing step [25]. | No recorder |
| Filters and noise control | changedetection.io, PageCrawl | Trigger text, ignore text, extract text, remove-by-selector, regex, CSS/XPath 1/2, JSONPath/**jq** (including jq comparisons), JSON embedded in HTML [1][3]. PageCrawl blocks cookies, ads and popups, **ignores dates**, and has silent recording (saves history without alerting) [34]. | Have: ignore lines/regex/numbers/case, keep-lines. Missing: jq, remove-by-selector |
| Conditions | Distill, changedetection.io, Visualping | Distill text checks: contains, starts/ends with, empty, length, regex, "doesn't match any previous text". Number checks: less/more than, increased/decreased by an amount or **by %**. Each check targets one scope: **Text / Added / Deleted / Previous / Net added / Net deleted**. Checks combine with **AND/OR** at **global and per-monitor levels**, and "Test Condition" checks them before saving [26]. Visualping thresholds: Any, Tiny 1%, Medium 10%, Major 25%, Gigantic 50%, plus keyword alerts [32]. | Part: one condition per watcher. `triggerOn` added/removed |
| Condition debugger | Distill | Each saved change shows a bell icon. Clicking it shows whether the conditions came out True (alert sent) or False [26]. | No |
| AI "alert me when" | Visualping, changedetection.io, PageCrawl | You write the intent in plain English, or pick an AI suggestion for the page. Each change is tagged **Important / Not important**, and unimportant changes are saved without an alert [33][3]. PageCrawl adds **importance scores** and **thumbs up/down** feedback to tune them, plus BYOK [34]. | Part: AI condition (yes/no) |
| AI change summary | Distill, Visualping, changedetection.io | Distill returns `change_summary` + `important`, plus **custom typed fields** (number, bool, string). The prompt can be edited and there is a **Test** button. The summary appears in blue above the diff and in emails [30]. Visualping adds a 2–3 line summary to every alert [33]. changedetection.io uses LiteLLM, which accepts any OpenAI-compatible endpoint, and lets you edit the prompt per watch [3]. | Part: one-line summary |
| Diff viewer | Distill, changedetection.io, Visualping, Browse AI | Distill: **Visual / Text / Source** modes. **Side-by-side** (default) or **inline**. Added text in green, deleted in red, with a toggle to show deletions. A **"Snipped"** view keeps only text near each change. A date dropdown compares **any two versions**, and next/prev buttons step through changes [27]. changedetection.io compares by **word, line or character** [1]. Visualping shows a screenshot with changes highlighted plus a text diff [33]. Browse AI list diffs: **new rows green, changed yellow, removed red**, plus position change (e.g. −2) [8]. | Part: line diff |
| Notifications | changedetection.io, Distill, Visualping, PageCrawl, Wachete | changedetection.io sends to 80+ Apprise services (`tgram://`, `discord://`, `mailto://`, `json://`, `msteams://`…). Messages are **Jinja2 templates** with tokens `{{diff_added}}`, `{{diff_removed}}`, `{{current_snapshot}}`, `{{preview_url}}`, `{{triggered_text}}`. Formats: text, markdown or HTML. Settings inherit **watch > tag > global**, with a "Mute all" switch and a **Send test notification** button globally and per watch [31]. Distill adds SMS, push and **audio** alerts [24]. Wachete sends email, phone, Slack, Teams, Discord and Telegram alerts, and keeps 12 months of history with charts and spreadsheet download [46]. | Have: 7 channels (desktop, webhook, Telegram, Discord, Slack, ntfy, email). Missing: templates, inheritance, test button per watcher |
| Scheduling | Distill, changedetection.io, Visualping, Browse AI | Distill: Interval, **Random (min–max)**, Live, Cron, plus **time slots** (start/end time + weekdays) [23]. changedetection.io: any **timezone**, chosen days and times, **business-hours / weekend presets** [3]. Browse AI: custom **RRULE** [8]. PageCrawl: **minimum delay between checks to the same domain** [34]. | Part: interval only (cron exists for recipes) |
| Error handling | Distill, Apify | Distill: "No. of consecutive errors to trigger notifications" (default 5), minimum minutes between error alerts (default 15), an **Errors** view, and **Clear Error Flag** [35]. There is also a per-monitor **check log** [24]. | Part: fixed in-app alert on the 3rd failure, plus backoff |
| Restock / product processor | changedetection.io | It reads price, availability and SKU from **JSON-LD, OpenGraph, microdata and RDFa**, with an HTML fallback. Settings: `price_change_min`, `price_change_max` and `price_change_threshold_percent`, and restock alerts either `changes_only` or `always_trigger`. The Stats tab shows what was extracted [2]. | Part: JSON-LD in the deal parsers |
| Organisation | changedetection.io, Distill, PageCrawl | Tags/groups with **group-level setting overrides** [21]. Distill labels [24]. PageCrawl: colour labels, **nested folders**, **bulk edit** of frequency, engine, notifications and labels, and tag prefixes such as `sku:` exported as columns [34]. | Have: tags + bulk pause/resume/check/delete/tag |
| RSS out | changedetection.io | An RSS feed per watch and per group (0.51.x), formatted like the notification body [21]. | No |
| Reports / digests | Visualping, PageCrawl | Scheduled briefings that group changes with AI summaries, visual diffs and importance flags. PageCrawl offers daily, weekly or monthly reports in 8 summary styles [32b][34]. | No |
| Review board | PageCrawl | A kanban board with custom lanes for sorting detected changes [34]. | No |
| Archive snapshots | PageCrawl | A replayable **WACZ** web archive saved on each change [34]. | Part: screenshot per change (option) |
| Add current page | changedetection.io, PageCrawl, Visualping | A Chrome extension or bookmarklet adds the open tab as a watch in one click [3][34]. | No |

## 3. Price tracking

| Feature | Who has it | How it works for the user | Scaper |
|---|---|---|---|
| Statistics panel | Keepa, CamelCamelCamel | Keepa computes, per price type: current, avg for the chosen window, **avg30 / avg90 / avg180 / avg365**, **all-time min/max with timestamp**, min/max within the window, **out-of-stock % (30/90/180/365)** and sales-rank drops [36]. CamelCamelCamel's table under the chart lists Current, Lowest (all-time), Average (selected range), and Last Price Change [38]. | Part: current, low, high, avg30, days tracked |
| Chart controls | Keepa, CamelCamelCamel, Amazon.in | Keepa range buttons: Day, Week, Month, 3 months, Year, All. You can toggle each series. **Out-of-stock periods show as white gaps** [37]. CamelCamelCamel: 3m / 6m / 1y / All, plus **"remove extreme values"** and **close-up** views [38][39]. Amazon.in (since Nov 2025) has a 30/90-day window under the price [42]. | ? (charts.tsx exists) |
| Several price types per product | Keepa, CamelCamelCamel | Separate lines for Amazon, 3rd-party new, used, Buy Box, and new FBA/FBM markers. You can track one type or all of them [37][39]. | No (one price) |
| Target price alerts | Keepa, CamelCamelCamel, PriceHistory | Keepa: set the target **from the chart**, or alert on back in stock. Alerts go to email, Telegram, RSS, push or the browser [37][41]. CamelCamelCamel: **several alerts per product at different prices**, or any drop, by email only [38]. | Have: target, % drop, new low, back in stock |
| Deal judged against own history | PriceHistory, Buyhatke | Deals are "ranked against the product's own price history" rather than M.R.P. [40]. The lists also flag **price inflation before festival sales** [43]. Buyhatke shows a 3-month graph and "best time to buy" [44]. PriceHistory shows **drop chances** [45]. | Have: deal score + inflated M.R.P. flag. Missing: drop chance, pre-sale inflation check |
| Cross-store comparison | PriceHistory, Buyhatke | One product page shows the all-time low and high and the current price **at each tracked store** [40]. Buyhatke compares stores and offers a cheaper **"Lookalike"** [44]. | No |
| Deals feed | PriceHistory, Keepa | Lists of recent drops filtered by **store** (Amazon, Flipkart, Myntra, Croma) and **23 categories** [40]. | Part: deal scan + saved searches |
| Inline preview | Keepa, CamelCamelCamel | Hover a product link to see a price-history preview (Keepa). Camelizer opens a sidebar with a keyboard shortcut [37][38]. | No (needs an extension) |

## 4. Platform and operations

| Feature | Who has it | How it works for the user | Scaper |
|---|---|---|---|
| Schedules UX | Apify | 6-field cron or `@daily` / `@hourly`, a timezone with DST handled, and a **visual builder**. A **"Next runs"** list previews the next 5 times. New schedules start **disabled**, and you get an email if a scheduled run fails to start [20]. | Part: cron on recipes |
| Run metrics and alerts | Apify | Charts of run status over 30 days and metrics for the last 200 runs. Alert when a metric is **below** a threshold after the run or **above** it during the run, when the status is e.g. FAILED, or on dataset field stats (field missing, value out of range). Alerts go to email, Slack or in-app. Repeat failures are grouped every 20 min [21a]. | No |
| Webhook event types | Apify, webscraper.io, Browse AI | `ACTOR.RUN.CREATED/SUCCEEDED/FAILED/ABORTED/TIMED_OUT/RESURRECTED`, with a payload template of run IDs plus the resource [21b]. | Part: one signed webhook for alerts |
| Saved inputs ("tasks") | Apify | Save an Actor's input as a task and re-run or schedule it without filling the form again [22a]. | Have: recipes |
| API and agent access | changedetection.io, Browse AI, Visualping, PageCrawl | REST API with an **OpenAPI spec**, covering watches, tags, notifications, import and search [3][21]. MCP servers let AI agents add monitors (Visualping, PageCrawl) [32b][34]. | Part: REST API (docs/API.md). No OpenAPI or MCP |
| Import / export of config | Distill, changedetection.io | Export and import monitors [24]. changedetection.io imports a plain URL list or **.xlsx**, and its API imports with processor settings [3][21]. | Part: data export (JSON) |
| Destinations | Browse AI, Visualping, webscraper.io, Apify | Google Sheets / Airtable sync, Dropbox, S3, Drive, plus Zapier, Make, n8n [4][19][33]. | Part: webhook. Sheets is planned |
| Plugin hooks | changedetection.io | Hooks run before and after a watch is processed. Content fetchers can be swapped (0.52–0.53) [21]. | No |
| Live UI and queue view | changedetection.io | Real-time UI updates (no polling), and a progress graph showing when queued checks will run [21]. | Part: SSE alerts |

## 5. UI/UX patterns worth copying

| Pattern | Who | Behaviour |
|---|---|---|
| Recorder with a live step panel | Distill [25] | Remote browser on the left and recorded steps on the right. Replay ticks each step, and the step menu offers Replace / Insert / Delete. |
| Hover outline and proposed dataset | Browse AI [7] | A dotted outline on hover. One click gives a ready-made table to rename, with a list size and pagination picker. |
| "Try another table" | Instant Data Scraper [16] | Steps through the detected candidates without restarting. |
| Natural-language field fix | Octoparse [11] | "Make price numeric, drop the ₹": the tool shows the proposed change and you approve it. |
| Suggested thresholds | webscraper.io [18] | "Fill with suggested values" from the last good run. |
| Condition debugger bell | Distill [26] | Each change shows True/False for the conditions, which explains why an alert did or did not fire. |
| Snipped diff + next/prev | Distill [27] | Long pages collapse to the changed parts, and keyboard steps move between changes. |
| Colour-coded list diff | Browse AI [8] | Green new / yellow changed / red removed rows, plus position deltas. |
| Next-5-runs preview | Apify [20] | Shows a cron's effect before you save it. |
| Schedule presets | changedetection.io [3] | Business hours / weekends in one click. |
| Test buttons everywhere | changedetection.io [31], Distill [26][30] | Test notification, test condition and test AI summary, each in place. |
| Errors view | Distill [35] | A filtered list of failing monitors, with a "Clear error flag" action. |
| Bulk edit | PageCrawl [34] | Select many monitors and change frequency, notifications or labels at once. |
| Kanban review board | PageCrawl [34] | Triage changes as New, Reviewed, Action needed. |
| Sensitivity presets | Visualping [32] | Any / Tiny 1% / Medium 10% / Major 25% / Gigantic 50%, rather than a raw number. |

---

## 6. Priority backlog (local, single user)

Left out on purpose: CAPTCHA solving, fingerprint spoofing, proxy rotation pools / "web unblockers" / "stealth engines" (PageCrawl, Browse AI, ParseHub offer these), anything that bypasses bot protection, and teams, workspaces, SSO or billing.

### P0: closes gaps every leading tool has covered
1. **Rule builder for watchers.** Several conditions joined with AND/OR. Each condition picks a scope (full / added / removed / previous text) and a type: contains, regex, length, number less/more than, change by an amount or by %. Add global default rules, a **Test condition** box with sample text, and a **True/False badge on every saved change** (Distill [26], changedetection.io [3]).
2. **Diff viewer v2.** Side-by-side / inline toggle; word / line / character granularity; snipped mode; compare **any two snapshots**; next/prev change with keyboard; text / source / screenshot tabs with changed regions boxed; a list-diff mode for scraped tables (added / changed / removed rows, position change) (Distill [27], changedetection.io [1], Visualping [33], Browse AI [8]).
3. **Error alerting and check log.** A configurable consecutive-error threshold and minimum time between error alerts, sent to all chosen channels. An **Errors** filter with "clear flag". A per-check log that names the failing step, with a screenshot on failure (Distill [35][25], Apify [21a]).
4. **Run health and data quality for recipes.** Minimum rows, maximum failed/empty page %, minimum field fill %, "suggest from last run", and an alert when a scheduled recipe returns 0 rows or a field goes empty, which is how selector breakage shows up. Show extracted / saved / duplicate counts per run (webscraper.io [18], Apify [21a], Octoparse [12]).
5. **Price stats panel and chart controls.** All-time low and high **with dates**; averages for 30/90/180/365 days; low and high for the chosen range; % of time out of stock; last price change. Range buttons 1W / 1M / 3M / 6M / 1Y / All; out-of-stock shown as gaps; "hide extreme values"; set the target price by clicking the chart (Keepa [36][37], CamelCamelCamel [38], Amazon.in [42]).
6. **Watcher scheduling.** Cron or RRULE with a next-5-runs preview, timezone, **active hours and weekdays**, business-hours / weekend presets, and a random interval between a minimum and maximum. Reuse the croner code that recipes already use (Distill [23], changedetection.io [3], Apify [20]).
7. **Browser-step recorder.** Use the existing Playwright session to stream a live page, write clicks and typing into the step list, and replay with a ✓/✗ and a thumbnail per step. Add these operations: click by text, click if exists (kept from today's option), wait for text, remove element, run JS, check/uncheck, and date/variable templating (changedetection.io [28], Distill [25], Visualping [32b]).
8. **Restock/price processor settings.** Read structured data from JSON-LD, OpenGraph, microdata and RDFa. Alert on min/max price combined with a % change threshold, with "changes only" vs "every in-stock check", and show what was extracted on the watcher page (changedetection.io [2]).

### P1: strong value, more effort
9. **More monitor types:** RSS/Atom (alert on new items), **sitemap new-URL monitor**, PDF text, uptime/status code (Distill [24], PageCrawl [34]).
10. **Notification templates:** tokens such as `{{diff_added}}`, `{{price}}`, `{{url}}` and `{{preview_url}}`; text / markdown / HTML per channel; settings that inherit watcher > tag > global; mute all; a per-watcher **Send test**. Optionally accept Apprise-style URLs for more channels: Pushover, Gotify, Matrix, Teams, Google Chat (changedetection.io [31]).
11. **Structured AI change review:** an editable prompt that returns `summary`, `important` and custom typed fields; a Test button; importance score with 👍/👎 feedback saved as few-shot examples; a **daily/weekly digest** of all changes (Distill [30], PageCrawl [34], Visualping [32b]). Run everything through the user's own model, keeping the existing daily cap.
12. **Incremental scraping** that skips detail URLs seen in earlier runs, with a "re-scrape all" switch (Octoparse [12]).
13. **Bulk run from CSV:** columns become variables used in URLs and steps, e.g. a search term or pincode (Browse AI [5], Apify tasks [22a]).
14. **Export v2:** XLSX, JSONL, select/omit fields, clean hidden fields, Google Sheets (already planned), and copy to clipboard (Apify [22], Instant Data Scraper [17]).
15. **Auto-detect v2:** a "try another candidate" switcher, auto-detected pagination, and renaming, reordering or deleting columns in the preview (Instant Data Scraper [16][17], Octoparse [11]).
16. **Selector lab:** edit the CSS/XPath with a live match count and on-page highlight, plus an LLM "fix this field" that shows a proposed change to approve (Octoparse [10][11]).
17. **Config import/export:** watchers, recipes and products as JSON, plus importing a URL list or XLSX into watchers or products (Distill [24], changedetection.io [3]).
18. **Run metrics page:** run status over 30 days, plus rows and duration per run, with an alert when rows fall below N or duration goes above N (Apify [21a]).
19. **Several price alerts per product,** and separate tracking of sale price, M.R.P. and seller/variant (CamelCamelCamel [38], Keepa [37]).
20. **Cross-store product grouping:** link the same item on Amazon.in, Flipkart, Croma and others, and show the cheapest current store and each store's all-time low (PriceHistory [40], Buyhatke [44]).
21. **RSS output** per watcher and per tag, so any feed reader can follow changes (changedetection.io [21]).
22. **Typed webhook events** (run.succeeded / run.failed / watcher.changed / product.drop) and an OpenAPI spec for the REST API (Apify [21b], changedetection.io [3]).

### P2: nice to have
23. IF/ELSE, loops ("while Load more is visible") and Assert steps (Distill [25], ParseHub [15]).
24. Multi-level workflows that feed recipe A's output into recipe B (Browse AI [6]).
25. Kanban review board for changes, and bulk edit of frequency and channels (PageCrawl [34]).
26. Single-file HTML or WACZ snapshot on each change (PageCrawl [34]).
27. Browser extension or bookmarklet: "Add this page to Scaper" (changedetection.io [3], PageCrawl [34]).
28. An MCP server that exposes Scaper's tools to outside agents (Visualping [32b], PageCrawl [34]).
29. Before/after-check plugin hooks (changedetection.io [21]).
30. "Drop chance" / best-time-to-buy from Scaper's own history, and a check for prices raised before festival sales (PriceHistory [45][43], Buyhatke [44]).
31. Built-in templates for common Indian stores and job/news sites (Browse AI [4], Octoparse [9]).
32. SSL-expiry and security-header checks (PageCrawl [34]).
33. A first-run "approve sample" step before a scheduled recipe goes live (Browse AI [6]).

---

## 7. Sources

1. changedetection.io on PyPI: https://pypi.org/project/changedetection-io
2. changedetection.io processors (restock_diff, image_ssim_diff): https://mintlify.wiki/dgtlmoon/changedetection.io/advanced/processors
3. changedetection.io README (AI rules via LiteLLM, conditions, scheduler, import, API, extension): https://github.com/dgtlmoon/changedetection.io ; overview: https://mintlify.wiki/dgtlmoon/changedetection.io/introduction
4. Browse AI platform overview: https://help.browse.ai/en/articles/10504839-platform-overview-of-browse-ai
5. Browse AI, running robots: https://help.browse.ai/en/articles/10595109-how-to-run-your-robot
6. Browse AI deep scraping and workflows: https://help.browse.ai/en/articles/10553465-how-to-extract-data-across-multiple-pages-deep-scraping ; approval: https://help.browse.ai/en/articles/10518718-how-to-approve-a-robot
7. Browse AI pagination and capture list: https://help.browse.ai/en/articles/10509840-how-do-i-handle-pagination-and-scrolling
8. Browse AI monitoring (list diff colours, RRULE): https://www.browse.ai/monitoring ; notifications: https://help.browse.ai/en/articles/10524268-how-to-set-up-monitoring-notifications
9. Octoparse core concepts: https://www.octoparse.com/docs/en/platform/core-concepts.md
10. Octoparse no-code builder: https://www.octoparse.com/docs/en/platform/no-code-builder.md
11. Octoparse auto-detect and Field Fixer: https://www.octoparse.com/docs/en/platform/auto-detect.md
12. Octoparse incremental scraping: https://www.octoparse.com/docs/en/platform/incremental-data-scraping
13. Web Scraper selectors: https://WebScraper.io/documentation/selectors
14. Web Scraper pagination selector: https://surveys.webscraper.io/documentation/selectors/pagination-selector
15. ParseHub commands: https://help.parsehub.com/hc/en-us/sections/203980687-Commands
16. Instant Data Scraper walkthrough: https://prowebscraper.com/blog/?p=3264
17. Instant Data Scraper review: https://www.clay.com/blog/instant-data-scraper
18. Web Scraper Cloud data quality control: https://webscraper.io/documentation/web-scraper-cloud/data-quality-control
19. Web Scraper Cloud features: https://webscraper.io/cloud-scraper
20. Apify schedules: https://docs.apify.com/platform/schedules
21. changedetection.io release notes, 0.48–0.53 (Cloudron): https://forum.cloudron.io/topic/7336/change-detection-package-updates/64 and https://forum.cloudron.io/topic/7336/change-detection-package-updates/118
21a. Apify monitoring and alerts: https://docs.apify.com/platform/monitoring
21b. Apify webhook events: https://docs.apify.com/integrations/webhooks/events.md
22. Apify datasets: https://docs.apify.com/storage/dataset.md ; storage overview: https://crawlee.dev/docs/deployment/apify-platform
22a. Apify, running Actors and tasks: https://docs.apify.com/get-started/run-actors.md
23. Distill schedule checks: https://distill.io/docs/web-monitor/schedule-checks/
24. Distill docs index (monitor types, alerts, import/export, logs): https://distill.io/docs
25. Distill macros: https://distill.io/docs/web-monitor/macro-to-record-replay-actions/
26. Distill conditions: https://distill.io/docs/web-monitor/using-conditions-to-get-alert-on-important-changes/
27. Distill change history and diff: https://distill.io/docs/web-monitor/change-history-and-highlighted-changes/ ; false alerts: https://distill.io/docs/web-monitor/eliminate-false-alerts/
28. changedetection.io browser steps: https://mintlify.wiki/dgtlmoon/changedetection.io/features/browser-steps
29. changedetection.io visual selector: https://mintlify.wiki/dgtlmoon/changedetection.io/features/visual-selector
30. Distill AI change summary: https://distill.io/docs/web-monitor/ai-change-summary/
31. changedetection.io notifications (Apprise, Jinja2 tokens, inheritance): https://mintlify.wiki/dgtlmoon/changedetection.io/configuration/notifications-setup
32. Visualping review (modes, thresholds, schedule windows, actions): https://maketecheasier.com/visualping-review/ ; UW Law blog: https://wisblawg.law.wisc.edu/2025/12/08/monitoring-webpage-changes-with-visualping/
32b. Visualping product updates (Reports, recorder extension, MCP, Important Alerts): https://www.cuspera.com/products/visualping-x-7608/news
33. Visualping AI setup guide (Alert me when, summaries, channels): https://visualping.io/pages/blog/how-to-monitor-web-page-with-ai
34. PageCrawl.io feature index: https://pagecrawl.io/help/features
35. Distill error alerts: https://distill.io/docs/web-monitor/error-actions/
36. Keepa statistics object: https://keepa.com/api-docs/statistics-object.html
37. Keepa extension listing: https://addons.mozilla.org/mn/firefox/addon/keepa ; how to read a Keepa graph: https://www.sellerassistant.app/blog/how-to-read-a-keepa-graph
38. CamelCamelCamel tutorial: https://ecomcircles.com/blog/how-to-use-camelcamelcamel/
39. CamelCamelCamel review: https://www.sellerapp.com/camelcamelcamel-review.html
40. PriceHistory deals page: https://pricehistoryapp.com/deals ; about: https://pricehistoryapp.com/about-us
41. Keepa overview: https://revenuegeeks.com/software/keepa
42. Amazon.in in-app price history (Nov 2025): https://www.businesstoday.in/technology/news/story/amazon-india-rolls-out-in-app-price-history-feature-502256-2025-11-14
43. Indian deal tools roundup: https://www.freepressjournal.in/amp/tech/flipkart-big-billion-days-amazon-great-indian-festival-ai-tools-for-finding-real-online-deals-in-india
44. Buyhatke Chrome listing: https://chromewebstore.google.com/detail/buyhatke-price-history-tr/ojplmecpdpgccookcobabopnaifgidhf?hl=en
45. PriceHistory on AlternativeTo (drop chances, stores): https://alternativeto.net/software/pricehistory/about
46. Wachete homepage (12-month history with charts and spreadsheet download; Slack, Teams, Discord, Telegram): https://wachete.com/

Caveats: camelcamelcamel.com/features could not be fetched, so the CamelCamelCamel points come from third-party write-ups. Some vendor pages describe features only briefly, and those gaps are noted in the tables.
