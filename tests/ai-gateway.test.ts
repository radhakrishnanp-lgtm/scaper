import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";

process.env.SCAPER_SCHEDULER = "off";
const { db, openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { getSettings, publicSettings, saveSettings } = await import("@/server/repo/settings");
const { chat, resolveModel, endpointUrl } = await import("@/server/ai/client");
const { buildPageContext, chunkMarkdown } = await import("@/server/ai/context");
const { aiExtract } = await import("@/server/ai/extract");
const { planCategoryScrape } = await import("@/server/ai/crawl");
const { withWork } = await import("@/server/privacy");
const { listAiCalls } = await import("@/server/repo/ai");
const { getRun } = await import("@/server/repo/scrapes");
const { wipeHistory, timeline } = await import("@/server/repo/history");
const { runScrape, runTask } = await import("@/server/tasks/engine");
const { extractSchema, taskOptionsSchema } = await import("@/lib/schemas");

type Llm = Awaited<ReturnType<typeof startMockLlm>>;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let a: Llm; // primary provider: can be told to fail
let b: Llm; // fallback provider
let aDown = false;
let aRejectsJsonMode = false;

const STORE = (n: number, cat: string) => `<html><head><title>${cat} | Store</title></head><body>
  <header><nav><a href="/store">Home</a><a href="/store/c/travel">Travel</a><a href="/store/c/poetry">Poetry</a><a href="/cart">Cart</a><a href="/login">Sign in</a></nav></header>
  <main><h1>${cat}</h1><div class="grid">${[1, 2].map((k) => `<div class="card"><a class="title" href="/store/p/${cat.toLowerCase()}-${n}-${k}">${cat} book ${n}.${k}</a><span class="price">₹${n * 100 + k}</span></div>`).join("")}</div>
  ${n < 2 ? `<a class="next" rel="next" href="/store/c/${cat.toLowerCase()}?page=${n + 1}">Next</a>` : ""}</main><footer><a href="/privacy">Privacy</a></footer></body></html>`;

beforeAll(async () => {
  site = await startFixtureServer();
  site.pages.set("/store", { body: `<html><head><title>Book Store</title></head><body><header><nav><a href="/store/c/travel">Travel</a><a href="/store/c/poetry">Poetry</a><a href="/store/c/cooking">Cooking</a><a href="/cart">Cart</a></nav></header><main><h1>Welcome</h1><p>${"Books for every reader. ".repeat(20)}</p></main></body></html>` });
  for (const cat of ["Travel", "Poetry", "Cooking"]) {
    site.pages.set(`/store/c/${cat.toLowerCase()}`, { body: STORE(1, cat) });
    site.pages.set(`/store/c/${cat.toLowerCase()}?page=2`, { body: STORE(2, cat) });
  }
  site.pages.set("/catalog", { body: `<html><head><title>Catalog</title></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><main><h1>Headphones</h1>
    <ul><li><a href="/p/aria">Aria Headphones</a> <b>₹1,299</b> <img src="/img/aria.jpg" alt="Aria"></li><li><a href="/p/bolt">Bolt Earbuds</a> <b>₹899</b></li></ul></main><footer>© Shop</footer></body></html>` });

  a = await startMockLlm((messages, body) => {
    if (aDown) return { __status: 503, error: "overloaded" };
    if (aRejectsJsonMode && body.response_format) return { __status: 400, error: "response_format json_object is not supported by this model" };
    const all = JSON.stringify(messages);
    const user = messages.filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n");
    if (all.includes("You plan a scrape")) {
      const num = (name: string) => Number(new RegExp(`\\[(\\d+)\\] \\w+ \\| ${name} \\|`).exec(user)?.[1]);
      return { content: JSON.stringify({ start_is_listing: false, categories: [{ link: num("Travel"), name: "Travel" }, { link: num("Poetry"), name: "Poetry" }, { link: 999, name: "Ghost" }], note: "Two book categories." }) };
    }
    if (all.includes("You write CSS selectors")) {
      return { content: JSON.stringify({ itemSelector: ".card", fields: [{ name: "title", selector: "a.title" }, { name: "link", selector: "a.title", attr: "href" }, { name: "price", selector: ".price" }], note: "Book cards." }) };
    }
    if (all.includes("You extract structured data")) {
      const ref = (t: string) => new RegExp(`\\[${t}\\]\\[(\\d+)\\]`).exec(user)?.[1];
      return { content: JSON.stringify({ rows: [
        { name: "Aria Headphones", price: "₹1,299", link: `[${ref("Aria Headphones")}]`, in_stock: "yes" },
        { name: "Bolt Earbuds", price: 899, link: `[${ref("Bolt Earbuds")}]`, in_stock: "no" },
      ] }) };
    }
    return { content: "pong from A" };
  });
  b = await startMockLlm(() => ({ content: "pong from B" }));

  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1 },
    ai: {
      providers: [
        { id: "a", name: "Provider A", baseUrl: a.base, apiKey: "key-a-123456789", auth: "bearer", headers: [{ name: "X-Org-Token", value: "secret-org" }], models: [{ id: "a-big", contextWindow: 32000, inputPrice: 1, outputPrice: 2, tools: null, json: null }], timeoutSeconds: 20, enabled: true },
        { id: "b", name: "Provider B", baseUrl: b.base, apiKey: "key-b", auth: "api-key", headers: [], models: [{ id: "b-small", contextWindow: null, inputPrice: 0, outputPrice: 0, tools: null, json: null }], timeoutSeconds: 20, enabled: true },
      ],
      main: { providerId: "a", model: "a-big" },
      fast: { providerId: "a", model: "a-big" },
      fallbacks: [{ providerId: "b", model: "b-small" }],
      dailyRequestLimit: 500,
    },
  });
});
afterAll(async () => { await site.close(); await a.close(); await b.close(); });
beforeEach(() => { aDown = false; aRejectsJsonMode = false; });

