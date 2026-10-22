import "server-only";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import type { BrowserStep, Pagination } from "@/lib/schemas";
import { env } from "../env";
import { log } from "../log";
import { FetchError } from "./errors";
import { isPrivateAddress } from "./network-guard";
import { collectBoxes, type InspectResult } from "./inspect-script";

type Pool = { browser: Browser | null; launching: Promise<Browser> | null; proxyKey: string; active: number; waiters: (() => void)[] };
const g = globalThis as unknown as { __scaperBrowser?: Pool };
const pool: Pool = (g.__scaperBrowser ??= { browser: null, launching: null, proxyKey: "", active: 0, waiters: [] });

const HEAVY = new Set(["image", "media", "font"]);
const IDLE_CLOSE_MS = 5 * 60_000;
let idleTimer: NodeJS.Timeout | null = null;

function executablePath(): string | undefined {
  if (env.PLAYWRIGHT_EXECUTABLE_PATH) return env.PLAYWRIGHT_EXECUTABLE_PATH;
  return undefined;
}

function proxyOption(proxyUrl: string) {
  if (!proxyUrl) return undefined;
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.host}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

async function getBrowser(proxyUrl: string): Promise<Browser> {
  if (pool.browser && pool.proxyKey !== proxyUrl && pool.active === 0) {
    await pool.browser.close().catch(() => undefined);
    pool.browser = null;
  }
  if (pool.browser?.isConnected()) return pool.browser;
  if (!pool.launching) {
    pool.launching = chromium
      .launch({ headless: true, executablePath: executablePath(), proxy: proxyOption(proxyUrl) })
      .then((b) => {
        pool.browser = b;
        pool.proxyKey = proxyUrl;
        b.on("disconnected", () => { pool.browser = null; });
        log.info("browser.launched", { proxy: Boolean(proxyUrl) });
        return b;
      })
      .catch((e: Error) => {
        const missing = /Executable doesn't exist|browserType\.launch/i.test(e.message);
        throw new FetchError(
          "browser",
          missing
            ? "The scraping browser is not installed yet. Run `npm run setup:browser` once, then try again (or switch this job to Fast mode)."
            : `The browser could not start: ${e.message.split("\n")[0]}`,
        );
      })
      .finally(() => { pool.launching = null; });
  }
  return pool.launching;
}

async function acquire(max: number) {
  while (pool.active >= max) await new Promise<void>((r) => pool.waiters.push(r));
  pool.active++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function release() {
  pool.active--;
  pool.waiters.shift()?.();
  if (pool.active === 0) {
    // Free memory when nothing has run for a while; the next job relaunches it.
    idleTimer = setTimeout(() => { void pool.browser?.close().catch(() => undefined); pool.browser = null; }, IDLE_CLOSE_MS);
    idleTimer.unref?.();
  }
}

export type BrowserPage = {
  status: number; url: string; html: string; title: string; screenshot?: string; text: string; inspect?: InspectResult;
  /** HTML after each "next" click, first page included (click pagination only). */
  pages?: string[];
  /** PNG of the page or one element, for visual change detection. */
  capture?: Buffer;
  stepLog: string[];
};

const INSPECT_MAX_HEIGHT = 6000;
const CAPTURE_MAX_HEIGHT = 5000;

export type BrowserOptions = {
  userAgent: string; timeoutMs: number; proxyUrl: string; blockHeavy: boolean; screenshot: boolean;
  maxConcurrency: number; allowPrivate: boolean; scroll?: boolean; inspect?: boolean;
  steps?: BrowserStep[]; pagination?: Pagination; headers?: Record<string, string>; cookies?: string;
  capture?: { selector?: string; fullPage?: boolean }; signal?: AbortSignal;
  /** On failure after the page opened, attach a screenshot to the error (failure reports). */
  evidence?: boolean;
};

/** Accepts a Cookie header ("a=1; b=2") or a JSON export from a browser cookie extension. */
export function parseCookies(input: string, url: string): { name: string; value: string; url?: string; domain?: string; path?: string }[] {
  const text = input.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text) as { name?: string; value?: string; domain?: string; path?: string }[];
      return arr.filter((c) => c.name && typeof c.value === "string").map((c) =>
        c.domain ? { name: c.name!, value: c.value!, domain: c.domain, path: c.path ?? "/" } : { name: c.name!, value: c.value!, url });
    } catch {
      return [];
    }
  }
  return text.split(";").map((p) => p.trim()).filter((p) => p.includes("=")).map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), url };
  });
}

