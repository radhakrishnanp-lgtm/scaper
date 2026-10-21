import { z } from "zod";
import { handler, idParam, notFound, readJson } from "@/server/api";
import { withStats } from "@/server/deals/tracker";
import { audit } from "@/server/repo/events";
import { deleteProduct, getProduct, priceHistory, updateProductSettings } from "@/server/repo/products";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const p = getProduct(id);
  if (!p) throw notFound("Product");
  return { product: withStats(p), history: priceHistory(id, 365) };
});

const patchSchema = z.object({
  targetPrice: z.number().positive().nullable().optional(),
  intervalMinutes: z.number().int().min(15).max(10080).optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const p = updateProductSettings(id, await readJson(req, patchSchema));
  if (!p) throw notFound("Product");
  return { product: withStats(p) };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteProduct(id)) throw notFound("Product");
  audit("product.deleted", { productId: id });
  return { ok: true };
});
