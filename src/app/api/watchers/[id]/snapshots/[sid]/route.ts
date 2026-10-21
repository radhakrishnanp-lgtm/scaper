import { handler, idParam, notFound } from "@/server/api";
import { getSnapshot } from "@/server/repo/watchers";

export const GET = handler(async (_req, { params }: { params: Promise<{ id: string; sid: string }> }) => {
  const p = await params;
  const snapshot = getSnapshot(idParam.parse(p.id), idParam.parse(p.sid));
  if (!snapshot) throw notFound("Snapshot");
  return { snapshot };
});
