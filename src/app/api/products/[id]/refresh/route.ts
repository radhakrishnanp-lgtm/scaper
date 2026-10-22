import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { withStats } from "@/server/deals/tracker";
import { enqueueAndWait } from "@/server/jobs";
import { getProduct } from "@/server/repo/products";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  rateLimit(`refresh:${id}`, 4, 2);
  const p = getProduct(id);
  if (!p) throw notFound("Product");
  const job = await enqueueAndWait({ kind: "product", refId: id, title: `Price: ${p.title?.slice(0, 80) ?? p.url}`, input: { productId: id }, unique: true }, 90_000);
  return { ok: job.status === "succeeded", error: job.error ?? undefined, job, product: withStats(getProduct(id)!) };
});
