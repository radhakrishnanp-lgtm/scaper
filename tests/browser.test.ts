import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

process.env.SCAPER_SCHEDULER = "off";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-browser-"));
process.env.SCAPER_DATA_DIR = tmp;

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const repo = await import("@/server/repo/browser");
const ext = await import("@/server/live-browser/extensions");
const live = await import("@/server/live-browser/session");

const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

let site: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  site = await startFixtureServer();
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true }, data: { browserHome: "", browserSearch: "https://search.example/?q=%s" } });
});
afterAll(async () => { await live.closeLive("test"); await site.close(); });

describe("address bar", () => {
  it("turns what you type into a link or a search", () => {
    expect(live.toUrl("https://a.com/x")).toBe("https://a.com/x");
    expect(live.toUrl("example.com/path")).toBe("https://example.com/path");
    expect(live.toUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(live.toUrl("10.0.0.1/admin")).toBe("http://10.0.0.1/admin");
    expect(live.toUrl("cheap red shoes")).toBe("https://search.example/?q=cheap%20red%20shoes");
    expect(() => live.toUrl("chrome://settings")).toThrow(/not available/);
  });
});

describe("history, bookmarks and annotations", () => {
  it("records history once per minute per page and searches it", () => {
    repo.addHistory("https://shop.example/a", "Shop A");
    repo.addHistory("https://shop.example/a", "Shop A");
    repo.addHistory("https://news.example/", "News");
    expect(repo.listHistory()).toHaveLength(2);
    expect(repo.listHistory({ q: "shop" }).map((h) => h.title)).toEqual(["Shop A"]);
    expect(repo.suggest("sho")[0]?.url).toBe("https://shop.example/a");
    repo.deleteHistory({ all: true });
    expect(repo.listHistory()).toHaveLength(0);
  });

  it("keeps one bookmark per address", () => {
    const b = repo.addBookmark("https://shop.example/a", "Shop A");
    repo.addBookmark("https://shop.example/a", "Shop A again");
    expect(repo.listBookmarks()).toHaveLength(1);
    expect(repo.suggest("shop")[0]?.url).toBe("https://shop.example/a");
    expect(repo.deleteBookmark(b.id)).toBe(true);
  });

  it("saves, edits and clears annotations", () => {
    const a = repo.saveAnnotation({ url: "https://shop.example/a", title: "Shop A", x: 1, y: 2, w: 30, h: 40, note: "prices", color: "amber", element: { tag: "li", text: "Widget", selector: "ul > li" } });
    expect(repo.annotationsFor("https://shop.example/a")[0]?.element?.selector).toBe("ul > li");
    repo.updateAnnotation(a.id, { note: "track daily" });
    expect(repo.annotationsFor("https://shop.example/a")[0]?.note).toBe("track daily");
    expect(live.describeAnnotations(repo.annotationsFor("https://shop.example/a"))).toContain(`the user's note: "track daily"`);
    expect(repo.clearAnnotations()).toBe(1);
  });
});

describe("extension packages", () => {
  const manifest = { manifest_version: 3, name: "__MSG_appName__", version: "1.2", default_locale: "en", options_page: "options.html", action: { default_popup: "popup.html" } };
  const pkg = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("reads store links and gives Chrome-style ids", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(ext.storeIdFrom(`https://chromewebstore.google.com/detail/some-name/${id}?hl=en`)).toBe(id);
    expect(ext.storeIdFrom(id)).toBe(id);
    expect(ext.storeIdFrom("https://example.com/")).toBeNull();
    expect(ext.chromeIdFor({}, "/x/y")).toMatch(/^[a-p]{32}$/);
  });

  it("refuses unsafe paths and packages without a manifest", () => {
    expect(() => ext.unpack(pkg({ "manifest.json": "{}", "../evil.js": "x" }))).toThrow(/unsafe path/);
    expect(() => ext.unpack(pkg({ "readme.txt": "x" }))).toThrow(/no manifest.json/);
    expect(() => ext.crxToZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a .zip or .crx/);
  });

  it("unwraps a .crx and a zip with one top folder", () => {
    const zip = pkg({ "ext/manifest.json": "{}", "ext/a.js": "1" });
    expect(Object.keys(ext.unpack(zip)).sort()).toEqual(["a.js", "manifest.json"]);
    const header = new Uint8Array(12 + 4);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x43723234, false);
    dv.setUint32(4, 3, true);
    dv.setUint32(8, 4, true);
    const crx = new Uint8Array([...header, ...zip]);
    expect(ext.crxToZip(crx)).toEqual(zip);
  });

  it("installs with names from _locales, then removes", async () => {
    const row = await ext.installPackage(pkg({
      "manifest.json": JSON.stringify(manifest), "popup.html": "<p>hi</p>", "options.html": "<p>o</p>",
      "_locales/en/messages.json": JSON.stringify({ appName: { message: "Price Helper" } }),
    }), "upload");
    expect(row.name).toBe("Price Helper");
    expect(row.popup_page).toMatch(/^chrome-extension:\/\/[a-p]{32}\/popup\.html$/);
    expect(fs.existsSync(path.join(ext.extensionDir(row.id), "manifest.json"))).toBe(true);
    expect(ext.enabledExtensionDirs()).toEqual([ext.extensionDir(row.id)]);
    repo.setExtensionEnabled(row.id, false);
    expect(ext.enabledExtensionDirs()).toEqual([]);
    await ext.removeExtension(row.id);
    expect(repo.listExtensions()).toHaveLength(0);
    expect(fs.existsSync(ext.extensionDir(row.id))).toBe(false);
  });
});

