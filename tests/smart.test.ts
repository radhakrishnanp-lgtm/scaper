import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./mock-llm";

process.env.SCAPER_SCHEDULER = "off";
vi.setConfig({ testTimeout: 60_000 });
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-smart-"));

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { fetchPage, looksEmpty } = await import("@/server/fetcher");
const { firecrawlUsage, recordFirecrawl } = await import("@/server/repo/firecrawl-usage");
const { creditCost, firecrawlScrape } = await import("@/server/integrations/firecrawl");
const { findFiles } = await import("@/server/files/finder");
const { fileFinderSchema } = await import("@/lib/schemas");
const { enqueueAndWait } = await import("@/server/jobs");
const { registerJobHandler } = await import("@/server/jobs/queue");
const { getJob } = await import("@/server/repo/jobs");
const { TOOLS } = await import("@/server/ai/tools");
const { toolsFor, buildSystemPrompt, stopAgent } = await import("@/server/ai/agent");
const { getAgentRun } = await import("@/server/repo/agent");
const assistant = await import("@/app/api/assistant/route");

type Page = { body: string; type?: string; status?: number };
const pages = new Map<string, Page>();
const firecrawl: { path: string; body: Record<string, unknown> }[] = [];
let mapLinks: string[] = [];
let base = "";

// The site and a stand-in for Firecrawl's API on the same little server.
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "POST" && url.startsWith("/v2/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { url: string };
      firecrawl.push({ path: url, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (url === "/v2/map") { res.end(JSON.stringify({ success: true, links: mapLinks.map((u) => ({ url: u, title: "" })) })); return; }
      res.end(JSON.stringify({ success: true, data: { rawHtml: `<html><head><title>Via Firecrawl</title></head><body><main><h1>Loaded by Firecrawl</h1><p>${"Plenty of readable text here. ".repeat(10)}</p></main></body></html>`, links: [], metadata: { url: body.url, statusCode: 200, title: "Via Firecrawl" } } }));
    });
    return;
  }
  const p = pages.get(url) ?? pages.get(url.split("?")[0]!);
  if (!p) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
  res.writeHead(p.status ?? 200, { "content-type": p.type ?? "text/html; charset=utf-8" });
  res.end(p.body);
});

let llm: Awaited<ReturnType<typeof startMockLlm>>;
const seen: string[] = [];
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pages.set("/robots.txt", { body: "User-agent: *\nDisallow: /secret\n", type: "text/plain" });
  pages.set("/plain", { body: `<html><head><title>Plain</title></head><body><main><h1>Prices</h1><p>${"Server-rendered text that Fast mode can read. ".repeat(8)}</p></main></body></html>` });
  pages.set("/app", { body: `<html><head><title>App</title></head><body><div id="root"></div><script>document.getElementById("root").innerHTML='<main><h1>Rendered</h1><p>'+"Text that only appears after JavaScript runs. ".repeat(8)+'</p></main>'</script></body></html>` });
  pages.set("/forbidden", { status: 403, body: "<title>Forbidden</title><h1>No bots</h1>" });
  pages.set("/docs", { body: `<html><body><main><h1>Docs</h1><p>Our manuals.</p><a href="/docs/guide">The guide</a></main></body></html>` });
  pages.set("/docs/guide", { body: `<html><body><main><h1>Guide</h1><button onclick="go()">Get it</button><a href="/fetch/7" class="x">here</a></main></body></html>` });
  pages.set("/fetch/7", { body: `<html><body><a href="/files/guide-7.pdf">PDF</a></body></html>` });
  pages.set("/files/guide-7.pdf", { body: "%PDF-1.4 g", type: "application/pdf" });
  pages.set("/files/manual.pdf", { body: "%PDF-1.4 m", type: "application/pdf" });
  llm = await startMockLlm((messages) => {
    const user = String(messages.find((m) => m.role === "user")?.content ?? "");
    seen.push(user);
    // As the link picker: on the guide page, the AI says /fetch/7 leads to the file.
    const last = String(messages.at(-1)?.content ?? "");
    if (/\[\d+\]/.test(last) && !messages.some((m) => m.role === "tool")) {
      const lines = last.split("\n").filter((l) => /^\[\d+\]/.test(l));
      const num = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => Number(/^\[(\d+)\]/.exec(l)![1]));
      if (last.includes("<rows>") || last.includes("Scaper")) { /* not the picker */ } else return { content: JSON.stringify({ files: num(/\.pdf/), follow: num(/\/fetch\/7|\/docs\/guide/), next: [] }) };
    }
    return { content: "OK." };
  });
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    integrations: { firecrawlKey: "fc-test", firecrawlUrl: base, firecrawlDailyCredits: 0 },
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "m", contextWindow: 100_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "m" }, fast: { providerId: "p", model: "m" }, dailyRequestLimit: 1000, agentApproval: "auto",
    },
  });
});
afterAll(async () => { await new Promise((r) => server.close(r)); await llm.close(); });

