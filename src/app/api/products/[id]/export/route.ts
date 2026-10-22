import { handler, idParam, notFound } from "@/server/api";
import { toCsv } from "@/lib/csv";
import { getProduct, priceHistory } from "@/server/repo/products";

/** Price history as CSV. */
export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const p = getProduct(id);
  if (!p) throw notFound("Product");
  const rows = priceHistory(id, 3650).map((h) => ({ time: h.created_at, price: h.price, list_price: h.list_price, in_stock: h.in_stock === null ? null : h.in_stock ? "yes" : "no" }));
  const name = (p.title ?? new URL(p.url).hostname).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  return new Response("\uFEFF" + toCsv(["time", "price", "list_price", "in_stock"], rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="price-history-${name}.csv"` },
  });
});
