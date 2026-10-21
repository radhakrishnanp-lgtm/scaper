import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

process.env.SCAPER_SCHEDULER = "off";

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { runScrape } = await import("@/server/scrape");
const { createWatcher, getWatcher, listSnapshots } = await import("@/server/repo/watchers");
const { checkWatcher } = await import("@/server/watch/runner");
const { listNotifications } = await import("@/server/repo/notifications");
const { trackProduct } = await import("@/server/deals/tracker");
const { closeBrowser, browserInstalled } = await import("@/server/fetcher/browser");

let site: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  site = await startFixtureServer();
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true } });
});
afterAll(async () => { await closeBrowser(); await site.close(); });

describe("scraping end to end (fast mode)", () => {
  it("scrapes a listing with auto extraction and stores the run", async () => {
    const run = await runScrape({ url: `${site.base}/listing`, mode: "fast", extract: { type: "auto" } });
    expect(run.status).toBe("ok");
    expect(run.result?.datasets.some((d) => d.name.startsWith("Repeated items") && d.rows.length === 5)).toBe(true);
    expect(site.hits).toContain("/robots.txt");
  });

  it("refuses pages robots.txt disallows", async () => {
    const run = await runScrape({ url: `${site.base}/secret`, mode: "fast", extract: { type: "auto" } });
    expect(run.status).toBe("blocked");
    expect(run.error).toMatch(/robots\.txt/);
    expect(site.hits).not.toContain("/secret");
  });

  it("stops at a CAPTCHA instead of bypassing it", async () => {
    // A different host name, so the backoff this triggers doesn't slow the other tests.
    const run = await runScrape({ url: `${site.base.replace("127.0.0.1", "localhost")}/captcha`, mode: "fast", extract: { type: "auto" } });
    expect(run.status).toBe("blocked");
    expect(run.error).toMatch(/does not bypass bot checks/);
  });

  it("blocks private addresses unless allowed", async () => {
    saveSettings({ scraping: { allowPrivateNetwork: false } });
    const run = await runScrape({ url: `${site.base}/listing`, mode: "fast", extract: { type: "auto" } });
    expect(run.error).toMatch(/private/i);
    saveSettings({ scraping: { allowPrivateNetwork: true } });
  });
});

describe("watcher end to end", () => {
  it("saves a baseline, detects a price drop, and alerts once", async () => {
    site.pages.set("/watch", { body: `<html><body><h1>Deal</h1><span class="price">₹2,000</span></body></html>` });
    const w = createWatcher({
      name: "Fixture price", url: `${site.base}/watch`, mode: "fast", target: { type: "selector", selector: ".price" },
      condition: { type: "below", value: 1800 }, notify: { desktop: true, webhook: false, telegram: false }, intervalMinutes: 60, enabled: true, ignoreLines: [],
    });
    const first = await checkWatcher(getWatcher(w.id)!);
    expect(first).toMatchObject({ status: "ok", changed: false, triggered: false, value: 2000 });

    site.pages.set("/watch", { body: `<html><body><h1>Deal</h1><span class="price">₹1,750</span></body></html>` });
    const second = await checkWatcher(getWatcher(w.id)!);
    expect(second).toMatchObject({ changed: true, triggered: true, value: 1750 });

    site.pages.set("/watch", { body: `<html><body><h1>Deal</h1><span class="price">₹1,700</span></body></html>` });
    const third = await checkWatcher(getWatcher(w.id)!);
    expect(third).toMatchObject({ changed: true, triggered: false });

    const alerts = listNotifications().items.filter((n) => n.watcher_id === w.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toMatch(/below 1,800/);
    const after = getWatcher(w.id)!;
    expect(after).toMatchObject({ check_count: 3, change_count: 2, last_value: 1700, last_status: "ok" });
    expect(listSnapshots(w.id, { changedOnly: true }).items).toHaveLength(2);
  }, 30_000);

  it("an unchanged page does not add snapshots", async () => {
    site.pages.set("/static", { body: "<p>Same</p>" });
    const w = createWatcher({
      name: "Static", url: `${site.base}/static`, mode: "fast", target: { type: "page" }, condition: { type: "any_change" },
      notify: { desktop: false, webhook: false, telegram: false }, intervalMinutes: 5, enabled: true, ignoreLines: [],
    });
    await checkWatcher(getWatcher(w.id)!);
    await checkWatcher(getWatcher(w.id)!);
    expect(listSnapshots(w.id).items).toHaveLength(1);
  }, 30_000);
});

const hasBrowser = browserInstalled() || fs.existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? "/nonexistent");

describe.skipIf(!hasBrowser)("browser mode", () => {
  it("renders JavaScript before extracting", async () => {
    const fast = await runScrape({ url: `${site.base}/js`, mode: "fast", extract: { type: "selectors", itemSelector: "li.row", fields: [{ name: "t", selector: "a", attr: "text", multiple: false }] } });
    expect(fast.row_count).toBe(0);
    const browser = await runScrape({ url: `${site.base}/js`, mode: "browser", extract: { type: "selectors", itemSelector: "li.row", fields: [{ name: "t", selector: "a", attr: "text", multiple: false }, { name: "price", selector: ".p", attr: "text", multiple: false }] } });
    expect(browser.status).toBe("ok");
    expect(browser.result?.datasets[0]?.rows[4]).toMatchObject({ t: "Rendered item number 5", price_value: 500 });
  }, 60_000);

  it("tracks a product and records the first price point", async () => {
    const r = await trackProduct({ url: `${site.base}/dp/B0TESTASIN`, intervalMinutes: 60 });
    expect(r.error).toBeUndefined();
    expect(r.product).toMatchObject({ current_price: 2499, title: expect.stringContaining("Aria") });
    expect(r.product.stats.points).toBe(1);
  }, 60_000);
});
