import { z } from "zod";
import { handler } from "@/server/api";
import { TIMELINE_TYPES, timeline } from "@/server/repo/history";

export const dynamic = "force-dynamic";

const query = z.object({
  types: z.string().max(200).optional().transform((v) => (v ? v.split(",").filter((t): t is (typeof TIMELINE_TYPES)[number] => (TIMELINE_TYPES as readonly string[]).includes(t)) : undefined)),
  q: z.string().max(200).optional(),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().optional(),
});

/** Everything Scaper did, newest first: scrapes, agent chats, watcher changes, price changes, alerts, AI calls. */
export const GET = handler(async (req) => timeline(query.parse(Object.fromEntries(req.nextUrl.searchParams))));
