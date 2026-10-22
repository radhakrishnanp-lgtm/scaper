import { handler, HttpError } from "@/server/api";
import { previewCron } from "@/server/watch/schedule";

/** The next five times a cron expression would run, shown under the schedule field. */
export const GET = handler(async (req) => {
  const cron = (req.nextUrl.searchParams.get("cron") ?? "").trim();
  if (!cron) throw new HttpError(400, "validation", "Enter a cron expression.");
  try {
    return { runs: previewCron(cron, 5) };
  } catch (e) {
    throw new HttpError(400, "validation", `Invalid cron schedule: ${(e as Error).message}`);
  }
});
