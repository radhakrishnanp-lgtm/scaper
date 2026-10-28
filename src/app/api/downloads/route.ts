import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { cancelDownloads, downloadsRoot, pauseDownloads, pumpDownloads, queueDownloads, resumeDownloads, runningDownloads } from "@/server/downloads/manager";
import { clearFinishedDownloads, downloadCounts, listDownloads } from "@/server/repo/downloads";
import { getSettings } from "@/server/repo/settings";
import { downloadInputSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  pumpDownloads();
  const d = getSettings().data;
  return {
    items: listDownloads({ status: sp.get("status") ?? undefined, q: sp.get("q") ?? undefined, limit: Number(sp.get("limit") ?? 200), refId: sp.get("ref") ?? undefined }),
    counts: downloadCounts(), running: runningDownloads(), folder: downloadsRoot(), concurrency: d.downloadConcurrency, maxMb: d.maxDownloadMb,
  };
});

/** Add links to the download queue: `{urls, folder}`. */
export const POST = handler(async (req) => {
  rateLimit("downloads:add", 30, 10);
  const body = await readJson(req, downloadInputSchema);
  return queueDownloads(body.urls, { folder: body.folder, source: "manual" });
});

const actionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]), ids: z.union([z.array(z.string().uuid()).min(1).max(2000), z.literal("all")]) });

/** Pause, resume or cancel some downloads, or all of them. */
export const PATCH = handler(async (req) => {
  const { action, ids } = await readJson(req, actionSchema);
  if (action === "pause") return { changed: pauseDownloads(ids) };
  if (action === "resume") return { changed: resumeDownloads(ids) };
  return { changed: await cancelDownloads(ids === "all" ? listDownloads({ status: "active", limit: 500 }).map((d) => d.id) : ids) };
});

/** Removes finished, failed and cancelled downloads from the list. The files stay on disk. */
export const DELETE = handler(async () => ({ removed: clearFinishedDownloads() }));