async function runSteps(page: Page, steps: BrowserStep[], timeoutMs: number, signal?: AbortSignal) {
  const out: string[] = [];
  const t = Math.min(timeoutMs, 15_000);
  for (const [i, step] of steps.entries()) {
    if (signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    const label = `Step ${i + 1} (${step.action})`;
    try {
      switch (step.action) {
        case "click":
          await page.locator(step.selector).first().click({ timeout: step.optional ? 3000 : t });
          await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
          break;
        case "clickText":
          await page.getByText(step.text, { exact: false }).first().click({ timeout: step.optional ? 3000 : t });
          await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
          break;
        case "check": {
          const box = page.locator(step.selector).first();
          if (step.checked) await box.check({ timeout: t }); else await box.uncheck({ timeout: t });
          break;
        }
        case "remove":
          // Hides overlays (cookie banners, sticky headers) so they don't end up in the content. Only removes elements; never runs page scripts.
          await page.locator(step.selector).evaluateAll((els) => els.forEach((el) => el.remove()));
          break;
        case "waitForText":
          await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout: step.timeoutSeconds * 1000 });
          break;
        case "type": {
          const loc = page.locator(step.selector).first();
          await loc.fill(step.text, { timeout: t });
          if (step.submit) {
            await loc.press("Enter");
            await page.waitForLoadState("domcontentloaded", { timeout: t }).catch(() => undefined);
            await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
          }
          break;
        }
        case "press":
          await page.keyboard.press(step.key);
          break;
        case "select":
          await page.locator(step.selector).first().selectOption(step.value, { timeout: t });
          break;
        case "hover":
          await page.locator(step.selector).first().hover({ timeout: t });
          break;
        case "waitFor":
          await page.locator(step.selector).first().waitFor({ state: "visible", timeout: step.timeoutSeconds * 1000 });
          break;
        case "wait":
          await page.waitForTimeout(step.seconds * 1000);
          break;
        case "scroll":
          for (let k = 0; k < step.times; k++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(350); }
          break;
      }
      out.push(`${label}: done`);
    } catch (e) {
      if ((step.action === "click" || step.action === "clickText") && step.optional) { out.push(`${label}: skipped (not found)`); continue; }
      throw new FetchError("step", `${label} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return out;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

/**
 * Renders a page in headless Chromium. Low footprint by default: images, fonts
 * and media are skipped, and one shared browser serves every job.
 */
export async function browserGet(url: string, opts: BrowserOptions): Promise<BrowserPage> {
  await acquire(opts.maxConcurrency);
  try {
    if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    const browser = await getBrowser(opts.proxyUrl);
    const context = await browser.newContext({
      userAgent: opts.userAgent || undefined,
      viewport: { width: 1366, height: 900 },
      locale: "en-IN",
      javaScriptEnabled: true,
    });
    const onAbort = () => { void context.close().catch(() => undefined); };
    let opened: Awaited<ReturnType<typeof context.newPage>> | null = null;
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const target = new URL(url);
      const cookies = opts.cookies ? parseCookies(opts.cookies, target.origin) : [];
      if (cookies.length) await context.addCookies(cookies);
      const needImages = opts.screenshot || Boolean(opts.capture) || opts.inspect;
      const extra = opts.headers && Object.keys(opts.headers).length ? opts.headers : null;
      await context.route("**/*", (route) => {
        const req = route.request();
        let host = "";
        try { host = new URL(req.url()).hostname.replace(/^\[|\]$/g, ""); } catch { /* data: and blob: URLs */ }
        if (!opts.allowPrivate && host && (host === "localhost" || isPrivateAddress(host))) return route.abort("blockedbyclient");
        if (opts.blockHeavy && !needImages && HEAVY.has(req.resourceType())) return route.abort("blockedbyclient");
        // Site headers (for example an API key for your own account) only go to that site, never to third parties.
        if (extra && host === target.hostname) return route.continue({ headers: { ...req.headers(), ...extra } });
        return route.continue();
      });
      const page = await context.newPage();
      opened = page;
      page.setDefaultTimeout(opts.timeoutMs);
      let response;
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
      } catch (e) {
        if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
        const msg = (e as Error).message;
        if (/Timeout/i.test(msg)) throw new FetchError("timeout", `The page took longer than ${Math.round(opts.timeoutMs / 1000)}s to load.`);
        throw new FetchError("network", `Could not open the page: ${msg.split("\n")[0]}`);
      }
      // Give client-side apps a moment to render, without waiting forever on chatty pages.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
      const stepLog = opts.steps?.length ? await runSteps(page, opts.steps, opts.timeoutMs, opts.signal) : [];

      const pg = opts.pagination;
      let pages: string[] | undefined;
      if (pg?.type === "scroll") {
        for (let i = 0; i < pg.times; i++) {
          await page.mouse.wheel(0, 2400);
          await settle(page);
        }
        stepLog.push(`Scrolled ${pg.times} times.`);
      } else if (pg?.type === "loadMore") {
        let clicks = 0;
        for (; clicks < pg.times; clicks++) {
          if (opts.signal?.aborted) break;
          const btn = page.locator(pg.selector).first();
          if (!(await btn.isVisible().catch(() => false))) break;
          await btn.click({ timeout: 5000 }).catch(() => undefined);
          await settle(page);
        }
        stepLog.push(`Clicked "load more" ${clicks} time(s).`);
      } else if (pg?.type === "click") {
        pages = [await page.content()];
        for (let i = 1; i < pg.maxPages; i++) {
          if (opts.signal?.aborted) break;
          const btn = page.locator(pg.selector).first();
          const usable = await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false);
          if (!usable) break;
          await btn.click({ timeout: 5000 }).catch(() => undefined);
          await page.waitForLoadState("domcontentloaded", { timeout: opts.timeoutMs }).catch(() => undefined);
          await settle(page);
          const html = await page.content();
          if (html === pages[pages.length - 1]) break;
          pages.push(html);
        }
        stepLog.push(`Read ${pages.length} page(s) by clicking "next".`);
      } else if (opts.scroll) {
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 1600);
          await page.waitForTimeout(400);
        }
      }

      const [html, title, text] = await Promise.all([
        page.content(),
        page.title(),
        page.evaluate(() => document.body?.innerText ?? ""),
      ]);
      const status = response?.status() ?? 200;
      if (opts.inspect) {
        // Element picker: boxes in page coordinates plus a matching full-page screenshot (capped height).
        await page.evaluate(() => window.scrollTo(0, 0));
        const inspect = await page.evaluate(collectBoxes, { maxBoxes: 2500, maxHeight: INSPECT_MAX_HEIGHT });
        const shot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: true, clip: { x: 0, y: 0, width: Math.min(inspect.width, 1366), height: Math.max(1, inspect.height) } });
        return { status, url: page.url(), html, title, text, screenshot: shot.toString("base64"), inspect, stepLog };
      }
      let capture: Buffer | undefined;
      if (opts.capture) {
        await page.evaluate(() => window.scrollTo(0, 0));
        if (opts.capture.selector) {
          const el = page.locator(opts.capture.selector).first();
          if (!(await el.count())) throw new FetchError("selector", `The selector "${opts.capture.selector}" matched nothing on the page.`);
          capture = await el.screenshot({ type: "png", timeout: 10_000 });
        } else if (opts.capture.fullPage) {
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          capture = await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: 1366, height: Math.min(Math.max(1, height), CAPTURE_MAX_HEIGHT) } });
        } else {
          capture = await page.screenshot({ type: "png" });
        }
      }
      const screenshot = opts.screenshot
        ? (await page.screenshot({ type: "jpeg", quality: 60, fullPage: false })).toString("base64")
        : undefined;
      return { status, url: page.url(), html, title, text, screenshot, pages, capture, stepLog };
    } catch (e) {
      if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
      if (opts.evidence && opened && e instanceof FetchError && !e.evidence) {
        const shot = await opened.screenshot({ type: "jpeg", quality: 55, timeout: 5000 }).catch(() => null);
        if (shot) e.evidence = shot.toString("base64");
      }
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      await context.close().catch(() => undefined);
    }
  } finally {
    release();
  }
}

/**
 * A browser context that stays open across several steps (the agent's browser). It takes one of the
 * browser slots until closed, blocks private-network requests like every other page, and skips heavy files.
 * Site headers are only sent to their own site.
 */
export async function openSessionContext(opts: {
  userAgent: string; proxyUrl: string; allowPrivate: boolean; blockHeavy: boolean; maxConcurrency: number;
  headersFor: (host: string) => Record<string, string> | null;
}) {
  await acquire(opts.maxConcurrency);
  let released = false;
  const done = () => { if (!released) { released = true; release(); } };
  try {
    const browser = await getBrowser(opts.proxyUrl);
    const context = await browser.newContext({ userAgent: opts.userAgent || undefined, viewport: { width: 1366, height: 900 }, locale: "en-IN", acceptDownloads: false });
    await context.route("**/*", (route) => {
      const req = route.request();
      let host = "";
      try { host = new URL(req.url()).hostname.replace(/^\[|\]$/g, ""); } catch { /* data: and blob: URLs */ }
      if (!opts.allowPrivate && host && (host === "localhost" || isPrivateAddress(host))) return route.abort("blockedbyclient");
      if (opts.blockHeavy && HEAVY.has(req.resourceType())) return route.abort("blockedbyclient");
      const extra = host ? opts.headersFor(host) : null;
      if (extra && Object.keys(extra).length) return route.continue({ headers: { ...req.headers(), ...extra } });
      return route.continue();
    });
    return { context, close: async () => { await context.close().catch(() => undefined); done(); } };
  } catch (e) {
    done();
    throw e;
  }
}

export async function closeBrowser() {
  await pool.browser?.close().catch(() => undefined);
  pool.browser = null;
}

export function browserInstalled(): boolean {
  try {
    return fs.existsSync(executablePath() ?? chromium.executablePath());
  } catch {
    return false;
  }
}
