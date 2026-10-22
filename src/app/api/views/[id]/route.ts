import { handler, idParam, notFound } from "@/server/api";
import { deleteView } from "@/server/repo/views";

export const DELETE = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  if (!deleteView(idParam.parse((await params).id))) throw notFound("View");
  return { ok: true };
});
