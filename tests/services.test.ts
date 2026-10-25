import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";
import type { TaskCheckpoint } from "@/server/tasks/engine";

/**
 * Firecrawl, Apify, the download manager, pause and resume, and bot self-evaluation, against one local server
 * that plays Firecrawl's v2 API, Apify's v2 API and a file host (with Range support and robots.txt).
 */
type Rec = { method: string; path: string; query: URLSearchParams; body: unknown; auth?: string; range?: string };

function startServices() {
  const calls: Rec[] = [];
  const ctl = { firecrawlStatus: 0, runPolls: 0, cutAt: 0, slow: false };
  const file = Buffer.alloc(1_300_000, 0);
  for (let i = 0; i < file.length; i++) file[i] = (i * 31) % 251;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body, auth: req.headers.authorization, range: req.headers.range });
      const json = (status: number, b: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };

      if (url.pathname === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); res.end("User-agent: *\nDisallow: /files/private\n"); return; }
      // Firecrawl v2
      if (url.pathname === "/v2/scrape") {
        if (ctl.firecrawlStatus) return json(ctl.firecrawlStatus, { success: false, error: "forced" });
        const u = (body as { url: string }).url;
        return json(200, { success: true, data: {
          rawHtml: `<html><head><title>FC page</title></head><body><ul><li class="item"><a class="name" href="/a">Alpha</a></li><li class="item"><a class="name" href="/b">Beta</a></li></ul></body></html>`,
          markdown: "# FC page\n- Alpha\n- Beta", links: [`${u}/a`, { url: `${u}/b` }], metadata: { title: "FC page", sourceURL: u, statusCode: 200 },
        } });
      }
      if (url.pathname === "/v2/search") return json(200, { success: true, data: { web: [{ url: "https://example.com/x", title: "X", description: "About X" }] } });
      if (url.pathname === "/v2/map") return json(200, { success: true, links: [{ url: "https://example.com/1" }, "https://example.com/2"] });
      // Apify v2
      if (url.pathname === "/apify/users/me") return json(200, { data: { username: "krish", plan: { id: "STARTER" } } });
      if (url.pathname === "/apify/acts/streamers~youtube-scraper/runs" && req.method === "POST") {
        ctl.runPolls = 0;
        return json(201, { data: { id: "run1", actId: "yt", status: "RUNNING", startedAt: "", finishedAt: null, defaultDatasetId: "ds1" } });
      }
      if (url.pathname === "/apify/actor-runs/run1") {
        ctl.runPolls++;
        return json(200, { data: { id: "run1", actId: "yt", status: ctl.runPolls >= 2 ? "SUCCEEDED" : "RUNNING", startedAt: "", finishedAt: null, defaultDatasetId: "ds1", usageTotalUsd: 0.05 } });
      }
      if (url.pathname === "/apify/datasets/ds1/items") {
        return json(200, [
          { title: "Song one", url: "https://youtube.example/watch?v=1", viewCount: 1200, channel: { name: "Chan", subscribers: 10 }, hashtags: ["a", "b"] },
          { title: "Song two", url: "https://youtube.example/watch?v=2", viewCount: 900, channel: { name: "Chan" }, thumbnailUrl: null },
        ]);
      }
      // A file host with Range support.
      if (url.pathname === "/files/big.bin" || url.pathname === "/files/norange.bin") {
        const ranges = url.pathname === "/files/big.bin";
        const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
        const start = ranges && m ? Number(m[1]) : 0;
        const part = file.subarray(start);
        res.writeHead(start ? 206 : 200, {
          "content-type": "application/octet-stream", "content-length": String(part.length),
          ...(ranges ? { "accept-ranges": "bytes" } : {}), ...(start ? { "content-range": `bytes ${start}-${file.length - 1}/${file.length}` } : {}),
        });
        // Optionally cut the connection part way, like a dropped network.
        if (ctl.cutAt && !start) { res.write(part.subarray(0, ctl.cutAt)); setTimeout(() => res.destroy(), 20); return; }
        if (ctl.slow) {
          let i = 0;
          const t = setInterval(() => { if (res.destroyed || i >= part.length) { clearInterval(t); res.end(); return; } res.write(part.subarray(i, i + 20_000)); i += 20_000; }, 60);
          return;
        }
        res.end(part);
        return;
      }
      if (url.pathname === "/files/report") { res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Report 2026.pdf"' }); res.end("%PDF-1.4 tiny"); return; }
      if (url.pathname === "/files/moved") { res.writeHead(302, { location: "/files/report" }); res.end(); return; }
      if (url.pathname === "/files/private/x.txt") { res.writeHead(200); res.end("secret"); return; }
      res.writeHead(404); res.end("nope");
    });
  });
  return new Promise<{ base: string; calls: Rec[]; ctl: typeof ctl; file: Buffer; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, calls, ctl, file, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

const svc = await startServices();
process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_APIFY_URL = `${svc.base}/apify`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-services-"));
process.env.SCAPER_DATA_DIR = tmp;

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings, publicSettings } = await import("@/server/repo/settings");
const fc = await import("@/server/integrations/firecrawl");
const apify = await import("@/server/integrations/apify");
const { fetchPage } = await import("@/server/fetcher");
const { runTask } = await import("@/server/tasks/engine");
const dl = await import("@/server/downloads/manager");
const dlRepo = await import("@/server/repo/downloads");
const { enqueue, waitForJob, pauseJob, resumeJob } = await import("@/server/jobs");
const { getJob, getCheckpoint } = await import("@/server/repo/jobs");
const { createRecipe } = await import("@/server/repo/scrapes");
const bots = await import("@/server/repo/bots");
const { botSystemPrompt } = await import("@/server/ai/bots");
const { evaluateBotRun } = await import("@/server/ai/bot-eval");
const { createAgentRun, updateAgentRun } = await import("@/server/repo/agent");
const { TOOLS, serviceToolAvailable } = await import("@/server/ai/tools");
const { extractSchema, taskOptionsSchema, taskSchema, apifyActorIdSchema, botSchema } = await import("@/lib/schemas");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
let llm: Awaited<ReturnType<typeof startMockLlm>>;
let evalReply = "";

