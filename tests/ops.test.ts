import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

process.env.SCAPER_SCHEDULER = "off";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-ops-"));
process.env.SCAPER_DATA_DIR = tmp;

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings, publicSettings } = await import("@/server/repo/settings");
const { applyTransforms } = await import("@/server/extract/transforms");
const { extractWithSelectors } = await import("@/server/extract/selectors");
const { expandUrlTemplate, parseUrlList, compilePatterns, matchesAny, normalizeForVisit, parseSitemap } = await import("@/server/tasks/urls");
const { parseCsv, csvRecords, fillTemplate, toCsv } = await import("@/lib/csv");
const { createToken, verifyToken, revokeToken, listTokens } = await import("@/server/repo/tokens");
const { exportConfig, importConfig } = await import("@/server/ops/config");
const { createBackup, listBackups, deleteBackup, backupPath, pruneBackups } = await import("@/server/ops/backup");
const { createRecipe } = await import("@/server/repo/scrapes");
const { createWatcher } = await import("@/server/repo/watchers");
const { upsertSiteRule, publicRule, getSiteRule } = await import("@/server/repo/sites");
const { fetchPage } = await import("@/server/fetcher");
const { deliver } = await import("@/server/notify");
const { listNotifications } = await import("@/server/repo/notifications");
const { listEvents } = await import("@/server/repo/events");
const { dealStats } = await import("@/server/deals/score");
const { pageOutline } = await import("@/server/ai/suggest");
const { taskSchema, watcherSchema, siteRuleSchema, transformSchema } = await import("@/lib/schemas");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  site = await startFixtureServer();
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true } });
});
afterAll(async () => { await site.close(); });

describe("field transforms", () => {
  const t = (value: string | null, steps: unknown[]) => applyTransforms(value, steps.map((s) => transformSchema.parse(s)), "https://shop.example/a/");
  it("cleans values step by step", () => {
    expect(t("  Hello   World ", [{ op: "trim" }, { op: "upper" }])).toBe("HELLO WORLD");
    expect(t("Rating: 4.5 out of 5", [{ op: "number" }])).toBe(4.5);
    expect(t("₹1,299", [{ op: "number" }])).toBe(1299);
    expect(t("SKU: AB-123 (new)", [{ op: "regex", pattern: "SKU: ([\\w-]+)" }])).toBe("AB-123");
    expect(t("a/b/c", [{ op: "split", separator: "/", index: -1 }])).toBe("c");
    expect(t("img/x.png", [{ op: "absoluteUrl" }])).toBe("https://shop.example/a/img/x.png");
    expect(t("<b>bold</b> text", [{ op: "stripHtml" }])).toBe("bold text");
    expect(t("cheap", [{ op: "replace", find: "cheap", with: "affordable" }, { op: "prefix", value: "Very " }])).toBe("Very affordable");
    expect(t(null, [{ op: "default", value: "n/a" }])).toBe("n/a");
    expect(t("", [{ op: "trim" }])).toBeNull();
  });

  it("applies transforms and required fields during extraction", () => {
    const html = `<div class="i"><b>  Item A </b><i>₹10</i></div><div class="i"><b>Item B</b></div>`;
    const ds = extractWithSelectors(html, "https://x/", {
      itemSelector: ".i",
      fields: [{ name: "name", selector: "b", transforms: [{ op: "trim" }, { op: "lower" }] }, { name: "price", selector: "i", transforms: [{ op: "number" }], required: true }],
    });
    expect(ds.rows).toEqual([{ name: "item a", price: 10 }]);
  });
});

