import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Condition, FetchMode, WatcherOptions, WatchTarget } from "@/lib/schemas";
import { chat, parseJsonReply } from "../ai/client";
import { UNTRUSTED_NOTE } from "../ai/extract";
import { bus } from "../bus";
import { load, readableText, safeSelect } from "../extract/dom";
import { parsePrice } from "../extract/price";
import { parseProduct } from "../deals/parsers";
import { fetchPage, FetchError, type FetchedPage } from "../fetcher";
import { deliver } from "../notify";
import { audit } from "../repo/events";
import { getSettings } from "../repo/settings";
import {
  addIgnoreLines, addSnapshot, latestScreenshot, latestSnapshot, markErrorAlerted, notUsefulExamples, rebaseLatest, recordCheck, touchSnapshot,
  type ConditionResult, type DiffSummary, type Verdict, type Watcher,
} from "../repo/watchers";
import { newId } from "../repo/util";
import { compilePatterns } from "../tasks/urls";
import { combine, evaluate, type ChangeInfo, type Evaluation } from "./conditions";
import { diffLines, summarizeDiff } from "./diff";
import { nextCheckTime } from "./schedule";
import { feedLines, readJsonPath, sitemapLines, stableJson } from "./targets";
import { compareImages, readMedia, saveMedia } from "./visual";

const MAX_CONTENT = 200_000;

export function dropIgnored(content: string, ignore: string[]) {
  if (!ignore.length) return content;
  const needles = ignore.map((i) => i.toLowerCase());
  return content.split("\n").filter((line) => !needles.some((n) => line.toLowerCase().includes(n))).join("\n");
}

/** Noise filters applied before storing and comparing: ignored phrases, keep-only and ignore patterns. */
export function applyFilters(content: string, ignore: string[], o: Pick<WatcherOptions, "onlyMatching" | "ignoreRegex">) {
  let lines = dropIgnored(content, ignore).split("\n");
  if (o.onlyMatching) { const re = new RegExp(o.onlyMatching, "i"); lines = lines.filter((l) => re.test(l)); }
  if (o.ignoreRegex) { const re = new RegExp(o.ignoreRegex, "i"); lines = lines.filter((l) => !re.test(l)); }
  return lines.join("\n");
}

/** What the change check compares: optionally without digits or letter case, always without runs of spaces. */
export function compareKey(content: string, o: Pick<WatcherOptions, "ignoreNumbers" | "ignoreCase">) {
  let s = content.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (o.ignoreNumbers) s = s.replace(/\d+([.,]\d+)*/g, "#");
  if (o.ignoreCase) s = s.toLowerCase();
  return s;
}

export type TargetRead = { content: string; value: number | null; inStock?: boolean | null };

export function readTarget(html: string, url: string, target: WatchTarget, renderedText?: string, ignore: string[] = [], options?: Pick<WatcherOptions, "onlyMatching" | "ignoreRegex">): TargetRead {
  const r = readTargetRaw(html, url, target, renderedText);
  return { ...r, content: applyFilters(r.content, ignore, options ?? { onlyMatching: "", ignoreRegex: "" }) };
}

