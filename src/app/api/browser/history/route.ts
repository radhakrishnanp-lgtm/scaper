import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { deleteHistory, listHistory } from "@/server/repo/browser";
import { audit } from "@/server/repo/events";

/** Pages you visited in the normal profile, newest first: `?q=&before=<id>&limit=`. */
export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const items = listHistory({ q: sp.get("q") ?? undefined, before: Number(sp.get("before")) || undefined, limit: Number(sp.get("limit")) || 100 });
  return { items, next: items.length >= (Number(sp.get("limit")) || 100) ? items.at(-1)!.id : null };
});

const delSchema = z.object({ id: z.number().int().positive().optional(), olderThanDays: z.number().int().min(1).optional(), all: z.boolean().optional() });

/** Forget one visit `{id}`, everything older than N days `{olderThanDays}`, or all of it `{all: true}`. */
export const DELETE = handler(async (req) => {
  const body = await readJson(req, delSchema);
  const removed = deleteHistory(body);
  audit("browser.history_cleared", { removed, ...body });
  return { removed };
});
