import { handler, idParam, notFound } from "@/server/api";
import { deleteMemory } from "@/server/repo/ai";

export const DELETE = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  if (!deleteMemory(idParam.parse((await params).id))) throw notFound("Note");
  return { ok: true };
});
