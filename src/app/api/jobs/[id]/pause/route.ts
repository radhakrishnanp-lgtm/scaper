import { handler, HttpError, idParam, notFound } from "@/server/api";
import { pauseJob } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { getJob } from "@/server/repo/jobs";

/** Pause a queued job, or a running task run after the page it is on. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!getJob(id)) throw notFound("Job");
  const r = pauseJob(id);
  if (!r.ok) throw new HttpError(409, "not_pausable", r.message);
  audit("job.paused", { jobId: id });
  return r;
});
