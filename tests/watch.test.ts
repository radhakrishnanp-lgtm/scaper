import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-watch-"));

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { createWatcher, getWatcher, latestSnapshot } = await import("@/server/repo/watchers");
const { checkWatcher, applyFilters, compareKey } = await import("@/server/watch/runner");
const { listNotifications } = await import("@/server/repo/notifications");
const { combine, evaluate } = await import("@/server/watch/conditions");
const { inWindow, nextInWindow, nextCheckTime, previewCron } = await import("@/server/watch/schedule");
const { compareImages } = await import("@/server/watch/visual");
const { readJsonPath, feedLines, sitemapLines } = await import("@/server/watch/targets");
const { watcherSchema } = await import("@/lib/schemas");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  site = await startFixtureServer();
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true }, notifications: { failureAlertAfter: 2 } });
});
afterAll(async () => { await site.close(); });

const make = (input: Record<string, unknown>) =>
  createWatcher(watcherSchema.parse({ mode: "fast", intervalMinutes: 60, notify: { desktop: true }, condition: { type: "any_change" }, ...input }));
const check = async (id: string) => checkWatcher(getWatcher(id)!);
const alertsFor = (id: string) => listNotifications({ limit: 100 }).items.filter((n) => n.watcher_id === id);

const rss = (items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items.map((t, i) => `<item><title>${t}</title><link>https://example.com/p/${i}</link></item>`).join("")}</channel></rss>`;

describe("watch targets", () => {
  it("feed: alerts on new posts only", async () => {
    site.pages.set("/feed.xml", { body: rss(["First post", "Second post"]), type: "application/rss+xml" });
    const w = make({ name: "Feed", url: `${site.base}/feed.xml`, target: { type: "feed" }, options: { triggerOn: "added" } });
    expect(await check(w.id)).toMatchObject({ status: "ok", changed: false, value: 2 });
    site.pages.set("/feed.xml", { body: rss(["New post", "First post", "Second post"]), type: "application/rss+xml" });
    expect(await check(w.id)).toMatchObject({ changed: true, triggered: true, value: 3 });
    // A post removed is a change, but this watcher only counts additions.
    site.pages.set("/feed.xml", { body: rss(["New post", "First post"]), type: "application/rss+xml" });
    expect(await check(w.id)).toMatchObject({ changed: true, triggered: false });
    expect(alertsFor(w.id)).toHaveLength(1);
    expect(alertsFor(w.id)[0]!.body).toContain("New post");
  }, 30_000);

  it("sitemap: lists URLs matching the filter", async () => {
    site.pages.set("/sitemap.xml", { body: `<urlset><url><loc>https://ex.com/blog/a</loc></url><url><loc>https://ex.com/shop/x</loc></url></urlset>`, type: "application/xml" });
    const w = make({ name: "Sitemap", url: `${site.base}/sitemap.xml`, target: { type: "sitemap", include: "/blog/" } });
    await check(w.id);
    expect(latestSnapshot(w.id)!.content).toBe("https://ex.com/blog/a");
    site.pages.set("/sitemap.xml", { body: `<urlset><url><loc>https://ex.com/blog/a</loc></url><url><loc>https://ex.com/blog/b</loc></url><url><loc>https://ex.com/shop/y</loc></url></urlset>`, type: "application/xml" });
    expect(await check(w.id)).toMatchObject({ changed: true, triggered: true, value: 2 });
  }, 30_000);

  it("json: watches one value by path", async () => {
    site.pages.set("/api/price.json", { body: JSON.stringify({ data: { items: [{ price: 120, name: "A" }], updated: "t1" } }), type: "application/json" });
    const w = make({ name: "JSON", url: `${site.base}/api/price.json`, target: { type: "json", path: "data.items[0].price" }, condition: { type: "below", value: 100 } });
    expect(await check(w.id)).toMatchObject({ value: 120, triggered: false });
    // A change elsewhere in the document is not a change of the watched value.
    site.pages.set("/api/price.json", { body: JSON.stringify({ data: { items: [{ price: 120, name: "A" }], updated: "t2" } }), type: "application/json" });
    expect(await check(w.id)).toMatchObject({ changed: false });
    site.pages.set("/api/price.json", { body: JSON.stringify({ data: { items: [{ price: 95, name: "A" }], updated: "t3" } }), type: "application/json" });
    expect(await check(w.id)).toMatchObject({ value: 95, triggered: true });
  }, 30_000);

  it("status: reports down and up as results, not failures", async () => {
    site.pages.set("/health", { body: "ok" });
    const w = make({ name: "Uptime", url: `${site.base}/health`, target: { type: "status", maxMs: null }, condition: { type: "contains", text: "down" } });
    expect(await check(w.id)).toMatchObject({ status: "ok", triggered: false });
    site.pages.set("/health", { status: 503, body: "maintenance" });
    const down = await check(w.id);
    expect(down).toMatchObject({ status: "ok", changed: true, triggered: true });
    expect(latestSnapshot(w.id)!.content).toMatch(/down \(HTTP 503\)/);
    site.pages.set("/health", { body: "ok" });
    expect(await check(w.id)).toMatchObject({ status: "ok", changed: true, triggered: false });
  }, 30_000);
});

