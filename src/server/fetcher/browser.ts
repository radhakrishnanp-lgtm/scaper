import "server-only";
import fs from "node:fs";
import { chromium, type Browser } from "playwright";
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

export type BrowserPage = { status: number; url: string; html: string; title: string; screenshot?: string; text: string; inspect?: InspectResult };

const INSPECT_MAX_HEIGHT = 6000;

/**
 * Renders a page in headless Chromium. Low footprint by default: images, fonts
 * and media are skipped, and one shared browser serves every job.
 */
export async function browserGet(
  url: string,
  opts: {
    userAgent: string; timeoutMs: number; proxyUrl: string; blockHeavy: boolean; screenshot: boolean;
    maxConcurrency: number; allowPrivate: boolean; scroll?: boolean; inspect?: boolean;
  },
): Promise<BrowserPage> {
  await acquire(opts.maxConcurrency);
  try {
    const browser = await getBrowser(opts.proxyUrl);
    const context = await browser.newContext({
      userAgent: opts.userAgent || undefined,
      viewport: { width: 1366, height: 900 },
      locale: "en-IN",
      javaScriptEnabled: true,
    });
    try {
      await context.route("**/*", (route) => {
        const req = route.request();
        let host = "";
        try { host = new URL(req.url()).hostname.replace(/^\[|\]$/g, ""); } catch { /* data: and blob: URLs */ }
        if (!opts.allowPrivate && host && (host === "localhost" || isPrivateAddress(host))) return route.abort("blockedbyclient");
        if (opts.blockHeavy && !opts.screenshot && HEAVY.has(req.resourceType())) return route.abort("blockedbyclient");
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(opts.timeoutMs);
      let response;
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
      } catch (e) {
        const msg = (e as Error).message;
        if (/Timeout/i.test(msg)) throw new FetchError("timeout", `The page took longer than ${Math.round(opts.timeoutMs / 1000)}s to load.`);
        throw new FetchError("network", `Could not open the page: ${msg.split("\n")[0]}`);
      }
      // Give client-side apps a moment to render, without waiting forever on chatty pages.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
      if (opts.scroll) {
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
      if (opts.inspect) {
        // Element picker: boxes in page coordinates plus a matching full-page screenshot (capped height).
        await page.evaluate(() => window.scrollTo(0, 0));
        const inspect = await page.evaluate(collectBoxes, { maxBoxes: 2500, maxHeight: INSPECT_MAX_HEIGHT });
        const shot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: true, clip: { x: 0, y: 0, width: Math.min(inspect.width, 1366), height: Math.max(1, inspect.height) } });
        return { status: response?.status() ?? 200, url: page.url(), html, title, text, screenshot: shot.toString("base64"), inspect };
      }
      const screenshot = opts.screenshot
        ? (await page.screenshot({ type: "jpeg", quality: 60, fullPage: false })).toString("base64")
        : undefined;
      return { status: response?.status() ?? 200, url: page.url(), html, title, text, screenshot };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    release();
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
