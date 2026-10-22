import { handler, HttpError, idParam, notFound } from "@/server/api";
import { cancelJob } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { getJob } from "@/server/repo/jobs";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const job = getJob(id);
  if (!job) throw notFound("Job");
  if (!cancelJob(id)) throw new HttpError(409, "not_running", "This job has already finished.");
  audit("job.cancelled", { jobId: id });
  return { ok: true };
});
