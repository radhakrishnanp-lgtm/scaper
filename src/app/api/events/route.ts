import { handler } from "@/server/api";
import { listEvents } from "@/server/repo/events";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const before = Number(sp.get("before") ?? 0) || undefined;
  return { events: listEvents(Number(sp.get("limit") ?? 50), before, { level: sp.get("level") ?? undefined, q: sp.get("q") ?? undefined }) };
});
