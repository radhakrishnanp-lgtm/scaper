import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { pauseDownloads, resumeDownloads } from "@/server/downloads/manager";
import { pauseAllJobs, resumeAllJobs } from "@/server/jobs";
import { audit } from "@/server/repo/events";
import { listJobs } from "@/server/repo/jobs";

const schema = z.object({ action: z.enum(["pause", "resume"]), downloads: z.boolean().default(true) });

/** "Pause all" / "Resume all": every queued and running task run, and the download queue. */
export const POST = handler(async (req) => {
  const { action, downloads } = await readJson(req, schema);
  const jobs = action === "pause" ? pauseAllJobs(() => listJobs({ status: "active", limit: 100 }).items) : resumeAllJobs();
  const files = downloads ? (action === "pause" ? pauseDownloads("all") : resumeDownloads("all")) : 0;
  audit(action === "pause" ? "jobs.paused_all" : "jobs.resumed_all", { jobs, files });
  return { jobs, downloads: files };
});
