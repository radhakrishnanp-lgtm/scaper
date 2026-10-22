import { z } from "zod";
import { handler } from "@/server/api";
import { aiCallStats, deleteAiCalls, listAiCalls } from "@/server/repo/ai";
import { audit } from "@/server/repo/events";

export const dynamic = "force-dynamic";

const query = z.object({
  purpose: z.string().max(40).optional(), status: z.enum(["ok", "error", "cached"]).optional(), model: z.string().max(200).optional(),
  refId: z.string().max(60).optional(), q: z.string().max(200).optional(), before: z.string().max(40).optional(),
  limit: z.coerce.number().int().optional(), stats: z.coerce.number().int().min(1).max(365).optional(),
});

/** The AI log: every model call with tokens, cost, latency and (optionally) the full prompt and reply. */
export const GET = handler(async (req) => {
  const p = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const page = listAiCalls(p);
  return p.stats ? { ...page, stats: aiCallStats(p.stats) } : page;
});

export const DELETE = handler(async (req) => {
  const days = req.nextUrl.searchParams.get("olderThanDays");
  const removed = deleteAiCalls(days ? Math.max(0, Number(days)) : undefined);
  audit("ai.log_cleared", { removed });
  return { removed };
});
