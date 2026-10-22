import "server-only";
import type { BrowserStep, FetchMode, Pagination } from "@/lib/schemas";
import { getSettings } from "../repo/settings";
import { recordHostRequest, ruleForHost } from "../repo/sites";
import { browserGet } from "./browser";
import type { InspectResult } from "./inspect-script";
import { FetchError } from "./errors";
import { httpGet } from "./http";
import { assertPublicUrl } from "./network-guard";
import { checkRobots, detectBotWall, hostBlockedFor, parseRetryAfter, penalize, reward, withHostTurn } from "./politeness";

export { FetchError } from "./errors";

export const ROBOTS_TOKEN = "Scaper";
export const DEFAULT_FAST_UA = "Mozilla/5.0 (compatible; Scaper/1.0; personal page monitor)";

export type FetchedPage = {
  url: string; finalUrl: string; status: number; html: string; title: string; text?: string;
  screenshot?: string; mode: FetchMode; durationMs: number; notes: string[]; inspect?: InspectResult;
  /** HTML of every page reached by clicking "next" (click pagination), first page included. */
  pages?: string[];
  capture?: Buffer;
  contentType?: string | null;
  /** Time spent on the request itself, without waiting for this host's turn. */
  requestMs?: number;
};

export type FetchOptions = {
  screenshot?: boolean; scroll?: boolean; inspect?: boolean;
  steps?: BrowserStep[]; pagination?: Pagination; capture?: { selector?: string; fullPage?: boolean };
  signal?: AbortSignal; accept?: string;
  /** Uptime checks: a plain 503 means "down", not "slow down". Bot checks still stop the request. */
  uptime?: boolean;
};

/**
 * The one entry point for loading a page. Order: network guard → site rule → robots.txt →
 * wait for this host's turn → fetch → bot-check detection → backoff and stats bookkeeping.
 */
export async function fetchPage(url: string, mode: FetchMode, opts: FetchOptions = {}): Promise<FetchedPage> {
  const s = getSettings().scraping;
  const started = Date.now();
  const notes: string[] = [];
  const host = new URL(url).hostname;
  const rule = ruleForHost(host);
  const timeoutMs = s.timeoutSeconds * 1000;
  const fastUa = rule?.user_agent || s.userAgent || DEFAULT_FAST_UA;
  const browserUa = rule?.user_agent || s.userAgent;
  const headers = Object.fromEntries((rule?.headers ?? []).map((h) => [h.name, h.value]));
  const guard = (u: string) => assertPublicUrl(u, s.allowPrivateNetwork);

  await guard(url);
  if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
  if (rule?.paused) throw new FetchError("paused", `Requests to ${host} are paused in Sites. Resume the site to continue.`);

  const paused = hostBlockedFor(host);
  if (paused > 60_000) {
    throw new FetchError("blocked", `${host} recently asked Scaper to slow down. It will try again in about ${Math.ceil(paused / 60_000)} min.`);
  }

  // A site rule can only slow Scaper down for that site, never make it faster than the default.
  let minDelayMs = Math.max(rule?.delay_seconds ?? 0, s.minDelaySeconds) * 1000;
  const respectRobots = rule?.respect_robots ?? s.respectRobots;
  if (respectRobots) {
    const verdict = await checkRobots(url, ROBOTS_TOKEN, (u) =>
      httpGet(u, { userAgent: fastUa, timeoutMs: 10_000, proxyUrl: s.proxyUrl, accept: "text/plain", checkUrl: guard }).then((r) => ({ status: r.status, text: r.text })),
    );
    if (!verdict.allowed) {
      throw new FetchError("robots", `${host}'s robots.txt asks bots not to load this page. Scaper respects that. You can turn the robots.txt check off in Settings (or for this site in Sites) for pages you have permission to scrape.`);
    }
    if (verdict.crawlDelaySeconds && verdict.crawlDelaySeconds * 1000 > minDelayMs) {
      minDelayMs = Math.min(verdict.crawlDelaySeconds * 1000, 120_000);
      notes.push(`Using the site's crawl delay of ${verdict.crawlDelaySeconds}s.`);
    }
  }

  return withHostTurn(host, minDelayMs, async () => {
    if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    const reqStarted = Date.now();
    let page: Omit<FetchedPage, "durationMs" | "notes" | "mode" | "url">;
    let retryAfter: string | null = null;
    let status: number | null = null;
    try {
      if (mode === "fast") {
        const res = await httpGet(url, { userAgent: fastUa, timeoutMs, proxyUrl: s.proxyUrl, checkUrl: guard, headers, cookies: rule?.cookies, signal: opts.signal, accept: opts.accept });
        retryAfter = res.headers.get("retry-after");
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.text)?.[1]?.trim() ?? "";
        page = { finalUrl: res.url, status: res.status, html: res.text, title, contentType: res.headers.get("content-type") };
      } else {
        const res = await browserGet(url, {
          userAgent: browserUa, timeoutMs, proxyUrl: s.proxyUrl, blockHeavy: s.blockHeavyResources,
          screenshot: Boolean(opts.screenshot || opts.inspect), inspect: opts.inspect, maxConcurrency: s.maxConcurrency, allowPrivate: s.allowPrivateNetwork,
          scroll: opts.scroll, steps: opts.steps, pagination: opts.pagination, headers, cookies: rule?.cookies, capture: opts.capture, signal: opts.signal,
        });
        notes.push(...res.stepLog);
        page = { finalUrl: res.url, status: res.status, html: res.html, title: res.title, text: res.text, screenshot: res.screenshot, inspect: res.inspect, pages: res.pages, capture: res.capture };
      }
      status = page.status;

      const wall = detectBotWall(page.html, page.status);
      if (wall || (page.status === 503 && !opts.uptime)) {
        penalize(host, parseRetryAfter(retryAfter));
        throw new FetchError(
          "blocked",
          `${wall ?? "The site is temporarily refusing requests (503)"}. Scaper does not bypass bot checks, so it paused requests to ${host} and will back off. Try a longer interval, check the page in your own browser, or use the site's official API.`,
          page.status,
        );
      }
      if (page.status >= 400) {
        if (page.status === 403) penalize(host);
        throw new FetchError("http", `The site answered with HTTP ${page.status}.`, page.status);
      }
      reward(host);
      recordHostRequest(host, { ok: true, blocked: false, ms: Date.now() - reqStarted, bytes: page.html.length, status });
      return { ...page, url, mode, durationMs: Date.now() - started, requestMs: Date.now() - reqStarted, notes };
    } catch (e) {
      const code = e instanceof FetchError ? e.code : "network";
      if (code !== "cancelled") {
        recordHostRequest(host, { ok: false, blocked: code === "blocked", ms: Date.now() - reqStarted, bytes: 0, status: status ?? (e as FetchError).status ?? null });
      }
      throw e;
    }
  });
}
