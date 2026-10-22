import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { changeCounts, reviewAll } from "@/server/repo/watchers";

export const POST = handler(async (req) => {
  const { watcherId } = await readJson(req, z.object({ watcherId: z.string().uuid().optional() }).default({}));
  return { updated: reviewAll(watcherId), counts: changeCounts() };
});