function readTargetRaw(html: string, url: string, target: WatchTarget, renderedText?: string): TargetRead {
  if (target.type === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(html);
    } catch {
      // Browser mode wraps JSON in a <pre>.
      try { doc = JSON.parse(load(html)("pre").first().text() || "x"); } catch { throw new Error("The response is not valid JSON. Check the URL, or use a page watcher instead."); }
    }
    const v = readJsonPath(doc, target.path);
    return { content: stableJson(v).slice(0, MAX_CONTENT), value: typeof v === "number" ? v : typeof v === "string" ? parsePrice(v)?.value ?? null : null };
  }
  if (target.type === "feed") {
    const lines = feedLines(html);
    if (!lines.length) throw new Error("No RSS or Atom items found at this URL.");
    return { content: lines.join("\n"), value: lines.length };
  }
  if (target.type === "sitemap") {
    const lines = sitemapLines(html, compilePatterns(target.include));
    if (!lines.length && !/<urlset|<sitemapindex/i.test(html)) throw new Error("This doesn't look like a sitemap.xml.");
    return { content: lines.join("\n"), value: lines.length };
  }
  const $ = load(html);
  if (target.type === "page" || (target.type === "visual" && !target.selector)) {
    const content = (renderedText?.trim() ? renderedText.replace(/\n{2,}/g, "\n").trim() : readableText($)).slice(0, MAX_CONTENT);
    return { content, value: null, inStock: stockFromText(content) };
  }
  if (target.type === "selector" || target.type === "visual") {
    const els = safeSelect($, target.selector);
    if (!els.length) throw new Error(`The selector "${target.selector}" matched nothing on the page. The site may have changed its layout.`);
    const content = els.toArray().map((el) => readableText($, $(el))).join("\n").slice(0, MAX_CONTENT);
    return { content, value: parsePrice(content)?.value ?? null, inStock: stockFromText(content) };
  }
  if (target.type === "price") {
    // An explicit selector wins, otherwise detect the product price (JSON-LD, microdata, OpenGraph, Amazon layout).
    const product = parseProduct(html, url);
    if (target.selector) {
      const text = safeSelect($, target.selector).first().text();
      const p = parsePrice(text);
      if (!p) throw new Error(`No price found in "${target.selector}".`);
      return { content: `Price: ${p.value}${p.currency ? ` ${p.currency}` : ""}${product.inStock === false ? "\nOut of stock" : ""}`, value: p.value, inStock: product.inStock };
    }
    if (product.price === null) throw new Error("Could not find a price on this page. Pick the price element with a CSS selector instead.");
    return { content: `Price: ${product.price}${product.currency ? ` ${product.currency}` : ""}${product.inStock === false ? "\nOut of stock" : ""}`, value: product.price, inStock: product.inStock };
  }
  return { content: "", value: null };
}

function stockFromText(text: string): boolean | null {
  if (/\b(out of stock|currently unavailable|sold out|notify me when available)\b/i.test(text)) return false;
  if (/\b(in stock|add to cart|add to basket|buy now)\b/i.test(text)) return true;
  return null;
}

const aiVerdictSchema = z.object({ match: z.boolean(), reason: z.string().max(500).default("") });

async function askAi(question: string, summary: string, after: string) {
  const res = await chat(
    [
      { role: "system", content: `You decide whether a website change matters to the user. Reply with JSON {"match": true|false, "reason": "one short sentence"}. ${UNTRUSTED_NOTE}` },
      { role: "user", content: `The user wants to know: ${question}\n<page>\nCHANGE:\n${summary}\n\nCURRENT CONTENT (start):\n${after.slice(0, 6000)}\n</page>` },
    ],
    { model: "fast", json: true, temperature: 0, maxTokens: 200, purpose: "watcher" },
  );
  return aiVerdictSchema.parse(parseJsonReply(res.content));
}

async function aiSummary(summary: string) {
  const res = await chat(
    [
      { role: "system", content: `Summarize a website change for a notification in one plain sentence of at most 25 words. ${UNTRUSTED_NOTE}` },
      { role: "user", content: `<page>${summary.slice(0, 4000)}</page>` },
    ],
    { model: "fast", temperature: 0, maxTokens: 80, purpose: "watcher" },
  );
  return res.content.trim().split("\n")[0]!.slice(0, 300);
}

const importanceSchema = z.object({ important: z.boolean(), summary: z.string().max(400).default("") });

/**
 * Change triage by your AI: is this change important to you, in one sentence what changed. It sees the
 * watcher's purpose (name, tags, AI rule) and the changes you marked "not useful", so it learns your taste.
 */
async function judgeChange(w: Watcher, change: string, after: string) {
  const notUseful = notUsefulExamples(w.id);
  const question = [w.condition, ...w.options.moreConditions].find((c) => c.type === "ai");
  const res = await chat(
    [
      { role: "system", content: `You triage website changes for the user. Decide whether this change is important to them, and summarize it in one plain sentence of at most 25 words. Routine noise (dates, counters, ads, reordered items, session tokens) is not important. Changes similar to ones the user marked "not useful" are not important. Reply with JSON {"important": true|false, "summary": "..."}. ${UNTRUSTED_NOTE}` },
      { role: "user", content: `Watcher: ${w.name} (${w.url})${w.tags.length ? `\nTags: ${w.tags.join(", ")}` : ""}${question && question.type === "ai" ? `\nThe user wants to know: ${question.question}` : ""}${notUseful.length ? `\nChanges the user marked not useful before:\n${notUseful.map((n) => `- ${n}`).join("\n")}` : ""}\n<page>\nCHANGE:\n${change}\n\nCURRENT CONTENT (start):\n${after.slice(0, 4000)}\n</page>` },
    ],
    { model: "fast", json: true, temperature: 0, maxTokens: 200, purpose: "watcher" },
  );
  return importanceSchema.parse(parseJsonReply(res.content));
}

