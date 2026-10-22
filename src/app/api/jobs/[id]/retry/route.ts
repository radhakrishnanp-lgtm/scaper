import { handler, idParam, notFound } from "@/server/api";
import { enqueue } from "@/server/jobs";
import { getJob } from "@/server/repo/jobs";

/** Runs the same job again with the same input. */
export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const job = getJob(idParam.parse((await params).id));
  if (!job) throw notFound("Job");
  return { job: enqueue({ kind: job.kind, refId: job.ref_id, title: job.title, trigger: "retry", input: job.input, priority: 10, unique: Boolean(job.ref_id), private: job.private }) };
});