describe("smart loading", () => {
  it("knows an empty JavaScript shell from a real page", () => {
    expect(looksEmpty(`<div id="root"></div><script>x()</script>`)).toBe(true);
    expect(looksEmpty(`<p>Please enable JavaScript to use this site.</p>`)).toBe(true);
    expect(looksEmpty(`<main><p>${"words ".repeat(40)}</p></main>`)).toBe(false);
    expect(looksEmpty("%PDF", "application/pdf")).toBe(false);
  });

  it("uses Fast for a plain page, and no Firecrawl", async () => {
    firecrawl.length = 0;
    const p = await fetchPage(`${base}/plain`, "auto");
    expect(p.mode).toBe("fast");
    expect(firecrawl).toHaveLength(0);
  });

  it("moves to Scaper's browser when the page needs JavaScript, still free", async () => {
    firecrawl.length = 0;
    const p = await fetchPage(`${base}/app`, "auto");
    expect(p.mode).toBe("browser");
    expect(p.html).toContain("Text that only appears after JavaScript runs.");
    expect(p.notes.join(" ")).toMatch(/needs JavaScript/);
    expect(firecrawl).toHaveLength(0);
  });

  it("never sends a page that refused Scaper to Firecrawl", async () => {
    firecrawl.length = 0;
    await expect(fetchPage(`${base}/forbidden`, "auto")).rejects.toThrow(/403/);
    expect(firecrawl).toHaveLength(0);
  });

  it("asks Firecrawl only when the free ways cannot load it, and counts the credit", async () => {
    firecrawl.length = 0;
    const before = firecrawlUsage().today.credits;
    const p = await fetchPage("http://localhost:9/down", "auto");
    expect(p.mode).toBe("firecrawl");
    expect(p.notes.join(" ")).toMatch(/Firecrawl loaded it/);
    expect(firecrawl.map((c) => c.path)).toEqual(["/v2/scrape"]);
    expect(firecrawlUsage().today.credits).toBe(before + 1);
  });
});

describe("Firecrawl credits", () => {
  it("prices calls like Firecrawl does", () => {
    expect(creditCost("scrape")).toBe(1);
    expect(creditCost("scrape", { json: true })).toBe(5);
    expect(creditCost("map")).toBe(1);
    expect(creditCost("search", { limit: 5 })).toBe(2);
    expect(creditCost("search", { limit: 5, read: true })).toBe(7);
  });

  it("stops at the daily limit", async () => {
    recordFirecrawl("map", 1);
    const used = firecrawlUsage().today.credits;
    saveSettings({ integrations: { firecrawlDailyCredits: used } });
    firecrawl.length = 0;
    await expect(firecrawlScrape(`${base}/plain`)).rejects.toThrow(/daily Firecrawl limit/);
    expect(firecrawl).toHaveLength(0);
    saveSettings({ integrations: { firecrawlDailyCredits: 0 } });
  });
});

describe("file finder, smart", () => {
  it("lists the whole site with one map call and keeps the wanted files", async () => {
    firecrawl.length = 0;
    mapLinks = [`${base}/files/manual.pdf`, `${base}/docs`, `${base}/img/a.png`, `${base}/secret/x.pdf`];
    const r = await findFiles(fileFinderSchema.parse({ urls: [`${base}/docs`], kinds: ["pdf"], siteMap: true, depth: 0, mode: "fast" }));
    expect(firecrawl.map((c) => c.path)).toEqual(["/v2/map"]);
    expect(r.files.map((f) => f.url)).toContain(`${base}/files/manual.pdf`);
    expect(r.files.find((f) => f.url.endsWith("manual.pdf"))?.from).toMatch(/site map/);
  });

  it("lets the AI read only the pages where the rules find nothing", async () => {
    seen.length = 0;
    const r = await findFiles(fileFinderSchema.parse({ urls: [`${base}/docs/guide`], kinds: ["pdf"], picker: "auto", depth: 1, mode: "fast" }));
    expect(r.files.map((f) => f.url)).toEqual([`${base}/files/guide-7.pdf`]);
    // The guide page had no file link, so the AI read it; the page with the PDF link did not need the AI.
    const picks = seen.filter((u) => u.includes("Pick"));
    expect(picks.length).toBeLessThanOrEqual(1);
    expect(r.picker).toBe("auto");
  });
});

