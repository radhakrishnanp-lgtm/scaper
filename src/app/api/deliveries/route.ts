import { handler } from "@/server/api";
import { deliveryStats, listDeliveries } from "@/server/repo/deliveries";

export const dynamic = "force-dynamic";

/** Every webhook and Google Sheets delivery: request, response, attempts and the next retry. */
export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const list = listDeliveries({
    kind: sp.get("kind") || undefined, status: sp.get("status") || undefined, target: sp.get("target") || undefined,
    before: sp.get("before") || undefined, limit: Number(sp.get("limit") ?? 50),
  });
  return { ...list, stats: deliveryStats(new Date(Date.now() - 7 * 86400_000).toISOString()) };
});