describe("providers and routing", () => {
  it("sends each provider's own key, auth style and headers", async () => {
    const r = await chat([{ role: "user", content: "ping" }], { purpose: "test" });
    expect(r).toMatchObject({ content: "pong from A", model: "a-big", providerName: "Provider A", fallbackFrom: null });
    expect(a.requests.at(-1)).toMatchObject({ auth: "Bearer key-a-123456789", model: "a-big" });
    // 100 tokens in at $1/M + 20 out at $2/M
    expect(r.cost).toBeCloseTo(0.00014, 8);
    expect(endpointUrl("https://x.openai.azure.com/openai/v1?api-version=2025-01-01", "chat/completions")).toBe("https://x.openai.azure.com/openai/v1/chat/completions?api-version=2025-01-01");
  });

  it("falls back to the next provider when one is down, and logs both", async () => {
    aDown = true;
    const r = await chat([{ role: "user", content: "ping" }], { purpose: "test" });
    expect(r.content).toBe("pong from B");
    expect(r.fallbackFrom).toBe("Provider A · a-big");
    const calls = listAiCalls({ purpose: "test" }).items;
    expect(calls[0]).toMatchObject({ status: "ok", provider_name: "Provider B", model: "b-small", fallback_from: "Provider A · a-big" });
    expect(calls[1]).toMatchObject({ status: "error", provider_name: "Provider A" });
    expect(calls[1]!.error).toContain("503");
  });

  it("retries without JSON mode when a provider does not support it", async () => {
    aRejectsJsonMode = true;
    const before = a.requests.length;
    const r = await chat([{ role: "user", content: "ping" }], { json: true, purpose: "test", noFallback: true });
    expect(r.content).toBe("pong from A");
    expect(a.requests.length - before).toBe(2);
    expect(a.requests.at(-1)!.response_format).toBeUndefined();
  });

  it("reuses identical answers when the cache is on", async () => {
    saveSettings({ ai: { cacheHours: 1 } });
    const before = a.requests.length;
    const one = await chat([{ role: "user", content: "same question" }], { cache: true, purpose: "test" });
    const two = await chat([{ role: "user", content: "same question" }], { cache: true, purpose: "test" });
    saveSettings({ ai: { cacheHours: 0 } });
    expect(a.requests.length - before).toBe(1);
    expect(one.cached).toBe(false);
    expect(two).toMatchObject({ cached: true, content: one.content, cost: 0 });
    expect(listAiCalls({ status: "cached" }).items.length).toBe(1);
  });

  it("stops at the monthly budget", async () => {
    saveSettings({ ai: { monthlyBudget: 0.0001 } });
    await expect(chat([{ role: "user", content: "ping" }])).rejects.toThrow(/budget/i);
    saveSettings({ ai: { monthlyBudget: 0 } });
  });

  it("never sends keys or secret headers to the browser, and masked values keep the saved ones", () => {
    const pub = publicSettings(getSettings());
    const p = pub.ai.providers.find((x) => x.id === "a")!;
    expect(p.apiKey).toBe("••••6789");
    expect(p.headers[0]!.value).toMatch(/^••••/);
    expect(JSON.stringify(pub)).not.toContain("key-a-123456789");
    expect(JSON.stringify(pub)).not.toContain("secret-org");
    saveSettings({ ai: { providers: pub.ai.providers.map(({ hasApiKey, ...x }) => ({ ...x, apiKey: hasApiKey ? x.apiKey : "", name: x.id === "a" ? "Renamed A" : x.name })) } });
    const saved = getSettings().ai.providers.find((x) => x.id === "a")!;
    expect(saved).toMatchObject({ name: "Renamed A", apiKey: "key-a-123456789" });
    expect(saved.headers[0]!.value).toBe("secret-org");
  });

  it("turns the old single-provider settings into a provider", () => {
    const s = getSettings().ai;
    const ai = { ...s, providers: [], main: { providerId: "", model: "" }, fast: { providerId: "", model: "" }, baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk", model: "llama-big", fastModel: "llama-small" };
    const r = resolveModel("fast", ai);
    // resolveModel reads the providers already migrated by getSettings; a raw legacy object has none.
    expect(r).toBeNull();
    saveSettings({ ai: { baseUrl: b.base, apiKey: "legacy", model: "old-main", fastModel: "old-fast" } });
    const after = getSettings().ai;
    expect(after.providers.find((x) => x.id === "default")).toMatchObject({ baseUrl: b.base, apiKey: "legacy" });
    expect(after.main).toEqual({ providerId: "default", model: "old-main" });
    expect(after.fast).toEqual({ providerId: "default", model: "old-fast" });
    saveSettings({ ai: { main: { providerId: "a", model: "a-big" }, fast: { providerId: "a", model: "a-big" } } });
  });
});

describe("page context", () => {
  it("keeps the main content, numbers links and leaves out menus and footers", () => {
    const ctx = buildPageContext(site.pages.get("/catalog")!.body, `${site.base}/catalog`, { scope: "main" });
    expect(ctx.title).toBe("Catalog");
    expect(ctx.markdown).toContain("# Headphones");
    expect(ctx.markdown).toMatch(/\[Aria Headphones\]\[\d+\]/);
    expect(ctx.markdown).not.toContain("About");
    expect(ctx.markdown).not.toContain("© Shop");
    expect(ctx.links.some((l) => l.href === `${site.base}/p/aria`)).toBe(true);
  });

  it("splits long pages into overlapping parts", () => {
    const md = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(10)}`).join("\n\n");
    const parts = chunkMarkdown(md, 2000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join("")).toContain("Paragraph 399");
  });
});

describe("AI extraction", () => {
  it("returns typed columns, real links and a grounding check", async () => {
    const html = site.pages.get("/catalog")!.body;
    const r = await aiExtract(html, `${site.base}/catalog`, extractSchema.parse({
      type: "ai", instruction: "each product",
      fields: [{ name: "name", type: "text" }, { name: "price", type: "number" }, { name: "link", type: "url" }, { name: "in_stock", type: "boolean" }],
    }) as never);
    expect(r.dataset.columns).toEqual(["name", "price", "link", "in_stock"]);
    expect(r.dataset.rows).toEqual([
      { name: "Aria Headphones", price: 1299, link: `${site.base}/p/aria`, in_stock: true },
      { name: "Bolt Earbuds", price: 899, link: `${site.base}/p/bolt`, in_stock: false },
    ]);
    expect(r.grounded).toBe(100);
    expect(r.notes.join(" ")).toContain("100%");
  });
});

describe("category scrape", () => {
  it("lets the AI pick categories, then finds items and next pages", async () => {
    const plan = await planCategoryScrape({ url: `${site.base}/store`, goal: "travel and poetry books with price", mode: "fast", maxCategories: 5, pagesPerCategory: 3, model: "main" });
    expect(plan.categories.map((c) => c.name)).toEqual(["Travel", "Poetry"]);
    expect(plan.categories[0]!.url).toBe(`${site.base}/store/c/travel`);
    expect(plan.sample.count).toBe(2);
    expect(plan.pagination).toMatchObject({ type: "next" });
    expect(plan.otherLinks.some((l) => l.url.endsWith("/store/c/cooking"))).toBe(true);
    expect(plan.otherLinks.some((l) => l.url.endsWith("/cart"))).toBe(false);

    const run = await runTask({
      url: plan.startUrl, mode: "fast",
      extract: extractSchema.parse({ type: "selectors", itemSelector: plan.sample.itemSelector, fields: plan.sample.fields }),
      options: taskOptionsSchema.parse({ categories: plan.categories.map(({ name, url }) => ({ name, url })), pagination: plan.pagination, limits: { maxPages: 20, maxRows: 100 } }),
    });
    expect(run.status).toBe("ok");
    const rows = run.result!.datasets[0]!.rows;
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(["Travel", "Poetry"]));
    expect(rows.some((r) => String(r.title).includes("Poetry book 2.1"))).toBe(true);
  }, 30_000);
});

describe("private mode and history", () => {
  const count = (t: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  it("keeps private work out of the database", async () => {
    const calls = count("ai_calls");
    const runs = count("scrape_runs");
    const stats = count("host_stats");
    const run = await withWork({ private: true }, async () => {
      await chat([{ role: "user", content: "private ping" }]);
      return runScrape({ url: `${site.base}/catalog`, mode: "fast", extract: { type: "auto" } });
    });
    expect(run.private).toBe(true);
    expect(getRun(run.id)?.id).toBe(run.id);
    expect(count("ai_calls")).toBe(calls);
    expect(count("scrape_runs")).toBe(runs);
    expect(count("host_stats")).toBe(stats);
    expect(JSON.stringify(db().prepare("SELECT request FROM ai_calls").all())).not.toContain("private ping");
  });

  it("shows saved work on the timeline and wipes it for good", async () => {
    await runScrape({ url: `${site.base}/catalog`, mode: "fast", extract: { type: "auto" } });
    expect(timeline({ types: ["scrape"] }).items.length).toBeGreaterThan(0);
    expect(timeline({ types: ["ai"] }).items.length).toBeGreaterThan(0);
    const removed = wipeHistory(["scrapes", "ai_log", "private"]);
    expect(removed.scrapes).toBeGreaterThan(0);
    expect(removed.ai_log).toBeGreaterThan(0);
    expect(count("scrape_runs")).toBe(0);
    expect(count("ai_calls")).toBe(0);
    expect(timeline({ types: ["scrape", "ai"] }).items).toEqual([]);
  });
});
