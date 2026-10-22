import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

/** A tiny local "website" for integration tests. Pages can be changed while it runs. */
export function startFixtureServer() {
  const pages = new Map<string, { status?: number; body: string; type?: string }>();
  const hits: string[] = [];
  const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
  pages.set("/robots.txt", { body: "User-agent: *\nDisallow: /secret\n", type: "text/plain" });
  pages.set("/listing", { body: fixture("listing.html") });
  pages.set("/dp/B0TESTASIN", { body: fixture("amazon-product.html") });
  pages.set("/captcha", { body: fixture("captcha.html") });
  pages.set("/secret", { body: "<p>hidden</p>" });
  pages.set("/js", { body: `<html><body><div id="app">loading</div><script>document.getElementById("app").innerHTML='<ul class="list">'+[1,2,3,4,5].map(i=>'<li class="row"><a href="/i/'+i+'">Rendered item number '+i+'</a> <b class="p">₹'+(i*100)+'</b></li>').join('')+'</ul>'</script></body></html>` });
  // A paginated shop: 3 pages of 2 cards, each card links to a detail page.
  for (let n = 1; n <= 3; n++) {
    const cards = [1, 2].map((k) => {
      const id = (n - 1) * 2 + k;
      return `<div class="card"><a class="title" href="/item/${id}">Item ${id}</a><span class="price">₹${id * 100}</span></div>`;
    }).join("");
    pages.set(`/shop?page=${n}`, { body: `<html><body><div class="list">${cards}</div>${n < 3 ? `<a class="next" href="/shop?page=${n + 1}">Next</a>` : ""}</body></html>` });
  }
  for (let id = 1; id <= 6; id++) pages.set(`/item/${id}`, { body: `<html><body><h1>Item ${id}</h1><span class="sku">SKU-${id}</span><p class="desc">Details for item ${id}</p></body></html>` });
  pages.set("/search?q=red", { body: `<div class="card"><a class="title" href="/item/1">Red shoe</a></div><div class="card"><a class="title" href="/item/2">Red hat</a></div>` });
  pages.set("/search?q=blue", { body: `<div class="card"><a class="title" href="/item/3">Blue shirt</a></div>` });
  pages.set("/blog", { body: `<h1>Blog</h1><a href="/blog/post-1">One</a><a href="/blog/post-2">Two</a><a href="/about">About</a><a href="https://example.com/x">Out</a>` });
  pages.set("/blog/post-1", { body: `<article><h1>Post one</h1><a href="/blog/post-3">Three</a></article>` });
  pages.set("/blog/post-2", { body: `<article><h1>Post two</h1></article>` });
  pages.set("/blog/post-3", { body: `<article><h1>Post three</h1></article>` });
  pages.set("/about", { body: `<h1>About us</h1>` });
  const server = http.createServer((req, res) => {
    const full = req.url ?? "/";
    const url = full.split("?")[0]!;
    hits.push(full.includes("?") ? full : url);
    // Echo what the client sent, for header and cookie scoping tests.
    if (url === "/echo") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ host: req.headers.host, cookie: req.headers.cookie ?? null, key: req.headers["x-api-key"] ?? null })); return; }
    if (url === "/go-elsewhere") { res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/echo` }); res.end(); return; }
    const p = pages.get(full) ?? pages.get(url);
    if (!p) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
    res.writeHead(p.status ?? 200, { "content-type": p.type ?? "text/html; charset=utf-8" });
    res.end(p.body);
  });
  return new Promise<{ base: string; pages: typeof pages; hits: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, pages, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
