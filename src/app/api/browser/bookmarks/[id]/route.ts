import { handler, idParam, notFound } from "@/server/api";
import { deleteBookmark } from "@/server/repo/browser";

export const DELETE = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  if (!deleteBookmark(idParam.parse((await params).id))) throw notFound("Bookmark");
  return { ok: true };
});
