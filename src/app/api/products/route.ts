import { handler, rateLimit, readJson } from "@/server/api";
import { trackProduct, withStats } from "@/server/deals/tracker";
import { listProducts } from "@/server/repo/products";
import { productInputSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ products: listProducts().map(withStats) }));

export const POST = handler(async (req) => {
  rateLimit("products:add", 20, 5);
  return trackProduct(await readJson(req, productInputSchema));
});
