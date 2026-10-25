import "server-only";
import { fetch as undiciFetch } from "undici";
import type { Cell, Dataset } from "@/lib/types";
import { FetchError } from "../fetcher/errors";
import { dispatcherFor } from "../fetcher/http";
import { log } from "../log";
import { audit } from "../repo/events";
import { getSettings } from "../repo/settings";
import { IntegrationError } from "./firecrawl";

/**
 * Apify (https://docs.apify.com/api/v2) with your own token: run an actor from the Apify Store, such as a YouTube,
 * Instagram or TikTok scraper, on your account and read its dataset. A run's cost is capped (max items and a dollar
 * limit for pay-per-result actors); what comes back is data, never instructions.
 */

/** SCAPER_APIFY_URL points at another server, for tests. */
const api = () => (process.env.SCAPER_APIFY_URL ?? "https://api.apify.com/v2").replace(/\/+$/, "");
export const apifyReady = () => Boolean(getSettings().integrations.apifyToken);

async function call<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const s = getSettings();
  const token = s.integrations.apifyToken;
  if (!token) throw new IntegrationError("apify", "Add your Apify API token in Integrations → Apify first.");
  const url = new URL(`${api()}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  let res;
  try {
    res = await undiciFetch(url, {
      method, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      dispatcher: s.scraping.proxyAi ? dispatcherFor(s.scraping.proxyUrl) : dispatcherFor(""),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "Scaper/1.0" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    const err = e as Error;
    if (err.name === "TimeoutError") throw new IntegrationError("apify", "Apify did not answer in time.");
    throw new IntegrationError("apify", `Could not reach Apify: ${(err.cause as Error | undefined)?.message ?? err.message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json as { error?: { type?: string; message?: string } } | null)?.error;
    const msg = res.status === 401 ? "Apify refused the token (401). Check it in Integrations → Apify."
      : res.status === 402 || e?.type === "not-enough-usage-to-run-paid-actor" ? `Your Apify account cannot pay for this run: ${e?.message ?? "no credit left"}.`
      : res.status === 404 ? `Apify could not find that (${e?.message ?? "404"}). Check the actor id, like apify~instagram-scraper.`
      : res.status === 429 ? "Apify's rate limit was reached (429). Try again shortly."
      : `Apify answered ${res.status}: ${e?.message ?? text.slice(0, 200)}`;
    throw new IntegrationError("apify", msg, res.status);
  }
  return json as T;
}

export type ApifyRun = {
  id: string; actId: string; status: string; startedAt: string; finishedAt: string | null; defaultDatasetId: string;
  usageTotalUsd?: number; statusMessage?: string | null; stats?: { runTimeSecs?: number };
};
const FINISHED = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"];

export async function apifyMe() {
  const r = await call<{ data: { username?: string; plan?: { id?: string }; email?: string } }>("GET", "/users/me");
  return { username: r.data.username ?? "", plan: r.data.plan?.id ?? null };
}

/** Actors in the Apify Store that match a search, most used first. */
export async function apifyStore(search: string, limit = 10) {
  const r = await call<{ data: { items: { username: string; name: string; title?: string; description?: string; stats?: { totalUsers?: number }; currentPricingInfo?: { pricingModel?: string } }[] } }>(
    "GET", "/store", { query: { search: search.slice(0, 100), limit: Math.min(limit, 30), sortBy: "popularity" } },
  );
  return r.data.items.map((a) => ({
    id: `${a.username}~${a.name}`, title: a.title ?? a.name, description: (a.description ?? "").slice(0, 300),
    users: a.stats?.totalUsers ?? null, pricing: a.currentPricingInfo?.pricingModel ?? null,
  }));
}

/** An actor's title and its example input (what its Input tab starts with), for the task editor. */
export async function apifyActor(actorId: string) {
  const r = await call<{ data: { name: string; username: string; title?: string; description?: string; exampleRunInput?: { body?: string } } }>("GET", `/acts/${encodeURIComponent(actorId)}`);
  let example: Record<string, unknown> = {};
  try { example = JSON.parse(r.data.exampleRunInput?.body ?? "{}") as Record<string, unknown>; } catch { /* no example */ }
  return { id: `${r.data.username}~${r.data.name}`, title: r.data.title ?? r.data.name, description: (r.data.description ?? "").slice(0, 400), example };
}