beforeAll(async () => {
  site = await startFixtureServer();
  llm = await startMockLlm(() => ({ content: evalReply }));
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    integrations: { firecrawlKey: "fc-test-key-1234", firecrawlUrl: svc.base, apifyToken: "apify_api_test_9876", apifyMaxChargeUsd: 2 },
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "m", contextWindow: 100_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "m" }, fast: { providerId: "p", model: "m" }, dailyRequestLimit: 1000,
    },
  });
});
afterAll(async () => { await site.close(); await llm.close(); await svc.close(); });
beforeEach(() => { svc.ctl.firecrawlStatus = 0; svc.ctl.cutAt = 0; svc.ctl.slow = false; });

const items = extractSchema.parse({ type: "selectors", itemSelector: "li.item", fields: [{ name: "name", selector: "a.name" }, { name: "link", selector: "a.name", attr: "href" }] });

describe("Firecrawl", () => {
  it("scrapes, searches and maps with your key, and never asks for stealth", async () => {
    const page = await fc.firecrawlScrape(`${site.base}/shop?page=1`);
    expect(page).toMatchObject({ title: "FC page", status: 200, links: [`${site.base}/shop?page=1/a`, `${site.base}/shop?page=1/b`] });
    const sent = svc.calls.findLast((c) => c.path === "/v2/scrape")!;
    expect(sent.auth).toBe("Bearer fc-test-key-1234");
    expect(JSON.stringify(sent.body)).not.toMatch(/stealth|enhanced|proxy|ignoreRobots/i);
    expect(await fc.firecrawlSearch("x")).toEqual([expect.objectContaining({ url: "https://example.com/x", title: "X" })]);
    expect((await fc.firecrawlMap("https://example.com")).map((l) => l.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("is a fetch mode: the page is read with your selectors, robots.txt still applies, and a bad key stops the run", async () => {
    const run = await runTask({ url: `${site.base}/shop?page=1`, mode: "firecrawl", extract: items, options: taskOptionsSchema.parse({}) });
    expect(run.status).toBe("ok");
    expect(run.result!.datasets[0]!.rows.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
    const before = svc.calls.filter((c) => c.path === "/v2/scrape").length;
    await expect(fetchPage(`${svc.base}/files/private/x.txt`, "firecrawl")).rejects.toMatchObject({ code: "robots" });
    expect(svc.calls.filter((c) => c.path === "/v2/scrape").length).toBe(before);
    svc.ctl.firecrawlStatus = 401;
    await expect(fetchPage(`${site.base}/shop?page=2`, "firecrawl")).rejects.toMatchObject({ code: "service", message: expect.stringMatching(/refused the API key/) });
  });
});

describe("Apify", () => {
  it("reads actor ids from links and flattens items into columns", () => {
    expect(apifyActorIdSchema.parse("https://apify.com/apify/instagram-scraper")).toBe("apify~instagram-scraper");
    expect(apifyActorIdSchema.parse("clockworks/tiktok-scraper")).toBe("clockworks~tiktok-scraper");
    const ds = apify.itemsToDataset([{ a: 1, o: { b: "x", c: { d: [1, 2] } }, list: ["p", "q"], objs: [{ z: 1 }] }]);
    expect(ds.columns).toEqual(["a", "o.b", "o.c.d", "list", "objs"]);
    expect(ds.rows[0]).toMatchObject({ a: 1, "o.b": "x", "o.c.d": "1, 2", list: "p, q", objs: '[{"z":1}]' });
  });

  it("an Apify task runs the actor with caps, waits for it and keeps its items as rows", async () => {
    const options = taskOptionsSchema.parse({ source: { type: "apify", actorId: "streamers~youtube-scraper", input: { searchQueries: ["tamil songs"] }, maxItems: 50, maxChargeUsd: 1.5, timeoutSeconds: 600 } });
    const run = await runTask({ url: "https://apify.com/streamers/youtube-scraper", mode: "fast", extract: items, options });
    expect(run.status).toBe("ok");
    const rows = run.result!.datasets[0]!.rows;
    expect(rows.map((r) => r.title)).toEqual(["Song one", "Song two"]);
    expect(rows[0]).toMatchObject({ "channel.name": "Chan", hashtags: "a, b", viewCount: 1200 });
    const start = svc.calls.findLast((c) => c.path.endsWith("/runs"))!;
    expect(start.auth).toBe("Bearer apify_api_test_9876");
    expect(Object.fromEntries(start.query)).toMatchObject({ maxItems: "50", timeout: "600", maxTotalChargeUsd: "1.5" });
    expect(start.body).toEqual({ searchQueries: ["tamil songs"] });
  });

  it("hides Firecrawl and Apify tools until their key is saved, and masks both secrets", () => {
    const pub = publicSettings(getSettings()).integrations as Record<string, unknown>;
    expect(pub.firecrawlKey).toBe("••••1234");
    expect(pub.apifyToken).toBe("••••9876");
    expect(JSON.stringify(publicSettings(getSettings()))).not.toContain("fc-test-key");
    expect(serviceToolAvailable("apify_run_actor")).toBe(true);
    // Saving the masked value back keeps the real key.
    saveSettings({ integrations: { ...getSettings().integrations, firecrawlKey: "••••1234" } });
    expect(getSettings().integrations.firecrawlKey).toBe("fc-test-key-1234");
    saveSettings({ integrations: { apifyToken: "" } });
    expect(serviceToolAvailable("apify_run_actor")).toBe(false);
    expect(serviceToolAvailable("firecrawl_scrape")).toBe(true);
    expect(Object.keys(TOOLS)).toContain("download_files");
    saveSettings({ integrations: { apifyToken: "apify_api_test_9876" } });
  });
});

async function until<T>(fn: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("download manager", () => {
  it("downloads a file, names it from the server, follows redirects and does not overwrite", async () => {
    const { added } = dl.queueDownloads([`${svc.base}/files/moved`, `${svc.base}/files/report?again=1`, "not a link"], { folder: "../../etc/Reports", source: "manual" });
    expect(added).toHaveLength(2);
    const done = await until(() => { const d = added.map((id) => dlRepo.getDownload(id)!); return d.every((x) => x.status === "done") && d; });
    expect(done.map((d) => d.file_name).sort()).toEqual(["Report 2026 (2).pdf", "Report 2026.pdf"]);
    expect(done[0]!.path!.startsWith(path.join(tmp, "downloads", "etc", "Reports"))).toBe(true);
    expect(fs.readFileSync(done[0]!.path!, "utf8")).toBe("%PDF-1.4 tiny");
    // The same link in the same folder is not queued twice.
    expect(dl.queueDownloads([`${svc.base}/files/moved`], { folder: "etc/Reports", source: "manual" }).skipped).toBe(1);
  });

  it("resumes with a Range request after a dropped connection, and the file is whole", async () => {
    svc.ctl.cutAt = 400_000;
    const [id] = dl.queueDownloads([`${svc.base}/files/big.bin`], { folder: "bin", source: "manual" }).added;
    const d = await until(() => { const x = dlRepo.getDownload(id!)!; return x.status === "done" && x; }, 30_000);
    expect(svc.calls.some((c) => c.path === "/files/big.bin" && c.range === "bytes=400000-")).toBe(true);
    expect(d.bytes).toBe(svc.file.length);
    expect(d.sha256).toBe(sha(svc.file));
    expect(sha(fs.readFileSync(d.path!))).toBe(sha(svc.file));
  }, 40_000);

  it("pauses and resumes where it stopped; stops for robots.txt and 404 without retrying", async () => {
    svc.ctl.slow = true;
    const [id] = dl.queueDownloads([`${svc.base}/files/big.bin?slow=1`], { folder: "bin", source: "manual" }).added;
    await until(() => (dlRepo.getDownload(id!)!.bytes > 0 || fs.existsSync(`${dlRepo.getDownload(id!)!.path}.part`)) && dlRepo.getDownload(id!)!.status === "running");
    await new Promise((r) => setTimeout(r, 300));
    dl.pauseDownloads([id!]);
    const paused = await until(() => { const x = dlRepo.getDownload(id!)!; return x.status === "paused" && x; });
    const partSize = fs.statSync(`${paused.path}.part`).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(svc.file.length);
    svc.ctl.slow = false;
    dl.resumeDownloads([id!]);
    const done = await until(() => { const x = dlRepo.getDownload(id!)!; return x.status === "done" && x; }, 30_000);
    expect(svc.calls.some((c) => c.query.get("slow") === "1" && c.range === `bytes=${partSize}-`)).toBe(true);
    expect(done.sha256).toBe(sha(svc.file));

    const [robots, missing] = dl.queueDownloads([`${svc.base}/files/private/x.txt`, `${svc.base}/files/gone.zip`], { folder: "x", source: "manual" }).added;
    const failed = await until(() => { const a = dlRepo.getDownload(robots!)!; const b = dlRepo.getDownload(missing!)!; return a.status === "failed" && b.status === "failed" && [a, b]; });
    expect(failed[0]!.error).toMatch(/robots\.txt/);
    expect(failed[1]!.error).toMatch(/HTTP 404/);
    expect(svc.calls.filter((c) => c.path === "/files/gone.zip")).toHaveLength(1);
    expect(svc.calls.some((c) => c.path === "/files/private/x.txt")).toBe(false);
  }, 60_000);

  it("refuses files over the size limit without retrying", async () => {
    saveSettings({ data: { maxDownloadMb: 1 } });
    const [id] = dl.queueDownloads([`${svc.base}/files/norange.bin`], { folder: "limit", source: "manual" }).added;
    const d = await until(() => { const x = dlRepo.getDownload(id!)!; return ["done", "failed"].includes(x.status) && x; });
    expect(d).toMatchObject({ status: "failed", error: expect.stringMatching(/over the 1 MB limit/) });
    expect(svc.calls.filter((c) => c.path === "/files/norange.bin")).toHaveLength(1);
    saveSettings({ data: { maxDownloadMb: 2048 } });
  });
});

const cards = extractSchema.parse({
  type: "selectors", itemSelector: ".card",
  fields: [{ name: "title", selector: "a.title" }, { name: "link", selector: "a.title", attr: "href" }],
});

describe("pause and resume", () => {
  it("a paused task run keeps its rows and carries on from the next page", async () => {
    let pages = 0;
    let cp: TaskCheckpoint | null = null;
    class Paused extends Error {}
    const options = taskOptionsSchema.parse({ pagination: { type: "next", selector: "a.next", maxPages: 10 } });
    await expect(runTask({ url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options }, {
      shouldPause: () => pages++ >= 1, checkpoint: (c) => { cp = c; }, paused: () => new Paused("paused"),
    })).rejects.toBeInstanceOf(Paused);
    expect(cp).not.toBeNull();
    expect(cp!.datasets[0]!.rows.map((r) => r.title)).toEqual(["Item 1", "Item 2"]);
    expect(cp!.queue.map((q) => q.url)).toEqual([`${site.base}/shop?page=2`]);
    const run = await runTask({ url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options, resume: cp });
    expect(run.status).toBe("ok");
    expect(run.result!.datasets[0]!.rows.map((r) => r.title)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"]);
    expect(run.page_count).toBe(3);
  }, 60_000);

  it("pauses a queued task job, resumes it, and Run now resumes a paused run instead of starting another", async () => {
    const task = createRecipe(taskSchema.parse({ name: "Pausable shop", url: `${site.base}/shop?page=1`, mode: "fast", extract: cards, options: { pagination: { type: "next", selector: "a.next", maxPages: 10 } } }));
    const job = enqueue({ kind: "task", refId: task.id, title: "Pausable", input: { taskId: task.id }, unique: true });
    await until(() => getJob(job.id)!.status === "running" && (getJob(job.id)!.progress.done ?? 0) >= 1, 30_000);
    expect(pauseJob(job.id).ok).toBe(true);
    const paused = await until(() => { const j = getJob(job.id)!; return j.status === "paused" && j; }, 30_000);
    expect(paused.resumable).toBe(true);
    expect(getCheckpoint(job.id)).not.toBeNull();
    // The schedule does not start a second run while one is paused; Run now resumes it.
    expect(enqueue({ kind: "task", refId: task.id, title: "Scheduled", input: { taskId: task.id }, unique: true, trigger: "schedule" }).id).toBe(job.id);
    expect(getJob(job.id)!.status).toBe("paused");
    expect(enqueue({ kind: "task", refId: task.id, title: "Run now", input: { taskId: task.id }, unique: true }).id).toBe(job.id);
    const done = await waitForJob(job.id, 60_000);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ rows: 6, pages: 3 });
    expect(getCheckpoint(job.id)).toBeNull();
    expect(resumeJob(job.id).ok).toBe(false);
  }, 90_000);
});

describe("bot self-evaluation", () => {
  it("grades a run, keeps lessons, and your notes become lessons it reads every run", async () => {
    const bot = bots.createBot(botSchema.parse({ name: "Scout", role: "Finds trends", task: "Report the top YouTube videos for tamil songs." }));
    expect(bot.selfEval).toBe(true);
    const run = createAgentRun("Report the top videos", "m", null, { botId: bot.id, trigger: "schedule" });
    updateAgentRun(run.id, { status: "done", answer: "Top 5 videos: …", steps: [{ type: "tool", name: "apify_run_actor", args: { actorId: "streamers~youtube-scraper" }, ok: true, result: "2 items" } as never] });
    evalReply = JSON.stringify({ score: 4, met_job: true, summary: "Found the videos with one actor run.", lessons: ["Use dateFilter today for daily reports", "x"], suggestion: "Always include view counts." });
    const e = await evaluateBotRun(bots.getBot(bot.id)!, run.id, "schedule");
    expect(e).toMatchObject({ score: 4, met_job: true, lessons: ["Use dateFilter today for daily reports"], suggestion: "Always include view counts." });
    // Page content is not sent to the grader, only tool names, arguments and outcomes.
    expect(JSON.stringify(llm.requests.at(-1))).toContain("apify_run_actor");
    // Grading twice does not call the model again.
    const calls = llm.requests.length;
    await evaluateBotRun(bots.getBot(bot.id)!, run.id, "schedule");
    expect(llm.requests.length).toBe(calls);

    bots.setBotFeedback(bot.id, run.id, -1, "Skip sponsored videos");
    const lessons = bots.listBotMemory(bot.id, "lesson").map((l) => l.value);
    expect(lessons).toEqual(expect.arrayContaining(["Use dateFilter today for daily reports", "You said this run was wrong: Skip sponsored videos"]));
    expect(botSystemPrompt(bots.getBot(bot.id)!)).toContain("Skip sponsored videos");
    expect(bots.getBotEval(run.id)).toMatchObject({ user_rating: -1, user_note: "Skip sponsored videos", score: 4 });

    // Many self-taught lessons: the oldest go, yours stay.
    for (let i = 0; i < 15; i++) bots.addLesson(bot.id, `run:x${i}:0`, `Self lesson number ${i}`);
    const after = bots.listBotMemory(bot.id, "lesson");
    expect(after.length).toBeLessThanOrEqual(bots.MAX_LESSONS);
    expect(after.some((l) => l.key === `user:${run.id}`)).toBe(true);
    // Clearing the note removes its lesson.
    bots.setBotFeedback(bot.id, run.id, 0, "");
    expect(bots.listBotMemory(bot.id, "lesson").some((l) => l.key === `user:${run.id}`)).toBe(false);

    // Off: no grading.
    bots.updateBot(bot.id, { selfEval: false });
    const run2 = createAgentRun("again", "m", null, { botId: bot.id, trigger: "manual" });
    updateAgentRun(run2.id, { status: "done", answer: "ok" });
    expect(await evaluateBotRun(bots.getBot(bot.id)!, run2.id, "manual")).toBeNull();
  });
});

describe("migration 10", () => {
  it("adds pause, downloads and lessons to an existing database without losing job logs or bot memory", () => {
    const file = path.join(tmp, "old.db");
    const old = openDatabase(file, 9);
    const t = new Date().toISOString();
    old.prepare("INSERT INTO jobs (id, kind, title, status, run_after, created_at) VALUES ('j1', 'task', 'Old', 'succeeded', ?, ?)").run(t, t);
    old.prepare("INSERT INTO job_logs (job_id, level, message, created_at) VALUES ('j1', 'info', 'kept', ?)").run(t);
    old.prepare("INSERT INTO bots (id, name, config, created_at, updated_at) VALUES ('b1', 'Old bot', '{}', ?, ?)").run(t, t);
    old.prepare("INSERT INTO bot_memory (id, bot_id, kind, key, value, created_at, updated_at) VALUES ('m1', 'b1', 'fact', 'k', 'v', ?, ?)").run(t, t);
    old.close();
    const db = openDatabase(file);
    expect(db.prepare("SELECT message FROM job_logs WHERE job_id = 'j1'").all()).toEqual([{ message: "kept" }]);
    expect(db.prepare("SELECT value FROM bot_memory WHERE bot_id = 'b1'").all()).toEqual([{ value: "v" }]);
    db.prepare("UPDATE jobs SET status = 'paused', checkpoint = '{}' WHERE id = 'j1'").run();
    db.prepare("INSERT INTO bot_memory (id, bot_id, kind, key, value, created_at, updated_at) VALUES ('m2', 'b1', 'lesson', 'l', 'v', ?, ?)").run(t, t);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // Deleting the job still cascades to its logs.
    db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 0 });
    db.close();
  });
});