describe("stop", () => {
  it("cancels the job an AI tool is waiting on", async () => {
    let started = false;
    registerJobHandler("backup", async (ctx) => {
      started = true;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 30_000);
        ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      });
      return {};
    });
    const ctrl = new AbortController();
    const waiting = enqueueAndWait({ kind: "backup", title: "slow", trigger: "agent", input: {} }, 60_000, ctrl.signal);
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(waiting).rejects.toThrow(/Stopped/);
    await new Promise((r) => setTimeout(r, 200));
    const { listJobs } = await import("@/server/repo/jobs");
    const job = listJobs({ limit: 5 }).items.find((j) => j.title === "slow")!;
    expect(getJob(job.id)!.status).toBe("cancelled");
  });

  it("stops a running AI conversation", async () => {
    const res = await assistant.POST(new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Summarise this", page: "/tasks/t1", session: { key: "task:t1", name: "Laptop prices" } }) }) as never, {} as never);
    const { run } = await res.json() as { run: { id: string } };
    stopAgent(run.id);
    expect(getAgentRun(run.id)!.error).toMatch(/Stopped by you/);
  });
});

describe("the AI and bots know Firecrawl", () => {
  it("gives bots the Firecrawl tools and the file finder", () => {
    const { names } = toolsFor({ bot: { permission: "ask" }, team: false });
    for (const t of ["firecrawl_scrape", "firecrawl_map", "web_search", "firecrawl_usage", "find_files", "download_files"]) expect(names.has(t)).toBe(true);
  });

  it("tells the AI how to save credits", () => {
    const prompt = buildSystemPrompt({ private: false, approval: "auto" });
    expect(prompt).toMatch(/Free first/);
    expect(prompt).toMatch(/firecrawl_map call \(about 1 credit/);
  });

  it("reports credits used", async () => {
    const r = JSON.parse(String(await TOOLS.firecrawl_usage!.run({}, {} as never))) as { today: { credits: number }; daily_limit: unknown };
    expect(r.today.credits).toBeGreaterThan(0);
    expect(r.daily_limit).toBe("none");
  });

  it("keeps a session chat on its one thing", async () => {
    seen.length = 0;
    const res = await assistant.POST(new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "What changed?", page: "/watchers/w1", session: { key: "watcher:w1", name: "Shop prices" } }) }) as never, {} as never);
    const { run } = await res.json() as { run: { id: string } };
    for (let i = 0; i < 100 && getAgentRun(run.id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(seen.some((u) => u.includes(`only about "Shop prices"`))).toBe(true);
  });
});

describe("bulk download", () => {
  it("reads what to download from plain words", async () => {
    const { kindsFromText } = await import("@/lib/schemas");
    expect(kindsFromText("all the lecture PDFs and the slides").kinds.sort()).toEqual(["document", "pdf"]);
    expect(kindsFromText("every wallpaper photo").kinds).toEqual(["image"]);
    expect(kindsFromText("subtitles .srt").extensions).toEqual(["srt"]);
    expect(kindsFromText("everything on this site").kinds).toHaveLength(7);
  });

  it("starts downloading files while the search goes on, tagged with the search", async () => {
    const { listDownloads } = await import("@/server/repo/downloads");
    pages.set("/shelf", { body: `<html><body><main><a href="/files/manual.pdf">Manual</a><a href="/docs/guide">Guide</a></main></body></html>` });
    const r = await findFiles(fileFinderSchema.parse({ urls: [`${base}/shelf`], kinds: ["pdf"], depth: 2, mode: "fast", download: true, folder: "Bulk test" }), { refId: "bulk-1" });
    expect(r.queued).toBeGreaterThanOrEqual(1);
    const mine = listDownloads({ refId: "bulk-1" }).map((d) => d.url);
    expect(mine).toContain(`${base}/files/manual.pdf`);
    expect(new Set(mine).size).toBe(mine.length);
  });
});
