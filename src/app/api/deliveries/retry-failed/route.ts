import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { processDueDeliveries } from "@/server/integrations/webhooks";
import { requeueFailed } from "@/server/repo/deliveries";

/** "Retry all failed": puts failed webhook deliveries (optionally since a time) back in the queue and sends them now. */
export const POST = handler(async (req) => {
  const { since } = await readJson(req, z.object({ since: z.string().datetime().optional() }).default({}));
  const queued = requeueFailed(since);
  const sent = await processDueDeliveries();
  return { queued, sent };
});