describe("watcher rules", () => {
  it("combines conditions with all / any and scopes text to added lines", async () => {
    site.pages.set("/news", { body: `<ul><li>Old story</li></ul>` });
    const w = make({
      name: "Scoped", url: `${site.base}/news`, target: { type: "selector", selector: "ul" },
      condition: { type: "contains", text: "sale", scope: "added" }, options: { moreConditions: [{ type: "not_contains", text: "sold out", scope: "added" }], match: "all" },
    });
    await check(w.id);
    site.pages.set("/news", { body: `<ul><li>Old story</li><li>Big sale today</li></ul>` });
    expect(await check(w.id)).toMatchObject({ triggered: true });
    // "sale" is still on the page but not in the new lines, so no second alert.
    site.pages.set("/news", { body: `<ul><li>Old story</li><li>Big sale today</li><li>Weather</li></ul>` });
    expect(await check(w.id)).toMatchObject({ changed: true, triggered: false });
    // Both conditions must hold: a new "sale" line that also says sold out does not alert.
    site.pages.set("/news", { body: `<ul><li>Old story</li><li>Flash sale — sold out</li></ul>` });
    const last = await check(w.id);
    expect(last.triggered).toBe(false);
    expect(last.verdict?.results.map((r) => r.met)).toEqual([true, false]);
  }, 30_000);

  it("ignores numbers and filtered lines when asked", async () => {
    site.pages.set("/counter", { body: `<p>Visitors: 100</p><p>Updated 10:01</p><p>Stock: 5 left</p>` });
    const w = make({ name: "Noise", url: `${site.base}/counter`, target: { type: "page" }, options: { ignoreNumbers: true, ignoreRegex: "^Updated" } });
    await check(w.id);
    site.pages.set("/counter", { body: `<p>Visitors: 250</p><p>Updated 10:07</p><p>Stock: 4 left</p>` });
    expect(await check(w.id)).toMatchObject({ changed: false });
    site.pages.set("/counter", { body: `<p>Visitors: 250</p><p>Updated 10:09</p><p>Sold out</p>` });
    expect(await check(w.id)).toMatchObject({ changed: true, triggered: true });
  }, 30_000);

  it("holds alerts during the cooldown", async () => {
    site.pages.set("/cool", { body: `<p>v1</p>` });
    const w = make({ name: "Cooldown", url: `${site.base}/cool`, target: { type: "page" }, options: { cooldownMinutes: 60 } });
    await check(w.id);
    site.pages.set("/cool", { body: `<p>v2</p>` });
    expect(await check(w.id)).toMatchObject({ triggered: true });
    site.pages.set("/cool", { body: `<p>v3</p>` });
    const held = await check(w.id);
    expect(held).toMatchObject({ changed: true, triggered: false });
    expect(held.verdict?.suppressed).toMatch(/quiet period/);
  }, 30_000);

  it("alerts once after repeated failures, and once when it recovers", async () => {
    site.pages.set("/flaky", { body: `<div class="x">here</div>` });
    const w = make({ name: "Flaky", url: `${site.base}/flaky`, target: { type: "selector", selector: ".x" } });
    await check(w.id);
    site.pages.set("/flaky", { body: `<div>gone</div>` });
    expect(await check(w.id)).toMatchObject({ status: "error" });
    expect(alertsFor(w.id)).toHaveLength(0); // one failure is not enough
    await check(w.id);
    await check(w.id);
    expect(alertsFor(w.id).filter((a) => /keeps failing/.test(a.title))).toHaveLength(1);
    expect(getWatcher(w.id)!.fail_count).toBe(3);
    site.pages.set("/flaky", { body: `<div class="x">here</div>` });
    expect(await check(w.id)).toMatchObject({ status: "ok" });
    expect(alertsFor(w.id).filter((a) => /working again/.test(a.title))).toHaveLength(1);
    expect(getWatcher(w.id)).toMatchObject({ fail_count: 0, error_alerted_at: null });
  }, 30_000);
});

