import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { deleteNotifications, listNotifications, markRead, unreadCount } from "@/server/repo/notifications";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const page = listNotifications({
    limit: Number(sp.get("limit") ?? 30), before: sp.get("before") ?? undefined, unreadOnly: sp.get("unread") === "1",
    kind: sp.get("kind") ?? undefined, q: sp.get("q") ?? undefined,
  });
  return { ...page, unread: unreadCount() };
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), ids: z.union([z.literal("all"), z.array(z.string().uuid()).max(500)]) }),
  z.object({ action: z.literal("delete"), ids: z.union([z.literal("read"), z.array(z.string().uuid()).max(500)]) }),
]);

export const POST = handler(async (req) => {
  const body = await readJson(req, actionSchema);
  if (body.action === "delete") return { deleted: deleteNotifications(body.ids), unread: unreadCount() };
  return { updated: markRead(body.ids), unread: unreadCount() };
});