/** "Not useful" → ignore these lines from now on, without losing history or reporting a change next time. */
export function ignoreFromFeedback(watcherId: string, lines: string[]) {
  const w = addIgnoreLines(watcherId, lines);
  if (!w) return null;
  const latest = latestSnapshot(w.id);
  if (latest) {
    const content = applyFilters(latest.content, w.ignore_lines, w.options);
    rebaseLatest(w.id, content, hashOf(compareKey(content, w.options)));
  }
  return w;
}

export type CheckOutcome = {
  status: "ok" | "error" | "blocked"; changed: boolean; triggered: boolean; message: string; value: number | null;
  visualChange?: number | null; snapshotId?: string | null; verdict?: Verdict | null;
};

type Hooks = { signal?: AbortSignal; log?: (level: "info" | "warn" | "error", message: string) => void };

function effectiveMode(w: Watcher): FetchMode {
  if (["json", "feed", "sitemap", "status"].includes(w.target.type)) return "fast";
  if (w.target.type === "visual") return "browser";
  return w.mode;
}

const ACCEPT: Partial<Record<WatchTarget["type"], string>> = {
  json: "application/json,text/plain;q=0.8,*/*;q=0.5",
  feed: "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5",
  sitemap: "application/xml,text/xml;q=0.9,*/*;q=0.5",
};

