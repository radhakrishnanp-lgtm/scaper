import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { listNotifications, markRead, unreadCount } from "@/server/repo/notifications";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const page = listNotifications({ limit: Number(sp.get("limit") ?? 30), before: sp.get("before") ?? undefined, unreadOnly: sp.get("unread") === "1" });
  return { ...page, unread: unreadCount() };
});

const actionSchema = z.object({ action: z.literal("read"), ids: z.union([z.literal("all"), z.array(z.string().uuid()).max(500)]) });

export const POST = handler(async (req) => {
  const { ids } = await readJson(req, actionSchema);
  return { updated: markRead(ids), unread: unreadCount() };
});
