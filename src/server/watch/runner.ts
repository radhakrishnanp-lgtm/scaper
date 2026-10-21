import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WatchTarget } from "@/lib/schemas";
import { chat, parseJsonReply } from "../ai/client";
import { UNTRUSTED_NOTE } from "../ai/extract";
import { bus } from "../bus";
import { load, readableText, safeSelect } from "../extract/dom";
import { parsePrice } from "../extract/price";
import { parseProduct } from "../deals/parsers";
import { fetchPage, FetchError } from "../fetcher";
import { deliver } from "../notify";
import { audit } from "../repo/events";
import { addSnapshot, latestSnapshot, recordCheck, touchSnapshot, type Watcher } from "../repo/watchers";
import { evaluate } from "./conditions";
import { diffLines, summarizeDiff } from "./diff";

const MAX_CONTENT = 200_000;

export function dropIgnored(content: string, ignore: string[]) {
  if (!ignore.length) return content;
  const needles = ignore.map((i) => i.toLowerCase());
  return content.split("\n").filter((line) => !needles.some((n) => line.toLowerCase().includes(n))).join("\n");
}

export function readTarget(html: string, url: string, target: WatchTarget, renderedText?: string, ignore: string[] = []): { content: string; value: number | null } {
  const r = readTargetRaw(html, url, target, renderedText);
  return { ...r, content: dropIgnored(r.content, ignore) };
}

function readTargetRaw(html: string, url: string, target: WatchTarget, renderedText?: string): { content: string; value: number | null } {
  const $ = load(html);
  if (target.type === "page") {
    const content = (renderedText?.trim() ? renderedText.replace(/\n{2,}/g, "\n").trim() : readableText($)).slice(0, MAX_CONTENT);
    return { content, value: null };
  }
  if (target.type === "selector") {
    const els = safeSelect($, target.selector);
    if (!els.length) throw new Error(`The selector "${target.selector}" matched nothing on the page. The site may have changed its layout.`);
    const content = els.toArray().map((el) => readableText($, $(el))).join("\n").slice(0, MAX_CONTENT);
    return { content, value: parsePrice(content)?.value ?? null };
  }
  // Price target: an explicit selector wins, otherwise detect the product price.
  if (target.selector) {
    const text = safeSelect($, target.selector).first().text();
    const p = parsePrice(text);
    if (!p) throw new Error(`No price found in "${target.selector}".`);
    return { content: `Price: ${p.value}${p.currency ? ` ${p.currency}` : ""}`, value: p.value };
  }
  const product = parseProduct(html, url);
  if (product.price === null) throw new Error("Could not find a price on this page. Pick the price element with a CSS selector instead.");
  return { content: `Price: ${product.price}${product.currency ? ` ${product.currency}` : ""}${product.inStock === false ? "\nOut of stock" : ""}`, value: product.price };
}

const aiVerdictSchema = z.object({ match: z.boolean(), reason: z.string().max(500).default("") });

async function askAi(question: string, summary: string, after: string) {
  const res = await chat(
    [
      { role: "system", content: `You decide whether a website change matters to the user. Reply with JSON {"match": true|false, "reason": "one short sentence"}. ${UNTRUSTED_NOTE}` },
      { role: "user", content: `The user wants to know: ${question}\n<page>\nCHANGE:\n${summary}\n\nCURRENT CONTENT (start):\n${after.slice(0, 6000)}\n</page>` },
    ],
    { model: "fast", json: true, temperature: 0, maxTokens: 200 },
  );
  return aiVerdictSchema.parse(parseJsonReply(res.content));
}

function nextCheck(w: Watcher, failures: number) {
  const base = w.interval_minutes * 60_000;
  const backoff = failures > 0 ? Math.min(base * 2 ** Math.min(failures, 5), Math.max(base, 6 * 60 * 60_000)) : base;
  const jitter = backoff * 0.1 * Math.random();
  return new Date(Date.now() + backoff + jitter).toISOString();
}

export type CheckOutcome = { status: "ok" | "error" | "blocked"; changed: boolean; triggered: boolean; message: string; value: number | null };

/** One watcher check: fetch → read target → compare with the last snapshot → maybe alert. */
export async function checkWatcher(w: Watcher): Promise<CheckOutcome> {
  try {
    const page = await fetchPage(w.url, w.mode);
    const cur = readTarget(page.html, page.finalUrl, w.target, page.text, w.ignore_lines);
    const hash = createHash("sha256").update(cur.content).digest("hex");
    const prev = latestSnapshot(w.id);
    const changed = prev !== null && prev.content_hash !== hash;
    const diff = changed ? diffLines(prev.content, cur.content) : null;

    let aiVerdict: { match: boolean; reason: string } | undefined;
    if (w.condition.type === "ai" && changed && diff) {
      aiVerdict = await askAi(w.condition.question, summarizeDiff(diff, 15), cur.content).catch((e: Error) => ({ match: true, reason: `AI check failed (${e.message}); alerting to be safe.` }));
    }
    const ev = evaluate(w.condition, prev ? { content: prev.content, value: prev.value, met: prev.triggered } : null, cur, changed, aiVerdict);

    if (prev && !changed) touchSnapshot(prev.id);
    else addSnapshot({ watcherId: w.id, content: cur.content, hash, value: cur.value, changed, triggered: ev.met, diff });

    if (ev.notify) {
      const body = [ev.reason, diff && w.condition.type !== "below" && w.condition.type !== "above" ? summarizeDiff(diff) : ""].filter(Boolean).join("\n");
      await deliver({ kind: "watcher", title: w.name, body, url: w.url, watcherId: w.id, data: { value: cur.value, condition: w.condition.type } }, w.notify);
    }
    recordCheck(w.id, { status: "ok", value: cur.value, changed, nextCheckAt: nextCheck(w, 0) });
    bus.emit({ type: "watcher", id: w.id, status: "ok" });
    return { status: "ok", changed, triggered: ev.notify, value: cur.value, message: prev ? (changed ? "Change detected." : "No change.") : "Baseline saved. Future checks compare against it." };
  } catch (e) {
    const blocked = e instanceof FetchError && (e.code === "blocked" || e.code === "robots");
    const message = (e as Error).message;
    const failures = w.fail_count + 1;
    recordCheck(w.id, { status: blocked ? "blocked" : "error", error: message, changed: false, nextCheckAt: nextCheck(w, failures) });
    audit("watcher.failed", { watcherId: w.id, failures, error: message }, "warn");
    // Tell the user once, on the third failure in a row, instead of on every attempt.
    if (failures === 3) {
      await deliver({ kind: "system", title: `${w.name} keeps failing`, body: `${message}\nScaper is backing off and will keep retrying less often.`, url: w.url, watcherId: w.id }, { ...w.notify, webhook: false, telegram: false });
    }
    bus.emit({ type: "watcher", id: w.id, status: "error" });
    return { status: blocked ? "blocked" : "error", changed: false, triggered: false, value: null, message };
  }
}