describe("rule logic", () => {
  const cur = { content: "x", value: 10 };
  it("any: fires when one condition fires; all: needs every one", () => {
    const a = evaluate({ type: "below", value: 20 }, null, cur, true);
    const b = evaluate({ type: "above", value: 50 }, null, cur, true);
    expect(combine([a, b], "any", false).notify).toBe(true);
    expect(combine([a, b], "all", false)).toMatchObject({ met: false, notify: false });
    expect(combine([a, a], "all", true).notify).toBe(false); // already true last time
  });

  it("noise filters", () => {
    expect(applyFilters("keep 1\ndrop me\nkeep 2", ["drop"], { onlyMatching: "", ignoreRegex: "" })).toBe("keep 1\nkeep 2");
    expect(applyFilters("price 10\nads\nprice 12", [], { onlyMatching: "^price", ignoreRegex: "12" })).toBe("price 10");
    expect(compareKey("Total 1,299.00  ITEMS", { ignoreNumbers: true, ignoreCase: true })).toBe("total # items");
  });

  it("targets parse JSON paths, feeds and sitemaps", () => {
    const doc = { a: { list: [{ p: 1 }, { p: 2 }] } };
    expect(readJsonPath(doc, "a.list[1].p")).toBe(2);
    expect(readJsonPath(doc, "$.a.list[*].p")).toEqual([1, 2]);
    expect(readJsonPath(doc, "a.missing")).toBeUndefined();
    expect(feedLines(`<feed><entry><title>Atom one</title><link href="https://x/1"/></entry></feed>`)).toEqual(["Atom one — https://x/1"]);
    expect(sitemapLines(`<loc>https://x/b</loc><loc>https://x/a?x=1&amp;y=2</loc>`, [])).toEqual(["https://x/a?x=1&y=2", "https://x/b"]);
  });
});

describe("schedules", () => {
  const office = { enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
  it("active hours, including overnight windows", () => {
    expect(inWindow(new Date(2026, 9, 21, 10, 0), office)).toBe(true); // Wednesday 10:00
    expect(inWindow(new Date(2026, 9, 21, 19, 0), office)).toBe(false);
    expect(inWindow(new Date(2026, 9, 24, 10, 0), office)).toBe(false); // Saturday
    const night = { enabled: true, start: "22:00", end: "06:00", days: [5] }; // Friday night
    expect(inWindow(new Date(2026, 9, 23, 23, 0), night)).toBe(true);
    expect(inWindow(new Date(2026, 9, 24, 3, 0), night)).toBe(true); // early Saturday is still Friday's window
    expect(inWindow(new Date(2026, 9, 24, 23, 0), night)).toBe(false);
  });

  it("moves checks into the window and backs off after failures", () => {
    const friEvening = new Date(2026, 9, 23, 19, 0);
    expect(nextInWindow(friEvening, office)).toEqual(new Date(2026, 9, 26, 9, 0)); // Monday 09:00
    const from = new Date(2026, 9, 21, 10, 0);
    const normal = nextCheckTime(60, { cron: null, activeHours: { ...office, enabled: false } }, 0, from).getTime() - from.getTime();
    expect(normal).toBeGreaterThanOrEqual(3600_000);
    expect(normal).toBeLessThanOrEqual(3960_000);
    const failing = nextCheckTime(60, { cron: null, activeHours: { ...office, enabled: false } }, 3, from).getTime() - from.getTime();
    expect(failing).toBeGreaterThanOrEqual(6 * 3600_000);
    expect(nextCheckTime(60, { cron: "30 9 * * *", activeHours: { ...office, enabled: false } }, 0, from)).toEqual(new Date(2026, 9, 22, 9, 30));
  });

  it("previews cron runs and rejects bad expressions", () => {
    const runs = previewCron("0 9 * * 1-5", 3, new Date(2026, 9, 23, 12, 0)); // Friday noon
    expect(runs.map((r) => new Date(r).getDay())).toEqual([1, 2, 3]);
    expect(() => previewCron("not a cron")).toThrow();
  });
});

describe("visual compare", () => {
  const png = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]) => {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    return PNG.sync.write(img);
  };
  it("measures the share of changed pixels and handles size changes", () => {
    const a = png(100, 100, () => [255, 255, 255]);
    const b = png(100, 100, (x, y) => (x < 10 && y < 10 ? [0, 0, 0] : [255, 255, 255]));
    expect(compareImages(a, a).percent).toBe(0);
    const cmp = compareImages(a, b);
    expect(cmp.percent).toBeCloseTo(1, 1);
    expect(PNG.sync.read(cmp.diff).width).toBe(100);
    const taller = png(100, 150, () => [255, 255, 255]);
    expect(compareImages(a, taller).percent).toBeGreaterThan(30);
  });
});
