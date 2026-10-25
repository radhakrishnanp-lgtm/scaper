import { handler, HttpError, idParam, notFound } from "@/server/api";
import { resumeJob } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { getJob } from "@/server/repo/jobs";

/** Resume a paused job; a task run carries on from where it stopped. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!getJob(id)) throw notFound("Job");
  const r = resumeJob(id);
  if (!r.ok) throw new HttpError(409, "not_paused", r.message);
  audit("job.resumed", { jobId: id });
  return r;
});
