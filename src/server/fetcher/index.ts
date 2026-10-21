import "server-only";
import type { FetchMode } from "@/lib/schemas";
import { getSettings } from "../repo/settings";
import { browserGet } from "./browser";
import { FetchError } from "./errors";
import { httpGet } from "./http";
import { assertPublicUrl } from "./network-guard";
import { checkRobots, detectBotWall, hostBlockedFor, parseRetryAfter, penalize, reward, withHostTurn } from "./politeness";

export { FetchError } from "./errors";

export const ROBOTS_TOKEN = "Scaper";
export const DEFAULT_FAST_UA = "Mozilla/5.0 (compatible; Scaper/1.0; personal page monitor)";

export type FetchedPage = {
  url: string; finalUrl: string; status: number; html: string; title: string; text?: string;
  screenshot?: string; mode: FetchMode; durationMs: number; notes: string[];
};

/**
 * The one entry point for loading a page. Order: network guard → robots.txt →
 * wait for this host's turn → fetch → bot-check detection → backoff bookkeeping.
 */
export async function fetchPage(url: string, mode: FetchMode, opts: { screenshot?: boolean; scroll?: boolean } = {}): Promise<FetchedPage> {
  const s = getSettings().scraping;
  const started = Date.now();
  const notes: string[] = [];
  const host = new URL(url).hostname;
  const timeoutMs = s.timeoutSeconds * 1000;
  const fastUa = s.userAgent || DEFAULT_FAST_UA;
  const guard = (u: string) => assertPublicUrl(u, s.allowPrivateNetwork);

  await guard(url);

  const paused = hostBlockedFor(host);
  if (paused > 60_000) {
    throw new FetchError("blocked", `${host} recently asked Scaper to slow down. It will try again in about ${Math.ceil(paused / 60_000)} min.`);
  }

  let minDelayMs = s.minDelaySeconds * 1000;
  if (s.respectRobots) {
    const verdict = await checkRobots(url, ROBOTS_TOKEN, (u) =>
      httpGet(u, { userAgent: fastUa, timeoutMs: 10_000, proxyUrl: s.proxyUrl, accept: "text/plain", checkUrl: guard }).then((r) => ({ status: r.status, text: r.text })),
    );
    if (!verdict.allowed) {
      throw new FetchError("robots", `${host}'s robots.txt asks bots not to load this page. Scaper respects that. You can turn the robots.txt check off in Settings for pages you have permission to scrape.`);
    }
    if (verdict.crawlDelaySeconds && verdict.crawlDelaySeconds * 1000 > minDelayMs) {
      minDelayMs = Math.min(verdict.crawlDelaySeconds * 1000, 120_000);
      notes.push(`Using the site's crawl delay of ${verdict.crawlDelaySeconds}s.`);
    }
  }

  return withHostTurn(host, minDelayMs, async () => {
    let page: Omit<FetchedPage, "durationMs" | "notes" | "mode" | "url">;
    let retryAfter: string | null = null;
    if (mode === "fast") {
      const res = await httpGet(url, { userAgent: fastUa, timeoutMs, proxyUrl: s.proxyUrl, checkUrl: guard });
      retryAfter = res.headers.get("retry-after");
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.text)?.[1]?.trim() ?? "";
      page = { finalUrl: res.url, status: res.status, html: res.text, title };
    } else {
      const res = await browserGet(url, {
        userAgent: s.userAgent, timeoutMs, proxyUrl: s.proxyUrl, blockHeavy: s.blockHeavyResources,
        screenshot: Boolean(opts.screenshot), maxConcurrency: s.maxConcurrency, allowPrivate: s.allowPrivateNetwork, scroll: opts.scroll,
      });
      page = { finalUrl: res.url, status: res.status, html: res.html, title: res.title, text: res.text, screenshot: res.screenshot };
    }

    const wall = detectBotWall(page.html, page.status);
    if (wall || page.status === 503) {
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
    return { ...page, url, mode, durationMs: Date.now() - started, notes };
  });
}