/** Uptime: a down or slow page is a result, not a failed check. */
async function readStatus(w: Watcher, signal?: AbortSignal): Promise<{ page: FetchedPage | null; read: TargetRead; code: number; ms: number }> {
  const maxMs = w.target.type === "status" ? w.target.maxMs : null;
  const t0 = Date.now();
  try {
    const page = await fetchPage(w.url, "fast", { signal, uptime: true });
    const ms = page.requestMs ?? Date.now() - t0;
    const slow = maxMs !== null && ms > maxMs;
    return { page, code: page.status, ms, read: { content: slow ? `Status: slow (over ${maxMs} ms)` : "Status: up", value: ms } };
  } catch (e) {
    if (!(e instanceof FetchError) || !["http", "network", "timeout"].includes(e.code)) throw e;
    const code = e.status ?? 0;
    return { page: null, code, ms: Date.now() - t0, read: { content: code ? `Status: down (HTTP ${code})` : `Status: down (${e.code === "timeout" ? "timed out" : "unreachable"})`, value: null } };
  }
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

/** One watcher check: fetch → read target → filter → compare with the last snapshot → evaluate rules → maybe alert. */
export async function checkWatcher(w: Watcher, hooks: Hooks = {}): Promise<CheckOutcome> {
  const o = w.options;
  const log = hooks.log ?? (() => undefined);
  const settings = getSettings().notifications;
  try {
    const mode = effectiveMode(w);
    const visual = w.target.type === "visual";
    const wantShot = mode === "browser" && (visual || o.screenshot);
    let page: FetchedPage | null = null;
    let cur: TargetRead;
    let statusCode: number | null = null;
    let responseMs: number | null = null;
    if (w.target.type === "status") {
      const s = await readStatus(w, hooks.signal);
      page = s.page; cur = s.read; statusCode = s.code; responseMs = s.ms;
    } else {
      page = await fetchPage(w.url, mode, {
        steps: mode === "browser" ? o.steps : undefined,
        capture: wantShot ? { selector: visual && w.target.type === "visual" ? w.target.selector || undefined : undefined } : undefined,
        accept: ACCEPT[w.target.type],
        signal: hooks.signal,
      });
      statusCode = page.status;
      responseMs = page.requestMs ?? null;
      cur = readTarget(page.html, page.finalUrl, w.target, page.text, w.ignore_lines, o);
    }
    log("info", `Fetched ${page?.finalUrl ?? w.url}${statusCode ? ` (HTTP ${statusCode})` : ""}.`);

    const hash = hashOf(compareKey(cur.content, o));
    const prev = latestSnapshot(w.id);
    const snapshotId = newId();

    // Visual comparison against the last saved screenshot.
    let visualChange: number | null = null;
    let screenshot: string | null = null;
    let visualDiff: string | null = null;
    let visualChanged = false;
    if (page?.capture) {
      const prevShot = latestScreenshot(w.id);
      const prevBuf = prevShot ? await readMedia(prevShot) : null;
      if (prevBuf) {
        try {
          const cmp = compareImages(prevBuf, page.capture);
          visualChange = cmp.percent;
          const threshold = w.target.type === "visual" ? w.target.threshold : 0.5;
          visualChanged = cmp.percent >= threshold;
          if (visualChanged) visualDiff = await saveMedia(`watchers/${w.id}/${snapshotId}-diff.png`, cmp.diff);
          log("info", `Visual change: ${cmp.percent}% of pixels.`);
        } catch (e) {
          log("warn", `Visual comparison failed: ${(e as Error).message}`);
        }
      }
    }

    const textChanged = prev !== null && prev.content_hash !== hash;
    const changed = visual ? prev !== null && (visualChanged || ("selector" in w.target && Boolean(w.target.selector) && textChanged)) : textChanged;
    const diff: DiffSummary | null = textChanged && prev ? diffLines(prev.content, cur.content) : null;
    if (diff) log("info", `${diff.added} line(s) added, ${diff.removed} removed.`);
    // "Only when lines are added/removed": other changes still move the baseline, but don't count.
    const significant = changed && (visual || o.triggerOn === "any" || !diff || (o.triggerOn === "added" ? diff.added > 0 : diff.removed > 0));
    const change: ChangeInfo = {
      changed: significant,
      addedText: diff?.patch.filter((p) => p.op === "+").map((p) => p.text).join("\n") ?? "",
      removedText: diff?.patch.filter((p) => p.op === "-").map((p) => p.text).join("\n") ?? "",
    };

    const conditions: Condition[] = [w.condition, ...o.moreConditions];
    const prevResults = prev?.verdict?.results ?? [];
    const evals: Evaluation[] = [];
    for (const [i, c] of conditions.entries()) {
      let ai: { match: boolean; reason: string } | undefined;
      if (c.type === "ai" && significant) {
        const summary = diff ? summarizeDiff(diff, 15) : `Visual change of ${visualChange ?? "?"}%`;
        ai = await askAi(c.question, summary, cur.content).catch((e: Error) => ({ match: true, reason: `AI check failed (${e.message}); alerting to be safe.` }));
      }
      const prevMet = prevResults[i]?.met ?? (i === 0 ? Boolean(prev?.triggered) : false);
      evals.push(evaluate(c, prev ? { content: prev.content, value: prev.value, met: prevMet } : null, cur, change, ai));
    }
    const ev = combine(evals, o.match, Boolean(prev?.triggered));
    const results: ConditionResult[] = conditions.map((c, i) => ({ type: c.type, met: evals[i]!.met, reason: evals[i]!.reason }));

    // Triage: important or not (your AI, or "did the rule match"), and a one-line summary.
    let important: boolean | null = null;
    let summaryText: string | null = null;
    if (significant) {
      const changeText = diff ? summarizeDiff(diff, 20) : `Visual change of ${visualChange ?? "?"}%`;
      if (o.aiImportance) {
        const j = await judgeChange(w, changeText, cur.content).catch((e: Error) => { log("warn", `AI triage failed: ${e.message}`); return null; });
        if (j) { important = j.important; summaryText = j.summary.trim() || null; }
      }
      if (!summaryText && o.aiSummary && diff) summaryText = await aiSummary(summarizeDiff(diff, 20)).catch(() => null);
      important ??= ev.met;
    }

    let notify = ev.notify;
    let suppressed: string | undefined;
    if (notify && o.aiImportance && o.importantOnly && important === false) {
      notify = false;
      suppressed = "Your AI judged this change not important, so no alert was sent.";
    }
    if (notify && o.cooldownMinutes && w.last_notified_at && Date.now() - Date.parse(w.last_notified_at) < o.cooldownMinutes * 60_000) {
      notify = false;
      suppressed = `In the ${o.cooldownMinutes}-minute quiet period after the last alert.`;
    }
    const verdict: Verdict = { met: ev.met, notified: notify, reason: ev.reason, results, suppressed };

    let savedId: string | null = null;
    const isNew = !prev || textChanged || visualChanged;
    if (!isNew && prev) {
      touchSnapshot(prev.id, { statusCode, responseMs });
    } else {
      // Keep screenshots for visual watchers and, when asked, for baselines and changes.
      if (page?.capture && (visual || !prev || changed)) screenshot = await saveMedia(`watchers/${w.id}/${snapshotId}.png`, page.capture);
      savedId = addSnapshot({
        id: snapshotId, watcherId: w.id, content: cur.content, hash, value: cur.value, changed, triggered: ev.met, diff,
        screenshot, visualDiff, visualChange, verdict, statusCode, responseMs, important, summary: summaryText,
      });
    }

    if (notify) {
      const parts = [ev.reason];
      if (visualChange !== null && visualChanged) parts.push(`${visualChange}% of the ${"selector" in w.target && w.target.selector ? "element" : "page"} looks different.`);
      if (diff && !["below", "above"].includes(w.condition.type)) parts.push(summarizeDiff(diff));
      if (summaryText) parts.unshift(`AI: ${summaryText}`);
      const image = visualDiff ? await readMedia(visualDiff) : screenshot ? await readMedia(screenshot) : null;
      await deliver({ kind: "watcher", event: "watcherChange", title: w.name, body: parts.filter(Boolean).join("\n"), url: w.url, watcherId: w.id, data: { value: cur.value, condition: w.condition.type, snapshotId: savedId, important, summary: summaryText }, image }, w.notify);
      log("info", "Alert sent.");
    } else if (suppressed) {
      log("info", suppressed);
    }

    // Tell the user once when a watcher that kept failing works again.
    if (w.error_alerted_at && w.fail_count >= settings.failureAlertAfter) {
      await deliver({ kind: "system", title: `${w.name} is working again`, body: `The check succeeded after ${w.fail_count} failed attempt(s).`, url: w.url, watcherId: w.id }, { ...w.notify, desktop: false });
    }

    recordCheck(w.id, { status: "ok", value: cur.value, changed, notified: notify, nextCheckAt: nextCheckTime(w.interval_minutes, o, 0).toISOString() });
    bus.emit({ type: "watcher", id: w.id, status: "ok" });
    const message = !prev ? "Baseline saved. Future checks compare against it." : changed ? (significant ? "Change detected." : "Changed, but not in a way your trigger counts.") : "No change.";
    return { status: "ok", changed, triggered: notify, value: cur.value, message, visualChange, snapshotId: savedId ?? prev?.id ?? null, verdict };
  } catch (e) {
    const blocked = e instanceof FetchError && (e.code === "blocked" || e.code === "robots" || e.code === "paused");
    const message = (e as Error).message;
    const failures = w.fail_count + 1;
    recordCheck(w.id, { status: blocked ? "blocked" : "error", error: message, changed: false, nextCheckAt: nextCheckTime(w.interval_minutes, o, failures).toISOString() });
    audit("watcher.failed", { watcherId: w.id, failures, error: message }, "warn");
    log("error", message);
    // Alert after N failures in a row, then at most once per cooldown, instead of on every attempt.
    const cooled = !w.error_alerted_at || Date.now() - Date.parse(w.error_alerted_at) > settings.errorAlertCooldownMinutes * 60_000;
    if (failures >= settings.failureAlertAfter && cooled) {
      markErrorAlerted(w.id);
      await deliver({ kind: "system", title: `${w.name} keeps failing`, body: `${message}\nFailed ${failures} time(s) in a row. Scaper is backing off and will keep retrying less often.`, url: w.url, watcherId: w.id }, w.notify);
    }
    bus.emit({ type: "watcher", id: w.id, status: "error" });
    return { status: blocked ? "blocked" : "error", changed: false, triggered: false, value: null, message };
  }
}
