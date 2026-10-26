import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./mock-llm";

process.env.SCAPER_SCHEDULER = "off";
vi.setConfig({ testTimeout: 60_000 });
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-files-"));

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { findFiles, pageLinks, extOf, ruleScore } = await import("@/server/files/finder");
const { listDownloads } = await import("@/server/repo/downloads");
const { listAiCalls } = await import("@/server/repo/ai");
const { fileFinderSchema } = await import("@/lib/schemas");

// A small library: a list in two pages, one page per book with the real download links, and a few traps.
type Page = { body: string; type?: string; headers?: Record<string, string> };
const pages = new Map<string, Page>();
const hits: string[] = [];
let firecrawlJson: unknown = null;
const firecrawlCalls: Record<string, unknown>[] = [];
let base = "";
const list = (n: number) => `<html><head><title>Library page ${n}</title></head><body>
  <nav><a href="/">Home</a><a href="/login">Sign in</a><a href="/about">About</a></nav>
  <main><h1>Books</h1><ul>${[1, 2].map((k) => { const id = (n - 1) * 2 + k; return `<li><a href="/library/book-${id}">Book ${id}</a> <img src="/covers/${id}.jpg" alt="cover ${id}"></li>`; }).join("")}
  <li><a href="/secret/book-9">Hidden book</a></li></ul>
  ${n < 2 ? `<a href="/library?page=${n + 1}">Next</a>` : ""}</main></body></html>`;
const book = (id: number) => `<html><head><title>Book ${id}</title></head><body><main><h1>Book ${id}</h1>
  <p>Read the sample or download.</p>
  <a class="btn" href="/files/get?id=${id}">Download PDF</a>
  <a href="/files/book-${id}.epub">EPUB</a>
  <a href="/files/book-${id}-sample.txt">Sample</a>
  <a href="/library">Back to the list</a></main></body></html>`;

let llm: Awaited<ReturnType<typeof startMockLlm>>;
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/v2/scrape") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { url: string };
      firecrawlCalls.push(body);
      const p = pages.get(new URL(body.url).pathname + new URL(body.url).search);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { rawHtml: p?.body ?? "", links: [], json: firecrawlJson, metadata: { url: body.url, statusCode: 200, title: "x" } } }));
    });
    return;
  }
  hits.push(`${req.method} ${url}`);
  const p = pages.get(url) ?? pages.get(url.split("?")[0]!);
  if (!p) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
  res.writeHead(200, { "content-type": p.type ?? "text/html; charset=utf-8", ...p.headers });
  res.end(p.body);
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pages.set("/robots.txt", { body: "User-agent: *\nDisallow: /secret\n", type: "text/plain" });
  pages.set("/library", { body: list(1) });
  pages.set("/library?page=2", { body: list(2) });
  for (let id = 1; id <= 4; id++) {
    pages.set(`/library/book-${id}`, { body: book(id) });
    pages.set(`/files/get?id=${id}`, { body: "%PDF-1.4 x", type: "application/pdf", headers: { "content-disposition": `attachment; filename="Book ${id}.pdf"` } });
    pages.set(`/files/book-${id}.epub`, { body: "PK", type: "application/epub+zip" });
  }
  pages.set("/secret/book-9", { body: book(9) });
  llm = await startMockLlm((messages) => {
    // The "AI" picks the item pages on the list and only the EPUB on a book page.
    const text = String(messages.at(-1)?.content ?? "");
    const lines = text.split("\n").filter((l) => /^\[\d+\]/.test(l));
    const num = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => Number(/^\[(\d+)\]/.exec(l)![1]));
    return { content: JSON.stringify({ files: num(/\.epub/), follow: num(/\/library\/book-\d$/), next: num(/page=2/) }) };
  });
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    integrations: { firecrawlKey: "fc-test-key-1234", firecrawlUrl: base },
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "m", contextWindow: 100_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "m" }, fast: { providerId: "p", model: "m" }, dailyRequestLimit: 1000,
    },
  });
});
afterAll(async () => { await llm.close(); await new Promise((r) => server.close(r)); });

const input = (o: Record<string, unknown>) => fileFinderSchema.parse({ urls: [`${base}/library`], ...o });

