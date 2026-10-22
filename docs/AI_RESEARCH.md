# How leading scrapers use LLMs, and what Scaper took from them (Oct 2026)

Research done before the AI upgrade. Each row says what the tool does, what Scaper now does, and where.

## 1. Bring your own model (LLM gateways)

| Seen in | Pattern | Scaper |
|---|---|---|
| LiteLLM, OpenRouter, Portkey, LLM proxies | Many providers behind one OpenAI-compatible API; per-provider base URL, key and headers | Settings → AI: any number of providers, each with base URL, key, auth style (Bearer, Azure `api-key`, none), extra headers, timeout and models. Presets for OpenAI, Azure, OpenRouter, Gemini, Groq, Together, DeepSeek, Mistral, xAI, Fireworks, Cerebras, Ollama, LM Studio, vLLM/LiteLLM |
| Gateways | Model routing and fallbacks on outages and rate limits | Main and fast roles take any saved model; up to 3 fallbacks tried in order on 429/5xx/timeouts (`src/server/ai/client.ts`) |
| Gateways | Retry with backoff, honour `Retry-After`; adapt to providers that reject parameters | 3 tries with backoff; drops `response_format`, renames `max_tokens`, drops `temperature` when a provider refuses them |
| Gateways | Cost tracking per model, budgets, request caps | Prices per model (loaded from OpenRouter-style `/models`), daily request cap, monthly budget |
| Gateways | Request log with prompts, tokens, latency | AI log page: every call with purpose, model, tokens, cost, time, fallback, and the full prompt and reply (optional) |
| Gateways | Response cache | "Reuse identical answers" for N hours (off by default) |
| Gateways | Capability checks | Per-model test: answers, JSON mode, tool calling |

## 2. Giving the model the right context

| Seen in | Pattern | Scaper |
|---|---|---|
| Crawl4AI, Firecrawl, Jina Reader | Page → clean Markdown, menus and footers removed, before the LLM sees it | `buildPageContext` (`src/server/ai/context.ts`): main content as Markdown, headings, lists, tables, JSON-LD kept |
| Crawl4AI | Chunking with overlap for long pages | `chunkMarkdown`; extraction reads up to 6 parts and merges them |
| Firecrawl, Stagehand | Links as references the model can point at instead of copying long URLs | Links and images appear as `[text][n]`; answers like `[12]` become real URLs |
| Firecrawl extract | Context sized to the model | Budget from each model's context window (or the default) |

## 3. Extraction quality

| Seen in | Pattern | Scaper |
|---|---|---|
| Firecrawl extract, Kadoa | Schema-first extraction (typed fields) | AI mode has typed columns: text, number, link, image, yes/no, date, list. Values are converted to the type |
| Thunderbit | "AI suggest fields" | **Suggest columns** in the AI extract editor |
| Kadoa | Validation against the source | Grounding check: the share of values that literally appear on the page is reported with every AI run |
| Kadoa | Self-healing when a site changes | **Fix with AI** on a task: new selectors for the same columns, tested on today's page, applied only when you choose. Tasks can also let the AI read pages where selectors find nothing |
| Thunderbit | Field-level AI prompts (categorise, summarise, translate) | **AI columns** on tasks, filled in batches after scraping |
| All | Repair bad JSON once | One repair round with the error shown to the model |

## 4. Whole-site and category scraping

| Seen in | Pattern | Scaper |
|---|---|---|
| Firecrawl map/crawl, Browse AI, Thunderbit subpages | Discover the site's sections, then scrape each | **Category scrape** page: your model picks category links from the site's menus, Scaper finds the item layout on one category, detects the next-page link, and runs every category page by page. Runs once, privately, or saves as a scheduled task with a `category` column |

## 5. Agents that browse

| Seen in | Pattern | Scaper |
|---|---|---|
| Stagehand (act / extract / observe), Browser Use | Numbered list of interactive elements; the model picks one | The agent's browser lists links, buttons and fields as `[n]`; actions are click, type, submit, select, scroll, back. Scaper's own fixed script tags elements; the model never runs code in the page |
| Browser Use, OpenAI tools | Tool calling with a step budget | 40 tools in 6 groups (read the web, browser, tasks & data, watchers, prices, Scaper itself), step limit in settings |
| Human-in-the-loop agents | Confirm before side effects | "Ask me first" (default): tools that change things wait for Allow / Allow all / Decline |
| Assistants | Memory and standing instructions | Settings → AI: standing instructions and memory notes; the agent can remember and forget |

## 6. History

| Seen in | Pattern | Scaper |
|---|---|---|
| Kadoa, Browse AI | Change history between runs | Run compare: new, gone and changed rows against any earlier run of the task |
| Most tools | Activity feed | Data → Timeline: scrapes, agent chats, page changes, price changes, alerts and AI calls in one list |

## 7. What Scaper deliberately does not copy

Some tools sell "stealth": hiding from the sites they scrape with fingerprint spoofing, residential proxy pools and CAPTCHA solving. Scaper does not do this. It identifies itself with its user agent, follows robots.txt, waits between requests and stops at bot checks. **Private mode** is about this computer only: private work is kept in memory and leaves no results, AI log, site statistics or activity log on disk.

## Sources

- Kadoa features: https://www.kadoa.com/features
- Crawl4AI LLM strategies: https://docs.crawl4ai.com/extraction/llm-strategies/
- Firecrawl, best web extraction tools: https://www.firecrawl.dev/blog/best-web-extraction-tools
- Firecrawl, choosing the data extractor: https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor
- Web Scraper vs Thunderbit: https://webscraper.io/blog/web-scraper-vs-thunderbit
- Stagehand, Browser Use and Playwright for AI agents: https://alexcloudstar.com/blog/ai-browser-agent-stagehand-browser-use-playwright/
- LLM proxies and gateways: https://www.morphllm.com/llm-proxy
