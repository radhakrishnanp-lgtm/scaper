import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { changeCounts, listChanges, triageChanges } from "@/server/repo/watchers";

export const dynamic = "force-dynamic";

/** The change inbox across all watchers, with triage filters. */
export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const list = listChanges({
    status: status === "unreviewed" || status === "important" || status === "not_useful" ? status : "all",
    watcherId: sp.get("watcher") || undefined, tag: sp.get("tag") || undefined, q: sp.get("q") || undefined,
    before: sp.get("before") || undefined, limit: Number(sp.get("limit") ?? 40),
  });
  return { ...list, counts: changeCounts() };
});

const triage = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  reviewed: z.boolean().optional(),
  important: z.boolean().nullable().optional(),
  feedback: z.enum(["useful", "not_useful"]).nullable().optional(),
});

/** Mark changes reviewed, important or not, and record "useful" / "not useful" feedback (the AI learns from it). */
export const POST = handler(async (req) => {
  const b = await readJson(req, triage);
  const updated = triageChanges(b.ids, { reviewed: b.reviewed, important: b.important, feedback: b.feedback });
  if (b.feedback) audit("change.feedback", { count: b.ids.length, feedback: b.feedback });
  return { updated, counts: changeCounts() };
});
