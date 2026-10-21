import { handler } from "@/server/api";
import { listEvents } from "@/server/repo/events";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const before = Number(req.nextUrl.searchParams.get("before") ?? 0) || undefined;
  return { events: listEvents(50, before) };
});