describe("load problems", () => {
  it("explains network errors and bot checks in plain words", () => {
    expect(live.explainLoadError("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.example/", "https://nope.example/").title).toBe("Could not find nope.example");
    expect(live.explainLoadError("net::ERR_PROXY_CONNECTION_FAILED", "https://a.example/").title).toMatch(/proxy/i);
    expect(live.explainLoadError("Timeout 30000ms exceeded.", "https://a.example/").kind).toBe("slow");
    expect(live.explainLoadError("NS_ERROR_UNKNOWN_HOST", "https://a.example/").kind).toBe("network");
    expect(live.pageProblem(200, "Just a moment...")?.kind).toBe("blocked");
    expect(live.pageProblem(403, "Forbidden")?.title).toMatch(/403/);
    expect(live.pageProblem(200, "Shop")).toBeNull();
  });
});

describe("live browser", () => {
  it("opens, streams, takes input, records history and annotations, and feeds the AI", async () => {
    site.pages.set("/form", { body: `<html><head><title>Form</title></head><body><input id="q" name="q" placeholder="Search"><a href="/listing">Listing</a><a href="/secret">Secret</a></body></html>` });
    const events: string[] = [];
    const off = live.subscribe((e) => events.push(e.type));
    await live.openLive("normal");
    await live.setViewport(800, 600);
    await live.navigate(`${site.base}/form`);
    await until(() => events.includes("frame"));
    await until(() => repo.listHistory().some((h) => h.url === `${site.base}/form`));

    await live.input([{ type: "mouse", kind: "click", x: 40, y: 15, button: "left" }, { type: "text", text: "hello" }]);
    const shot = await live.screenshot(50);
    expect(shot.length).toBeGreaterThan(1000);

    const note = await live.annotate({ x: 0, y: 0, w: 200, h: 30, note: "the search box", color: "blue" });
    expect(note.element?.tag).toBeTruthy();
    const read = await live.readForAi();
    expect(read).toContain("the search box");
    expect(read).toContain("<page>");

    const seen = await live.observeForAi();
    const secret = /\[(\d+)\] link: Secret/.exec(seen)?.[1];
    expect(secret).toBeTruthy();
    // robots.txt disallows /secret, so the AI may not go there.
    await expect(live.actForAi("click", Number(secret))).rejects.toThrow(/robots/i);
    await expect(live.actForAi("open", undefined, `${site.base}/secret`)).rejects.toThrow(/robots/i);
    off();
  }, 60_000);

  it("shows why a page did not load", async () => {
    site.pages.set("/forbidden", { status: 403, body: "<title>Forbidden</title><h1>No</h1>" });
    site.pages.set("/check", { body: "<title>Just a moment...</title><p>checking</p>" });
    await live.navigate(`${site.base}/forbidden`);
    await until(() => live.liveState().tabs[0]?.problem?.kind === "http");
    await live.navigate(`${site.base}/check`);
    await until(() => live.liveState().tabs[0]?.problem?.kind === "blocked");
    await live.navigate("http://127.0.0.1:9/");
    expect(live.liveState().tabs[0]?.problem?.title).toMatch(/refused|Could not open/);
    await live.navigate(`${site.base}/form`);
    await until(() => live.liveState().tabs[0]?.problem === null && !live.liveState().tabs[0]?.loading);
  }, 60_000);

  it.runIf(fs.existsSync("/usr/bin/Xvfb"))("opens as a real window when a screen is there", async () => {
    const { spawn } = await import("node:child_process");
    const x = spawn("/usr/bin/Xvfb", [":97", "-screen", "0", "1280x900x24"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    const display = process.env.DISPLAY;
    process.env.DISPLAY = ":97";
    try {
      await live.closeLive("test");
      saveSettings({ data: { browserWindow: true } });
      await live.openLive("normal");
      expect(live.liveState()).toMatchObject({ open: true, window: true, engine: "chromium" });
      const frames: number[] = [];
      const off = live.subscribe((e) => { if (e.type === "frame") frames.push(1); });
      await live.navigate(`${site.base}/listing`);
      await until(() => frames.length > 0);
      off();
    } finally {
      await live.closeLive("test");
      saveSettings({ data: { browserWindow: false } });
      if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display;
      x.kill();
    }
  }, 60_000);

  it("keeps no history or saved notes in incognito", async () => {
    repo.deleteHistory({ all: true });
    await live.openLive("incognito");
    expect(live.liveState().mode).toBe("incognito");
    await live.navigate(`${site.base}/listing`);
    const before = repo.recentAnnotations().length;
    await live.annotate({ x: 0, y: 0, w: 50, h: 50, note: "private", color: "red" });
    expect(live.currentAnnotations()).toHaveLength(1);
    expect(repo.recentAnnotations()).toHaveLength(before);
    await new Promise((r) => setTimeout(r, 500));
    expect(repo.listHistory()).toHaveLength(0);
    await live.closeLive("test");
    expect(live.liveState().open).toBe(false);
  }, 60_000);
});
