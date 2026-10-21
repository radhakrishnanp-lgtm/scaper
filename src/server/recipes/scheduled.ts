import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { toCsv } from "@/lib/csv";
import { env } from "../env";
import { deliver } from "../notify";
import { audit } from "../repo/events";
import { recordRecipeRun, type Recipe } from "../repo/scrapes";
import { runScrape } from "../scrape";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "recipe";

/**
 * Runs a scheduled recipe and writes its main dataset to
 * data/exports/<recipe>/<timestamp>.csv, so each run builds a local archive.
 */
export async function runScheduledRecipe(r: Recipe) {
  const run = await runScrape({ url: r.url, mode: r.mode, extract: r.extract, recipeId: r.id });
  recordRecipeRun(r.id, run.status);
  if (run.status !== "ok" || !run.result) {
    await deliver({ kind: "system", title: `Scheduled scrape failed: ${r.name}`, body: run.error ?? "Unknown error", url: r.url }, { desktop: false, webhook: false, telegram: false });
    return { run, file: null };
  }
  const main = run.result.datasets.find((d) => !["Links", "Images", "Headings"].includes(d.name)) ?? run.result.datasets[0];
  let file: string | null = null;
  if (main?.rows.length) {
    const dir = path.join(env.dataDir, "exports", slug(r.name));
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    await fs.writeFile(file, "﻿" + toCsv(main.columns, main.rows), "utf8");
  }
  audit("recipe.scheduled_run", { recipeId: r.id, rows: run.row_count, saved: Boolean(file) });
  return { run, file };
}
