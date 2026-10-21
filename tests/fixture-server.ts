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
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    hits.push(url);
    const p = pages.get(url);
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
