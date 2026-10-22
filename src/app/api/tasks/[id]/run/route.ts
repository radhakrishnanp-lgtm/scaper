import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { enqueue, enqueueAndWait } from "@/server/jobs";
import { getRecipe, getRun } from "@/server/repo/scrapes";

/**
 * Runs a task now. By default waits up to 90 s and returns the run;
 * with ?wait=0 (or when it takes longer) returns the job to follow on the Runs page.
 */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  rateLimit("scrape", 30, 10);
  const task = getRecipe(idParam.parse((await params).id));
  if (!task) throw notFound("Task");
  const input = { kind: "task" as const, refId: task.id, title: `Task: ${task.name}`, trigger: (req.headers.get("authorization") ? "api" : "manual") as "api" | "manual", input: { taskId: task.id }, unique: true, priority: 10 };
  if (req.nextUrl.searchParams.get("wait") === "0") return { job: enqueue(input) };
  const job = await enqueueAndWait(input, 90_000);
  const runId = job.result?.runId as string | undefined;
  return { job, run: runId ? getRun(runId) : null };
});