describe("URL helpers", () => {
  it("expands ranges, steps and lists", () => {
    expect(expandUrlTemplate("https://s/p/{1..3}")).toEqual(["https://s/p/1", "https://s/p/2", "https://s/p/3"]);
    expect(expandUrlTemplate("https://s/p?o={0..20..10}")).toEqual(["https://s/p?o=0", "https://s/p?o=10", "https://s/p?o=20"]);
    expect(expandUrlTemplate("https://s/{tv,phones}/{1..2}")).toHaveLength(4);
    expect(expandUrlTemplate("https://s/{1..100000}")).toHaveLength(5000);
  });
  it("parses pasted lists, skipping comments and duplicates", () => {
    expect(parseUrlList(["example.com/a\n# note\nhttps://example.com/a\n\nhttps://example.com/b"])).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
  it("matches globs and /regex/ patterns", () => {
    const p = compilePatterns("/blog/*, /\\/p\\/\\d+$/");
    expect(matchesAny("https://x.com/blog/hello", p, false)).toBe(true);
    expect(matchesAny("https://x.com/blog/a/b", p, false)).toBe(false);
    expect(matchesAny("https://x.com/p/42", p, false)).toBe(true);
    expect(matchesAny("https://x.com/anything", [], true)).toBe(true);
  });
  it("normalizes URLs for visiting and reads sitemaps", () => {
    expect(normalizeForVisit("https://x.com/a?utm_source=n&id=2#top")).toBe("https://x.com/a?id=2");
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({ urls: [], sitemaps: ["https://x.com/s1.xml"] });
    expect(parseSitemap(`<urlset><url><loc>https://x.com/a</loc></url></urlset>`).urls).toEqual(["https://x.com/a"]);
  });
});

describe("CSV", () => {
  it("parses quoted fields, commas and new lines", () => {
    expect(parseCsv(`a,b\n"x, y","say ""hi"""\n"multi\nline",2\n`)).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["multi\nline", "2"]]);
    expect(csvRecords("q,city\nshoes,Pune\n,\n")).toEqual([{ q: "shoes", city: "Pune" }]);
  });
  it("fills templates, encoding for URLs", () => {
    expect(fillTemplate("https://s/?q={{q}}&c={{ city }}", { q: "red shoes", city: "Pune" }, true)).toBe("https://s/?q=red%20shoes&c=Pune");
    // A missing column stays visible instead of silently becoming empty.
    expect(fillTemplate("Hello {{name}} {{missing}}", { name: "Krish" })).toBe("Hello Krish {{missing}}");
  });
  it("neutralizes spreadsheet formulas", () => {
    expect(toCsv(["v"], [{ v: "=HYPERLINK(\"x\")" }])).toContain("'=HYPERLINK");
  });
});

