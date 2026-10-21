import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { refreshProduct } from "@/server/deals/tracker";
import { getProduct } from "@/server/repo/products";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  rateLimit(`refresh:${id}`, 4, 2);
  const p = getProduct(id);
  if (!p) throw notFound("Product");
  return refreshProduct(p);
});
