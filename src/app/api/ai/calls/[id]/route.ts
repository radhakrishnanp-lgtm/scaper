import { handler, idParam, notFound } from "@/server/api";
import { getAiCall } from "@/server/repo/ai";

export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const call = getAiCall(idParam.parse((await params).id));
  if (!call) throw notFound("AI call");
  return { call };
});