/** Starts an actor run with a cap on items and cost. */
export async function startActor(actorId: string, input: Record<string, unknown>, opts: { maxItems: number; timeoutSeconds: number; maxChargeUsd: number; signal?: AbortSignal }) {
  const r = await call<{ data: ApifyRun }>("POST", `/acts/${encodeURIComponent(actorId)}/runs`, {
    body: input, signal: opts.signal,
    query: { maxItems: opts.maxItems, timeout: opts.timeoutSeconds, ...(opts.maxChargeUsd > 0 ? { maxTotalChargeUsd: opts.maxChargeUsd } : {}) },
  });
  audit("apify.run_started", { actorId, runId: r.data.id, maxItems: opts.maxItems, maxChargeUsd: opts.maxChargeUsd });
  return r.data;
}

export async function getActorRun(runId: string, waitSeconds = 0, signal?: AbortSignal) {
  return (await call<{ data: ApifyRun }>("GET", `/actor-runs/${encodeURIComponent(runId)}`, { query: { waitForFinish: waitSeconds || undefined }, signal, timeoutMs: (waitSeconds + 30) * 1000 })).data;
}

export async function abortActorRun(runId: string) {
  try { await call("POST", `/actor-runs/${encodeURIComponent(runId)}/abort`); } catch (e) { log.warn("apify.abort_failed", { runId, error: (e as Error).message }); }
}

export async function datasetItems(datasetId: string, limit: number, offset = 0, signal?: AbortSignal) {
  return call<Record<string, unknown>[]>("GET", `/datasets/${encodeURIComponent(datasetId)}/items`, { query: { format: "json", clean: true, limit, offset }, signal, timeoutMs: 120_000 });
}

/**
 * Runs an actor to the end (polling, so long runs are fine), stops it on cancel, and returns its items.
 * `onProgress` gets the status every poll.
 */
export async function runActor(actorId: string, input: Record<string, unknown>, opts: {
  maxItems: number; timeoutSeconds: number; maxChargeUsd: number; signal?: AbortSignal;
  onProgress?: (run: ApifyRun) => void; onStarted?: (run: ApifyRun) => void;
}) {
  let run = await startActor(actorId, input, opts);
  opts.onStarted?.(run);
  try {
    while (!FINISHED.includes(run.status)) {
      if (opts.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
      run = await getActorRun(run.id, 30, opts.signal);
      opts.onProgress?.(run);
    }
  } catch (e) {
    if (opts.signal?.aborted) await abortActorRun(run.id);
    throw e;
  }
  if (run.status !== "SUCCEEDED") {
    throw new IntegrationError("apify", `The actor run ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ""}. See it at https://console.apify.com/actors/runs/${run.id}`);
  }
  const items: Record<string, unknown>[] = [];
  while (items.length < opts.maxItems) {
    const page = await datasetItems(run.defaultDatasetId, Math.min(1000, opts.maxItems - items.length), items.length, opts.signal);
    items.push(...page);
    if (page.length < 1000) break;
  }
  audit("apify.run_done", { actorId, runId: run.id, items: items.length, usd: run.usageTotalUsd ?? null });
  return { run, items };
}

/** Flattens actor items into table rows: nested objects become dotted columns, lists of values are joined. */
export function itemsToDataset(items: Record<string, unknown>[], name = "Items"): Dataset {
  const columns: string[] = [];
  const rows = items.map((it) => {
    const row: Record<string, Cell> = {};
    const put = (k: string, v: unknown, depth: number) => {
      if (v === null || v === undefined) { row[k] = null; return; }
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { row[k] = v; return; }
      if (Array.isArray(v)) {
        row[k] = v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)) ? v.join(", ").slice(0, 4000) : JSON.stringify(v).slice(0, 4000);
        return;
      }
      if (depth >= 2) { row[k] = JSON.stringify(v).slice(0, 4000); return; }
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) put(`${k}.${kk}`, vv, depth + 1);
    };
    for (const [k, v] of Object.entries(it)) put(k, v, 0);
    for (const k of Object.keys(row)) if (!columns.includes(k) && columns.length < 80) columns.push(k);
    return row;
  });
  return { name, columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))) };
}

export async function testApify() {
  const started = Date.now();
  const me = await apifyMe();
  return { ms: Date.now() - started, ...me };
}
