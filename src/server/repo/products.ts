import "server-only";
import { db } from "../db";
import { productAlertsSchema, type ProductAlerts } from "@/lib/schemas";
import { newId, now, parseJson } from "./util";

type ProductRow = {
  id: string; url: string; source: string; external_id: string | null; title: string | null; image: string | null;
  currency: string | null; current_price: number | null; list_price: number | null; rating: number | null;
  review_count: number | null; in_stock: number | null; target_price: number | null; interval_minutes: number;
  enabled: number; last_checked_at: string | null; next_check_at: string | null; last_error: string | null;
  tags: string; alerts: string; notes: string; group_name: string;
  created_at: string; updated_at: string;
};
export type Product = Omit<ProductRow, "enabled" | "in_stock" | "tags" | "alerts"> & {
  enabled: boolean; in_stock: boolean | null; tags: string[]; alerts: ProductAlerts;
};
export type PricePoint = { price: number; list_price: number | null; in_stock: number | null; created_at: string };

const toProduct = (r: ProductRow): Product => {
  const alerts = productAlertsSchema.safeParse(parseJson(r.alerts, {}));
  return {
    ...r, enabled: Boolean(r.enabled), in_stock: r.in_stock === null ? null : Boolean(r.in_stock),
    tags: parseJson<string[]>(r.tags, []), alerts: alerts.success ? alerts.data : productAlertsSchema.parse({}),
  };
};

export function listProducts(filter: { q?: string; tag?: string; group?: string } = {}): Product[] {
  let rows = (db().prepare("SELECT * FROM products ORDER BY created_at DESC LIMIT 2000").all() as ProductRow[]).map(toProduct);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((p) => (p.title ?? "").toLowerCase().includes(q) || p.url.toLowerCase().includes(q));
  }
  if (filter.tag) rows = rows.filter((p) => p.tags.includes(filter.tag!));
  if (filter.group) rows = rows.filter((p) => p.group_name === filter.group);
  return rows;
}

export function allProductTags(): string[] {
  const rows = db().prepare("SELECT tags FROM products").all() as { tags: string }[];
  return [...new Set(rows.flatMap((r) => parseJson<string[]>(r.tags, [])))].sort();
}

export function getProduct(id: string): Product | null {
  const r = db().prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
  return r ? toProduct(r) : null;
}

export function getProductByUrl(url: string): Product | null {
  const r = db().prepare("SELECT * FROM products WHERE url = ?").get(url) as ProductRow | undefined;
  return r ? toProduct(r) : null;
}

export function createProduct(input: {
  url: string; source: string; externalId: string | null; targetPrice: number | null; intervalMinutes: number; tags?: string[]; alerts?: ProductAlerts;
}) {
  const id = newId();
  const t = now();
  db().prepare(
    `INSERT INTO products (id, url, source, external_id, target_price, interval_minutes, tags, alerts, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.url, input.source, input.externalId, input.targetPrice, input.intervalMinutes, JSON.stringify(input.tags ?? []),
    JSON.stringify(input.alerts ?? productAlertsSchema.parse({})), t, t, t);
  return getProduct(id)!;
}

export function updateProductSettings(id: string, input: {
  targetPrice?: number | null; intervalMinutes?: number; enabled?: boolean; tags?: string[]; alerts?: ProductAlerts; notes?: string; groupName?: string;
}) {
  const p = getProduct(id);
  if (!p) return null;
  db().prepare("UPDATE products SET target_price = ?, interval_minutes = ?, enabled = ?, tags = ?, alerts = ?, notes = ?, group_name = ?, updated_at = ? WHERE id = ?").run(
    input.targetPrice === undefined ? p.target_price : input.targetPrice,
    input.intervalMinutes ?? p.interval_minutes,
    (input.enabled ?? p.enabled) ? 1 : 0,
    JSON.stringify(input.tags ?? p.tags),
    JSON.stringify(input.alerts ?? p.alerts),
    input.notes ?? p.notes,
    input.groupName ?? p.group_name,
    now(), id,
  );
  return getProduct(id);
}

export function recordProductCheck(id: string, data: {
  title?: string | null; image?: string | null; currency?: string | null; price?: number | null; listPrice?: number | null;
  rating?: number | null; reviewCount?: number | null; inStock?: boolean | null; error?: string | null; nextCheckAt: string;
}) {
  const t = now();
  db().transaction(() => {
    db().prepare(
      `UPDATE products SET title = COALESCE(?, title), image = COALESCE(?, image), currency = COALESCE(?, currency),
         current_price = COALESCE(?, current_price), list_price = COALESCE(?, list_price), rating = COALESCE(?, rating),
         review_count = COALESCE(?, review_count), in_stock = COALESCE(?, in_stock), last_error = ?,
         last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
    ).run(data.title ?? null, data.image ?? null, data.currency ?? null, data.price ?? null, data.listPrice ?? null,
      data.rating ?? null, data.reviewCount ?? null, data.inStock === undefined || data.inStock === null ? null : data.inStock ? 1 : 0,
      data.error ?? null, t, data.nextCheckAt, t, id);
    if (data.price !== null && data.price !== undefined) {
      db().prepare("INSERT INTO price_points (id, product_id, price, list_price, in_stock, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(newId(), id, data.price, data.listPrice ?? null, data.inStock === null || data.inStock === undefined ? null : data.inStock ? 1 : 0, t);
    }
  })();
}

export function priceHistory(productId: string, sinceDays = 365): PricePoint[] {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  return db().prepare(
    "SELECT price, list_price, in_stock, created_at FROM price_points WHERE product_id = ? AND created_at >= ? ORDER BY created_at LIMIT 20000",
  ).all(productId, since) as PricePoint[];
}

export function claimDueProducts(limit: number): Product[] {
  if (limit <= 0) return [];
  const t = now();
  return db().transaction(() => {
    const rows = db().prepare(
      "SELECT * FROM products WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ?",
    ).all(t, limit) as ProductRow[];
    const lease = new Date(Date.now() + 10 * 60_000).toISOString();
    const stmt = db().prepare("UPDATE products SET next_check_at = ? WHERE id = ?");
    for (const r of rows) stmt.run(lease, r.id);
    return rows.map(toProduct);
  })();
}

export function deleteProduct(id: string) {
  return db().prepare("DELETE FROM products WHERE id = ?").run(id).changes > 0;
}
