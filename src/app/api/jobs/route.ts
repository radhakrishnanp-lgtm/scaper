import { handler } from "@/server/api";
import { clearFinishedJobs, jobCounts, jobsPerDay, listJobs } from "@/server/repo/jobs";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const page = listJobs({
    status: sp.get("status") ?? undefined, kind: sp.get("kind") ?? undefined, refId: sp.get("refId") ?? undefined,
    q: sp.get("q") ?? undefined, limit: Number(sp.get("limit") ?? 50), before: sp.get("before") ?? undefined,
  });
  return { ...page, counts: jobCounts(), perDay: sp.get("chart") ? jobsPerDay(14) : undefined };
});

/** Removes finished jobs (and their logs) from the Runs page. */
export const DELETE = handler(async () => ({ removed: clearFinishedJobs() }));