describe("links on a page", () => {
  it("reads anchors, embeds, data links and file endings", () => {
    const links = pageLinks(`<base href="/x/"><a href="a.pdf" download>A</a><iframe src="/v/doc.pdf"></iframe><button data-href="/dl/7">Get</button><a href="javascript:void 0">no</a><a href="#top">top</a><video><source src="clip.mp4"></video>`, "https://s.example/p/");
    expect(links.map((l) => l.href)).toEqual(["https://s.example/x/a.pdf", "https://s.example/dl/7", "https://s.example/v/doc.pdf", "https://s.example/x/clip.mp4"]);
    expect(links[0]!.download).toBe(true);
    expect(extOf("https://s.example/get?file=Report%202.PDF")).toBe("pdf");
    expect(extOf("https://s.example/page.php?id=3")).toBe("php");
    expect(extOf("https://s.example/download.php?file=a.epub")).toBe("epub");
  });

  it("scores download and item links above navigation", () => {
    const page = "https://s.example/library";
    const [dl, item, nav, login] = pageLinks(`<main><a href="/files/x">Download</a><a href="/library/book-1">Book one</a></main><nav><a href="/blog">Blog</a></nav><a href="/login">Sign in</a>`, page);
    expect(ruleScore(dl!, page)).toBeGreaterThan(ruleScore(nav!, page));
    expect(ruleScore(item!, page)).toBeGreaterThanOrEqual(2);
    expect(ruleScore(login!, page)).toBe(0);
  });
});

describe("finding files", () => {
  it("follows item pages and next pages to the real download links (rules)", async () => {
    hits.length = 0;
    const r = await findFiles(input({ kinds: ["pdf", "ebook"] }));
    const urls = r.files.map((f) => f.url).sort();
    // 4 books × (the PDF behind /files/get and the EPUB); the sample .txt and the covers are not wanted.
    expect(urls).toHaveLength(8);
    expect(urls).toContain(`${base}/files/get?id=1`);
    expect(urls).toContain(`${base}/files/book-4.epub`);
    const pdf = r.files.find((f) => f.url.endsWith("get?id=2"))!;
    expect(pdf).toMatchObject({ kind: "pdf", name: "Book 2.pdf", from: `${base}/library/book-2` });
    // robots.txt keeps it out of /secret, and the files themselves were only checked, never downloaded.
    expect(hits.some((h) => h.includes("/secret"))).toBe(false);
    expect(hits.filter((h) => h.startsWith("GET /files/"))).toHaveLength(0);
    expect(hits.filter((h) => h.startsWith("HEAD /files/get"))).toHaveLength(4);
    expect(hits.some((h) => h.includes("/login"))).toBe(false);
    expect(r.pages.find((p) => p.url.endsWith("/secret/book-9"))?.error).toMatch(/robots/i);
  });

  it("keeps only the files on the start page at depth 0, and images when asked", async () => {
    const r = await findFiles(input({ kinds: ["image"], depth: 0, followNext: false }));
    expect(r.files.map((f) => f.url).sort()).toEqual([`${base}/covers/1.jpg`, `${base}/covers/2.jpg`]);
    expect(r.pages).toHaveLength(1);
  });

  it("lets your AI pick with an instruction, and logs the calls", async () => {
    const r = await findFiles(input({ kinds: ["pdf", "ebook"], picker: "ai", instruction: "Only the EPUB of each book" }), { refId: "finder-test" });
    expect(r.files.map((f) => f.ext)).toEqual(["epub", "epub", "epub", "epub"]);
    expect(listAiCalls({ limit: 50 }).items.filter((c) => c.purpose === "files").length).toBeGreaterThanOrEqual(3);
  });

  it("lets Firecrawl's AI pick, sending your instruction as a JSON prompt", async () => {
    firecrawlJson = { files: [{ url: "/files/book-1.epub" }], pages: [] };
    firecrawlCalls.length = 0;
    const r = await findFiles(input({ picker: "firecrawl", instruction: "the first book's EPUB", depth: 0 }));
    expect(r.files.map((f) => f.url)).toEqual([`${base}/files/book-1.epub`]);
    const fmt = (firecrawlCalls[0]!.formats as unknown[]).find((f) => typeof f === "object") as { type: string; prompt: string };
    expect(fmt.type).toBe("json");
    expect(fmt.prompt).toContain("the first book's EPUB");
    expect(firecrawlCalls[0]).not.toHaveProperty("proxy");
  });

  it("queues what it finds in Downloads when asked, without duplicates", async () => {
    const r = await findFiles(input({ kinds: ["ebook"], download: true, folder: "Books" }));
    expect(r.queued).toBe(4);
    const again = await findFiles(input({ kinds: ["ebook"], download: true, folder: "Books" }));
    expect(again.queued).toBe(0);
    expect(listDownloads({ limit: 50 }).filter((d) => d.folder === "Books" && d.source === "finder")).toHaveLength(4);
  });

  it("stops at a start page robots.txt refuses", async () => {
    await expect(findFiles(fileFinderSchema.parse({ urls: [`${base}/secret/book-9`] }))).rejects.toThrow(/robots/i);
  });
});
