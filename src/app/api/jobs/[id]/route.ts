import { handler, idParam, notFound } from "@/server/api";
import { getJob, jobLogs } from "@/server/repo/jobs";

export const dynamic = "force-dynamic";

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const job = getJob(id);
  if (!job) throw notFound("Job");
  const after = Number(req.nextUrl.searchParams.get("after") ?? 0) || 0;
  return { job, logs: jobLogs(id, after) };
});
