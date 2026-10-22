import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

process.env.SCAPER_SCHEDULER = "off";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-engine-"));
process.env.SCAPER_DATA_DIR = tmp;

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { runTask } = await import("@/server/tasks/engine");
const { createRecipe, seenCount } = await import("@/server/repo/scrapes");
const { listNotifications } = await import("@/server/repo/notifications");
const { enqueue, cancelJob, waitForJob } = await import("@/server/jobs");
const { getJob, jobLogs } = await import("@/server/repo/jobs");
const { closeBrowser } = await import("@/server/fetcher/browser");
const { extractSchema, taskOptionsSchema, taskSchema } = await import("@/lib/schemas");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  site = await startFixtureServer();
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true } });
});
afterAll(async () => { await closeBrowser(); await site.close(); });

const cards = extractSchema.parse({
  type: "selectors", itemSelector: ".card",
  fields: [{ name: "title", selector: "a.title" }, { name: "link", selector: "a.title", attr: "href" }, { name: "price", selector: ".price" }],
});
const opts = (o: Record<string, unknown>) => taskOptionsSchema.parse(o);

describe("multi-page tasks", () => {
  it("follows next-page links and merges rows", async () => {
    const run = await runTask({ url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options: opts({ pagination: { type: "next", selector: "a.next", maxPages: 10 } }) });
    expect(run.status).toBe("ok");
    expect(run.page_count).toBe(3);
    const rows = run.result!.datasets[0]!.rows;
    expect(rows.map((r) => r.title)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"]);
    expect(rows[5]).toMatchObject({ link: `${site.base}/item/6`, price_value: 600 });
    expect(run.result!.pages).toHaveLength(3);
  }, 60_000);

  it("stops at the page limit and says so", async () => {
    const run = await runTask({ url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options: opts({ pagination: { type: "next", selector: "a.next", maxPages: 10 }, limits: { maxPages: 2 } }) });
    expect(run.page_count).toBe(2);
    expect(run.row_count).toBe(4);
    expect(run.result!.notes.join(" ")).toMatch(/page limit/);
  }, 60_000);

  it("opens each item's detail page and adds its fields", async () => {
    const run = await runTask({
      url: `${site.base}/shop?page=1`, mode: "fast", extract: cards,
      options: opts({ detail: { enabled: true, linkField: "link", fields: [{ name: "sku", selector: ".sku" }, { name: "desc", selector: ".desc" }] } }),
    });
    expect(run.status).toBe("ok");
    expect(run.page_count).toBe(3); // list page + 2 details
    expect(run.result!.datasets[0]!.rows).toEqual([
      expect.objectContaining({ title: "Item 1", sku: "SKU-1", desc: "Details for item 1" }),
      expect.objectContaining({ title: "Item 2", sku: "SKU-2" }),
    ]);
  }, 60_000);

  it("skips detail pages earlier runs already scraped (incremental)", async () => {
    const task = createRecipe(taskSchema.parse({
      name: "Incremental shop", url: `${site.base}/shop?page=1`, mode: "fast", extract: cards,
      options: { incremental: true, detail: { enabled: true, fields: [{ name: "sku", selector: ".sku" }] } },
    }));
    const first = await runTask({ url: task.url, mode: "fast", extract: task.extract, options: task.options, recipeId: task.id, taskName: task.name });
    expect(first.row_count).toBe(2);
    expect(seenCount(task.id)).toBe(2);
    const before = site.hits.filter((h) => h.startsWith("/item/")).length;
    const second = await runTask({ url: task.url, mode: "fast", extract: task.extract, options: task.options, recipeId: task.id, taskName: task.name });
    expect(second.row_count).toBe(0);
    expect(site.hits.filter((h) => h.startsWith("/item/")).length).toBe(before);
  }, 60_000);

  it("runs once per CSV input row with {{column}} in the URL", async () => {
    const run = await runTask({
      url: `${site.base}/search?q={{q}}`, mode: "fast",
      extract: extractSchema.parse({ type: "selectors", itemSelector: ".card", fields: [{ name: "title", selector: "a.title" }] }),
      options: opts({ inputs: "q\nred\nblue\n" }),
    });
    expect(run.status).toBe("ok");
    expect(run.result!.datasets[0]!.rows).toEqual([
      { title: "Red shoe", input_q: "red" }, { title: "Red hat", input_q: "red" }, { title: "Blue shirt", input_q: "blue" },
    ]);
  }, 60_000);

  it("expands URL ranges in the start URLs", async () => {
    const run = await runTask({
      url: `${site.base}/item/{1..3}`, mode: "fast",
      extract: extractSchema.parse({ type: "selectors", fields: [{ name: "name", selector: "h1" }, { name: "sku", selector: ".sku" }] }),
      options: opts({ startUrls: [`${site.base}/item/5`], includeSourceUrl: true }),
    });
    expect(run.page_count).toBe(4);
    expect(run.result!.datasets[0]!.rows.map((r) => r.sku)).toEqual(["SKU-1", "SKU-2", "SKU-3", "SKU-5"]);
    expect(run.result!.datasets[0]!.rows[0]!.source_url).toBe(`${site.base}/item/1`);
  }, 60_000);

  it("crawls matching links on the same site, up to the depth limit", async () => {
    const extract = extractSchema.parse({ type: "selectors", fields: [{ name: "heading", selector: "h1" }] });
    const shallow = await runTask({ url: `${site.base}/blog`, mode: "fast", extract, options: opts({ crawl: { enabled: true, include: "/blog/*", maxDepth: 1 } }) });
    expect(shallow.result!.datasets[0]!.rows.map((r) => r.heading)).toEqual(["Blog", "Post one", "Post two"]);
    const deep = await runTask({ url: `${site.base}/blog`, mode: "fast", extract, options: opts({ crawl: { enabled: true, include: "/blog/*", exclude: "post-2", maxDepth: 2 } }) });
    expect(deep.result!.datasets[0]!.rows.map((r) => r.heading)).toEqual(["Blog", "Post one", "Post three"]);
    expect(site.hits).not.toContain("/about");
  }, 60_000);

  it("dedupes rows and reports data quality", async () => {
    site.pages.set("/dupes", { body: `<div class="card"><a class="title">A</a></div><div class="card"><a class="title">A</a></div><div class="card"><a class="title">B</a></div>` });
    const run = await runTask({
      url: `${site.base}/dupes`, mode: "fast",
      extract: extractSchema.parse({ type: "selectors", itemSelector: ".card", fields: [{ name: "title", selector: "a.title" }, { name: "price", selector: ".price" }] }),
      options: opts({ dedupeBy: ["title"], quality: { minRows: 5, minFillPercent: 50, alert: false } }),
    });
    expect(run.row_count).toBe(2);
    expect(run.result!.quality!.fill).toMatchObject({ title: 100, price: 0 });
    expect(run.result!.quality!.issues.join(" ")).toMatch(/Only 2 row\(s\).*"price" is filled in only 0%/);
  }, 60_000);

  it("alerts on new and removed rows compared with the previous run", async () => {
    const task = createRecipe(taskSchema.parse({
      name: "Monitored shop", url: `${site.base}/mon`, mode: "fast", extract: cards,
      options: { monitor: { enabled: true, keyFields: ["title"], notifyNew: true, notifyRemoved: true } },
    }));
    site.pages.set("/mon", { body: `<div class="card"><a class="title" href="/a">Alpha</a></div><div class="card"><a class="title" href="/b">Beta</a></div>` });
    const go = () => runTask({ url: task.url, mode: "fast", extract: task.extract, options: task.options, recipeId: task.id, taskName: task.name });
    const base = await go();
    expect(base.result!.monitor).toBeUndefined();
    site.pages.set("/mon", { body: `<div class="card"><a class="title" href="/a">Alpha</a></div><div class="card"><a class="title" href="/c">Gamma</a></div>` });
    const next = await go();
    expect(next.result!.monitor).toMatchObject({ added: 1, removed: 1 });
    expect(next.result!.monitor!.addedRows[0]).toMatchObject({ title: "Gamma" });
    const alert = listNotifications().items.find((n) => n.title.startsWith("Monitored shop"));
    expect(alert?.body).toMatch(/\+ Gamma/);
    expect(alert?.body).toMatch(/- Beta/);
  }, 60_000);

  it("writes the chosen file formats", async () => {
    const run = await runTask({ url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, taskName: "Files test", options: opts({ output: { files: ["csv", "json", "xlsx", "ndjson"] } }) });
    const files = run.result!.files!;
    expect(files.map((f) => path.extname(f))).toEqual([".csv", ".json", ".xlsx", ".ndjson"]);
    const read = (f: string) => fs.readFileSync(path.join(tmp, f));
    expect(read(files[0]!).toString()).toContain("Item 1");
    expect(JSON.parse(read(files[1]!).toString())).toHaveLength(2);
    expect(read(files[3]!).toString().trim().split("\n")).toHaveLength(2);
    const zip = unzipSync(new Uint8Array(read(files[2]!)));
    expect(Object.keys(zip)).toContain("xl/worksheets/sheet1.xml");
    expect(strFromU8(zip["xl/worksheets/sheet1.xml"]!)).toContain("Item 2");
  }, 60_000);
});

describe("job queue", () => {
  it("runs a task as a job with logs and progress, and can cancel it", async () => {
    const task = createRecipe(taskSchema.parse({ name: "Queued shop", url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options: { pagination: { type: "next", selector: "a.next", maxPages: 10 } } }));
    const job = enqueue({ kind: "task", refId: task.id, title: "Queued shop", input: { taskId: task.id } });
    // The same task can't be queued twice at once.
    expect(enqueue({ kind: "task", refId: task.id, title: "again", input: { taskId: task.id }, unique: true }).id).toBe(job.id);
    const done = await waitForJob(job.id, 60_000);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ rows: 6, pages: 3, status: "ok" });
    expect(done.progress).toMatchObject({ rows: 6 });
    expect(jobLogs(job.id).map((l) => l.message).join("\n")).toMatch(/Page 3: 2 row/);

    const slow = enqueue({ kind: "task", refId: task.id, title: "Cancel me", input: { taskId: task.id } });
    await new Promise((r) => setTimeout(r, 300));
    expect(cancelJob(slow.id)).toBe(true);
    const cancelled = await waitForJob(slow.id, 60_000);
    expect(cancelled.status).toBe("cancelled");
    expect(getJob(slow.id)?.error).toBe("Cancelled.");
  }, 90_000);

  it("does not retry a refusal such as robots.txt", async () => {
    const job = enqueue({ kind: "scrape", title: "Blocked", input: { url: `${site.base}/secret`, mode: "fast", extract: { type: "auto" } }, maxAttempts: 3 });
    const done = await waitForJob(job.id, 30_000);
    expect(done.status).toBe("failed");
    expect(done.attempts).toBe(1);
    expect(done.error).toMatch(/robots/);
  }, 40_000);
});