describe("API tokens", () => {
  it("creates, verifies and revokes; only a hash is stored", () => {
    const { token, record } = createToken("Home Assistant");
    expect(token).toMatch(/^scp_[\w-]{30,}$/);
    expect(record.prefix).toBe(token.slice(0, 10));
    expect(verifyToken(token)).toBe(true);
    expect(verifyToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"))).toBe(false);
    expect(verifyToken("Bearer nonsense")).toBe(false);
    expect(JSON.stringify(listTokens())).not.toContain(token);
    expect(listTokens()[0]!.last_used_at).not.toBeNull();
    expect(revokeToken(record.id)).toBe(true);
    expect(verifyToken(token)).toBe(false);
  });
});

describe("config export and import", () => {
  it("round-trips tasks, watchers and site rules without secrets, and skips duplicates", () => {
    createRecipe(taskSchema.parse({ name: "Export me", url: "https://shop.example/list", mode: "fast", extract: { type: "auto" }, tags: ["shop"] }));
    createWatcher(watcherSchema.parse({ name: "Watch me", url: "https://news.example/", target: { type: "page" }, condition: { type: "any_change" }, notify: {}, intervalMinutes: 30 }));
    upsertSiteRule(siteRuleSchema.parse({ host: "shop.example", delaySeconds: 10, headers: [{ name: "X-Api-Key", value: "secret-key" }, { name: "Accept-Language", value: "hi" }], cookies: "session=abc" }));
    const cfg = exportConfig();
    const text = JSON.stringify(cfg);
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("session=abc");
    expect(cfg.tasks).toHaveLength(1);
    expect(cfg.siteRules[0]!.headers).toEqual([{ name: "Accept-Language", value: "hi" }]);

    const again = importConfig(cfg);
    expect(again.tasks).toMatchObject({ added: 0, skipped: 1 });
    expect(again.watchers).toMatchObject({ added: 0, skipped: 1 });

    const report = importConfig({ format: "scaper-config", tasks: [{ ...cfg.tasks[0], name: "Imported copy" }, { name: "" }], watchers: [] });
    expect(report.tasks.added).toBe(1);
    expect(report.tasks.errors[0]).toMatch(/#2/);
    expect(() => importConfig({ format: "something-else" })).toThrow();
  });
});

describe("backups", () => {
  it("writes a consistent copy that opens as a database, and prunes old ones", async () => {
    const b = await createBackup();
    expect(b.size).toBeGreaterThan(10_000);
    const copy = new Database(backupPath(b.name)!, { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM recipes").get() as { n: number }).n).toBeGreaterThanOrEqual(1);
    copy.close();
    await createBackup();
    await createBackup();
    expect((await listBackups()).length).toBe(3);
    await pruneBackups(1);
    expect((await listBackups()).length).toBe(1);
    expect(backupPath("../../etc/passwd")).toBeNull();
    expect(await deleteBackup("../x.db")).toBe(false);
    expect(await deleteBackup((await listBackups())[0]!.name)).toBe(true);
  });
});

describe("site rules", () => {
  it("sends a site's cookies and headers only to that site, never across a redirect", async () => {
    upsertSiteRule(siteRuleSchema.parse({ host: "127.0.0.1", cookies: "sid=me", headers: [{ name: "X-Api-Key", value: "k1" }] }));
    const same = JSON.parse((await fetchPage(`${site.base}/echo`, "fast")).html);
    expect(same).toMatchObject({ cookie: "sid=me", key: "k1" });
    const other = JSON.parse((await fetchPage(`${site.base}/go-elsewhere`, "fast")).html);
    expect(other.host).toMatch(/^localhost:/);
    expect(other).toMatchObject({ cookie: null, key: null });
  });

  it("hides cookies and header values from the browser and can pause a host", async () => {
    const pub = publicRule(getSiteRule("127.0.0.1")!);
    expect(JSON.stringify(pub)).not.toContain("sid=me");
    expect(JSON.stringify(pub)).not.toContain("k1");
    upsertSiteRule(siteRuleSchema.parse({ host: "127.0.0.1", paused: true }), true);
    await expect(fetchPage(`${site.base}/echo`, "fast")).rejects.toThrow(/paused/);
    upsertSiteRule(siteRuleSchema.parse({ host: "127.0.0.1", paused: false }));
  });
});

describe("settings and alerts", () => {
  it("never sends secrets to the browser", () => {
    saveSettings({ ai: { apiKey: "sk-live-123456789" }, notifications: { telegramBotToken: "123:ABCDEFG", smtpPass: "hunter2", slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/xyz" } });
    const text = JSON.stringify(publicSettings(getSettings()));
    for (const secret of ["sk-live-123456789", "123:ABCDEFG", "hunter2", "B0/xyz"]) expect(text).not.toContain(secret);
    expect(publicSettings(getSettings()).ai.hasApiKey).toBe(true);
  });

  it("mute-all keeps alerts in the inbox but sends nothing out", async () => {
    saveSettings({ notifications: { muteAll: true } });
    await deliver({ kind: "system", title: "Muted alert", body: "x" }, { desktop: true, webhook: true });
    expect(listNotifications().items[0]!.title).toBe("Muted alert");
    expect(listEvents(5, undefined, {}).some((e) => e.event === "notify.muted")).toBe(true);
    saveSettings({ notifications: { muteAll: false } });
  });
});

describe("deal stats (Keepa-style)", () => {
  it("reports all-time extremes, long averages, stock and drops", () => {
    const day = 86400_000;
    const nowMs = Date.parse("2026-10-22T00:00:00Z");
    const at = (d: number) => new Date(nowMs - d * day).toISOString();
    const history = [
      { price: 1000, created_at: at(200), in_stock: 1 }, { price: 900, created_at: at(100), in_stock: 1 },
      { price: 1100, created_at: at(60), in_stock: 0 }, { price: 800, created_at: at(10), in_stock: 1 },
    ];
    const s = dealStats(history, 800, 2000, nowMs);
    expect(s.allTimeLow).toEqual({ price: 800, at: at(10) });
    expect(s.allTimeHigh).toEqual({ price: 1100, at: at(60) });
    expect(s.avg90).toBe(950);
    expect(s.avg365).toBe(950);
    expect(s.outOfStockPercent).toBe(25);
    expect(s.drops).toBe(2);
    expect(s.lastChange).toEqual({ from: 1100, to: 800, at: at(10) });
    expect(s.isLowest).toBe(true);
  });
});

describe("AI selector helper", () => {
  it("outlines a page compactly, collapsing long lists", () => {
    const items = Array.from({ length: 40 }, (_, i) => `<li class="row"><a href="/p/${i}">Product ${i}</a></li>`).join("");
    const outline = pageOutline(`<html><body><script>var x=1</script><main id="app"><ul class="list">${items}</ul></main></body></html>`);
    expect(outline).toContain("main#app");
    expect(outline).toContain("ul.list");
    expect(outline).toContain("Product 0");
    expect(outline).not.toContain("Product 39");
    expect(outline).toMatch(/37 more similar li/);
    expect(outline).not.toContain("var x");
  });
});
