import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { fetchPage } from "@/server/fetcher";
import { combine, evaluate } from "@/server/watch/conditions";
import { readTarget } from "@/server/watch/runner";
import { feedLines } from "@/server/watch/targets";
import { watcherSchema } from "@/lib/schemas";

const schema = z.object({ watcher: watcherSchema, sample: z.string().max(200_000).optional() });

/**
 * "Test" in the watcher form: reads the page (or uses pasted sample text) exactly as a check would,
 * and shows what would be compared and which conditions hold right now. Nothing is saved.
 */
export const POST = handler(async (req) => {
  rateLimit("watch:preview", 12, 4);
  const { watcher: w, sample } = await readJson(req, schema);
  let content: string;
  let value: number | null = null;
  let inStock: boolean | null | undefined;
  let note = "";
  if (sample !== undefined) {
    content = sample;
    value = /-?\d[\d,]*(\.\d+)?/.exec(sample) ? Number(/-?\d[\d,]*(\.\d+)?/.exec(sample)![0].replace(/,/g, "")) : null;
    note = "Tested against your sample text.";
  } else if (w.target.type === "status") {
    const page = await fetchPage(w.url, "fast").catch((e: Error) => { throw e; });
    content = `Status: up (HTTP ${page.status}, ${page.requestMs ?? page.durationMs} ms)`;
    value = page.requestMs ?? null;
  } else {
    const mode = ["json", "feed", "sitemap"].includes(w.target.type) ? "fast" : w.target.type === "visual" ? "browser" : w.mode;
    const page = await fetchPage(w.url, mode, { steps: mode === "browser" || mode === "auto" ? w.options.steps : undefined });
    const read = readTarget(page.html, page.finalUrl, w.target, page.text, w.ignoreLines, w.options);
    content = read.content; value = read.value; inStock = read.inStock;
    if (w.target.type === "feed") note = `${feedLines(page.html).length} feed item(s).`;
    if (page.notes.length) note = [note, ...page.notes].filter(Boolean).join(" ");
  }
  const conditions = [w.condition, ...w.options.moreConditions];
  // No previous check: "state" conditions show whether they hold now; change-based ones need a real change.
  const change = { changed: true, addedText: content, removedText: "" };
  const evals = conditions.map((c) => evaluate(c, null, { content, value, inStock }, change, c.type === "ai" ? { match: false, reason: "AI conditions are only judged on real changes." } : undefined));
  const combined = combine(evals, w.options.match, false);
  return {
    content: content.slice(0, 20_000), lines: content.split("\n").length, chars: content.length, value, inStock: inStock ?? null, note,
    results: conditions.map((c, i) => ({ type: c.type, met: evals[i]!.met, reason: evals[i]!.reason })), met: combined.met,
  };
});
