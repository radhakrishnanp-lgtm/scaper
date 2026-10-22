import { handler, rateLimit, readJson } from "@/server/api";
import { trackProduct, withStats } from "@/server/deals/tracker";
import { enqueue } from "@/server/jobs";
import { allProductTags, listProducts } from "@/server/repo/products";
import { parseUrlList } from "@/server/tasks/urls";
import { productBulkSchema, productInputSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const products = listProducts({ q: sp.get("q") ?? undefined, tag: sp.get("tag") ?? undefined, group: sp.get("group") ?? undefined }).map(withStats);
  return { products, tags: allProductTags(), groups: [...new Set(products.map((p) => p.group_name).filter(Boolean))].sort() };
});

/** One product (checked right away), or {urls: [...]} to add many in the background. */
export const POST = handler(async (req) => {
  rateLimit("products:add", 20, 5);
  const body = (await req.clone().json().catch(() => ({}))) as { urls?: unknown };
  if (Array.isArray(body.urls)) {
    const input = await readJson(req, productBulkSchema);
    const urls = parseUrlList(input.urls).slice(0, 200);
    const job = enqueue({ kind: "bulk_products", title: `Track ${urls.length} product(s)`, input: { urls, intervalMinutes: input.intervalMinutes, tags: input.tags ?? [] } });
    return { job, count: urls.length };
  }
  return trackProduct(await readJson(req, productInputSchema));
});
