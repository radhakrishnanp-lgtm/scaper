import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { redeliver } from "@/server/integrations/webhooks";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  rateLimit("redeliver", 30, 10);
  const out = await redeliver(idParam.parse((await params).id));
  if (!out) throw notFound("Delivery");
  return out;
});
