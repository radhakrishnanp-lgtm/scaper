import { handler, idParam, notFound, readJson } from "@/server/api";
import { withStats } from "@/server/deals/tracker";
import { audit } from "@/server/repo/events";
import { deleteProduct, getProduct, listProducts, priceHistory, updateProductSettings } from "@/server/repo/products";
import { productPatchSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const p = getProduct(id);
  if (!p) throw notFound("Product");
  // The same item at other stores (same group name), cheapest first.
  const siblings = p.group_name ? listProducts({ group: p.group_name }).filter((x) => x.id !== id).map(withStats).sort((a, b) => (a.current_price ?? Infinity) - (b.current_price ?? Infinity)) : [];
  return { product: withStats(p), history: priceHistory(id, 3650), siblings };
});

export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const p = updateProductSettings(id, await readJson(req, productPatchSchema));
  if (!p) throw notFound("Product");
  audit("product.updated", { productId: id });
  return { product: withStats(p) };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteProduct(id)) throw notFound("Product");
  audit("product.deleted", { productId: id });
  return { ok: true };
});
