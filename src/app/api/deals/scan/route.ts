import { handler, rateLimit, readJson } from "@/server/api";
import { scanListing } from "@/server/deals/tracker";
import { dealScanSchema } from "@/lib/schemas";

export const POST = handler(async (req) => {
  rateLimit("deals:scan", 10, 3);
  return scanListing(await readJson(req, dealScanSchema));
});
