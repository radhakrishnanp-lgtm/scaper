import "server-only";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { FetchError } from "../fetcher/errors";
import { dispatcherFor } from "../fetcher/http";
import { log } from "../log";
import { audit } from "../repo/events";
import { getSettings } from "../repo/settings";

/**
 * Firecrawl (https://docs.firecrawl.dev, API v2) with your own key: it loads a page in its browsers and returns the HTML
 * and Markdown, searches the web, or lists a site's links. Scaper reads what comes back with your selectors and your
 * own AI model, so Firecrawl is just another way to load a page. Scaper's robots.txt check runs before each URL and
 * crawls always keep Firecrawl's own robots.txt check on; no stealth proxy option is ever sent.
 */

export class IntegrationError extends Error {
  constructor(public service: "firecrawl" | "apify", message: string, public status?: number) { super(message); }
}

export const firecrawlReady = () => Boolean(getSettings().integrations.firecrawlKey);

const base = () => getSettings().integrations.firecrawlUrl.replace(/\/+$/, "");

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const s = getSettings();
  const key = s.integrations.firecrawlKey;
  if (!key) throw new IntegrationError("firecrawl", "Add your Firecrawl API key in Integrations → Firecrawl first.");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  let res;
  try {
    res = await undiciFetch(`${base()}/v2${path}`, {
      method, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      dispatcher: s.scraping.proxyAi ? dispatcherFor(s.scraping.proxyUrl) : dispatcherFor(""),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "Scaper/1.0" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    const err = e as Error;
    if (err.name === "TimeoutError") throw new IntegrationError("firecrawl", `Firecrawl did not answer within ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} s.`);
    throw new IntegrationError("firecrawl", `Could not reach Firecrawl: ${(err.cause as Error | undefined)?.message ?? err.message}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* plain-text error */ }
  if (!res.ok) {
    const detail = String(json.error ?? json.message ?? text).slice(0, 300);
    const msg = res.status === 401 ? "Firecrawl refused the API key (401). Check it in Integrations → Firecrawl."
      : res.status === 402 ? "Your Firecrawl account is out of credits (402)."
      : res.status === 429 ? "Firecrawl's rate limit for your plan was reached (429). Try again in a minute."
      : `Firecrawl answered ${res.status}: ${detail}`;
    throw new IntegrationError("firecrawl", msg, res.status);
  }
  return json as T;
}

const metaSchema = z.object({ title: z.unknown().optional(), sourceURL: z.string().optional(), url: z.string().optional(), statusCode: z.coerce.number().optional(), error: z.string().nullable().optional() }).passthrough();
const pageSchema = z.object({
  markdown: z.string().nullable().optional(), html: z.string().nullable().optional(), rawHtml: z.string().nullable().optional(),
  links: z.array(z.unknown()).nullable().optional(), json: z.unknown().optional(), summary: z.string().nullable().optional(),
  metadata: metaSchema.default({}),
}).passthrough();
export type FirecrawlPage = { url: string; status: number; title: string; html: string; markdown: string; links: string[]; json?: unknown };

const title = (t: unknown) => (Array.isArray(t) ? String(t[0] ?? "") : typeof t === "string" ? t : "");
const linkList = (l: unknown[] | null | undefined) => (l ?? []).map((x) => (typeof x === "string" ? x : (x as { url?: string })?.url ?? "")).filter(Boolean);

function toPage(url: string, d: z.infer<typeof pageSchema>): FirecrawlPage {
  return {
    url: d.metadata.url ?? d.metadata.sourceURL ?? url, status: d.metadata.statusCode ?? 200, title: title(d.metadata.title),
    html: d.rawHtml ?? d.html ?? "", markdown: d.markdown ?? "", links: linkList(d.links), json: d.json,
  };
}

/** One page through Firecrawl: its HTML (for your selectors) and Markdown (for your AI). */
export async function firecrawlScrape(url: string, opts: { signal?: AbortSignal; waitFor?: number; onlyMainContent?: boolean; formats?: string[]; mobile?: boolean } = {}): Promise<FirecrawlPage> {
  const started = Date.now();
  const r = await call<{ success?: boolean; data?: unknown }>("POST", "/scrape", {
    url, formats: opts.formats ?? ["rawHtml", "markdown", "links"], onlyMainContent: opts.onlyMainContent ?? false,
    ...(opts.waitFor ? { waitFor: opts.waitFor } : {}), ...(opts.mobile ? { mobile: true } : {}),
    timeout: getSettings().scraping.timeoutSeconds * 1000, blockAds: true,
  }, { signal: opts.signal, timeoutMs: getSettings().scraping.timeoutSeconds * 1000 + 30_000 });
  const parsed = pageSchema.safeParse(r.data);
  if (!parsed.success) throw new IntegrationError("firecrawl", "Firecrawl returned a page Scaper could not read.");
  const page = toPage(url, parsed.data);
  log.info("firecrawl.scrape", { host: new URL(url).hostname, ms: Date.now() - started, bytes: page.html.length });
  return page;
}

export type SearchHit = { url: string; title: string; description: string; markdown?: string };

/** Web search through Firecrawl; with `read`, the top results come back as Markdown too. */
export async function firecrawlSearch(query: string, opts: { limit?: number; read?: boolean; country?: string; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  const r = await call<{ data?: unknown }>("POST", "/search", {
    query: query.slice(0, 500), limit: Math.min(Math.max(opts.limit ?? 5, 1), 20), ...(opts.country ? { country: opts.country } : {}),
    ...(opts.read ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
  }, { signal: opts.signal });
  const data = r.data as { web?: unknown[] } | unknown[] | undefined;
  const items = Array.isArray(data) ? data : data?.web ?? [];
  audit("firecrawl.search", { results: items.length });
  return items.map((x) => {
    const o = x as Record<string, unknown>;
    return { url: String(o.url ?? ""), title: String(o.title ?? ""), description: String(o.description ?? o.snippet ?? ""), markdown: typeof o.markdown === "string" ? o.markdown : undefined };
  }).filter((h) => h.url);
}

/** Every link Firecrawl finds on a site (from its sitemap and pages), optionally ranked by a search word. */
export async function firecrawlMap(url: string, opts: { search?: string; limit?: number; signal?: AbortSignal } = {}) {
  const r = await call<{ links?: unknown[] }>("POST", "/map", { url, ...(opts.search ? { search: opts.search } : {}), limit: Math.min(opts.limit ?? 500, 5000) }, { signal: opts.signal });
  return (r.links ?? []).map((x) => (typeof x === "string" ? { url: x, title: "" } : { url: String((x as { url?: string }).url ?? ""), title: String((x as { title?: string }).title ?? "") })).filter((l) => l.url);
}

/** Credits left on the account, for the Integrations page (null when the endpoint is not available, e.g. self-hosted). */
export async function firecrawlCredits(): Promise<number | null> {
  try {
    const r = await call<{ data?: { remainingCredits?: number; remaining_credits?: number } }>("GET", "/team/credit-usage", undefined, { timeoutMs: 20_000 });
    const n = r.data?.remainingCredits ?? r.data?.remaining_credits;
    return typeof n === "number" ? n : null;
  } catch (e) {
    if (e instanceof IntegrationError && e.status === 401) throw e;
    return null;
  }
}

/** "Test" on the Integrations page: one small page, so a wrong key or URL shows at once. */
export async function testFirecrawl() {
  const started = Date.now();
  const page = await firecrawlScrape("https://example.com", { formats: ["markdown"], onlyMainContent: true });
  const credits = await firecrawlCredits();
  return { ms: Date.now() - started, title: page.title || "Example Domain", credits };
}
