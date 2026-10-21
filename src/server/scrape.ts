import "server-only";
import type { ExtractSpec, FetchMode } from "@/lib/schemas";
import type { ScrapeResult } from "@/lib/types";
import { aiExtract } from "./ai/extract";
import { autoExtract } from "./extract/auto";
import { load, readableText } from "./extract/dom";
import { extractWithSelectors } from "./extract/selectors";
import { fetchPage, FetchError } from "./fetcher";
import { audit } from "./repo/events";
import { saveRun, type ScrapeRun } from "./repo/scrapes";

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** Fetches a page, runs the chosen extraction, and stores the run in history. */
export async function runScrape(input: { url: string; mode: FetchMode; extract: ExtractSpec; screenshot?: boolean; recipeId?: string | null }): Promise<ScrapeRun> {
  const started = Date.now();
  try {
    const page = await fetchPage(input.url, input.mode, { screenshot: input.screenshot, scroll: input.mode === "browser" });
    const result: ScrapeResult = { title: page.title, finalUrl: page.finalUrl, datasets: [], meta: {}, notes: [...page.notes], screenshot: page.screenshot };
    if (input.extract.type === "auto") {
      const auto = autoExtract(page.html, page.finalUrl);
      result.datasets = auto.datasets;
      result.meta = auto.meta;
      result.suggestions = auto.suggestions;
    } else if (input.extract.type === "selectors") {
      const ds = extractWithSelectors(page.html, page.finalUrl, input.extract);
      result.datasets = [ds];
      if (!ds.rows.length) result.notes.push("No elements matched. Try Auto mode to see suggested selectors, or Browser mode if the page builds its content with JavaScript.");
    } else {
      const text = page.text?.trim() ? page.text : readableText(load(page.html));
      result.datasets = [await aiExtract(text, page.finalUrl, input.extract.instruction, input.extract.useFastModel ? "fast" : "main")];
    }
    // Count the main data, not page furniture like links and images.
    const main = result.datasets.filter((d) => !["Links", "Images", "Headings"].includes(d.name));
    const rowCount = Math.max(0, ...(main.length ? main : result.datasets).map((d) => d.rows.length));
    const run = saveRun({
      recipe_id: input.recipeId ?? null, url: input.url, final_url: page.finalUrl, mode: input.mode, status: "ok",
      extract: input.extract, result, row_count: rowCount, error: null, duration_ms: Date.now() - started,
    });
    audit("scrape.ok", { runId: run.id, host: new URL(input.url).hostname, rows: rowCount, type: input.extract.type });
    return run;
  } catch (e) {
    const blocked = e instanceof FetchError && (e.code === "blocked" || e.code === "robots");
    const run = saveRun({
      recipe_id: input.recipeId ?? null, url: input.url, final_url: null, mode: input.mode, status: blocked ? "blocked" : "error",
      extract: input.extract, result: null, row_count: 0, error: errorMessage(e), duration_ms: Date.now() - started,
    });
    audit("scrape.failed", { runId: run.id, host: new URL(input.url).hostname, code: (e as FetchError).code ?? "error" }, "warn");
    return run;
  }
}
