import "server-only";
import { db } from "../db";
import { clearEphemeral } from "./ephemeral";
import { pageSize } from "./util";

/**
 * One timeline across everything Scaper did: scrapes and task runs, agent conversations, watcher changes,
 * price changes, alerts and (optionally) AI calls. Each source is read with the same cursor and merged.
 */

export const TIMELINE_TYPES = ["scrape", "agent", "change", "price", "alert", "ai"] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];
export type TimelineItem = { type: TimelineType; id: string; at: string; title: string; subtitle: string; status: string | null; href: string; amount?: number | null };

export function timeline(opts: { types?: TimelineType[]; q?: string; before?: string; limit?: number }) {
  const types = new Set(opts.types?.length ? opts.types : TIMELINE_TYPES.filter((t) => t !== "ai"));
  const limit = pageSize(opts.limit, 200, 60);
  const before = opts.before ?? "9999";
  const like = opts.q ? `%${opts.q}%` : null;
  const d = db();
  const items: TimelineItem[] = [];

  if (types.has("scrape")) {
    const rows = d.prepare(
      `SELECT r.id, r.url, r.status, r.row_count, r.page_count, r.created_at, t.name AS task FROM scrape_runs r LEFT JOIN recipes t ON t.id = r.recipe_id
       WHERE r.created_at < ? ${like ? "AND (r.url LIKE ? OR t.name LIKE ?)" : ""} ORDER BY r.created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; url: string; status: string; row_count: number; page_count: number; created_at: string; task: string | null }[];
    for (const r of rows) items.push({ type: "scrape", id: r.id, at: r.created_at, title: r.task ?? r.url, subtitle: `${r.row_count} row${r.row_count === 1 ? "" : "s"} from ${r.page_count} page${r.page_count === 1 ? "" : "s"}`, status: r.status, href: `/history/${r.id}` });
  }
  if (types.has("agent")) {
    const rows = d.prepare(
      `SELECT id, prompt, status, answer, created_at, cost FROM agent_runs WHERE created_at < ? ${like ? "AND (prompt LIKE ? OR answer LIKE ?)" : ""} ORDER BY created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; prompt: string; status: string; answer: string | null; created_at: string; cost: number }[];
    for (const r of rows) items.push({ type: "agent", id: r.id, at: r.created_at, title: r.prompt.slice(0, 140), subtitle: (r.answer ?? "").replace(/\s+/g, " ").slice(0, 140), status: r.status, href: `/agent?run=${r.id}`, amount: r.cost || null });
  }
  if (types.has("change")) {
    const rows = d.prepare(
      `SELECT s.id, s.watcher_id, s.triggered, s.created_at, w.name, w.url FROM snapshots s JOIN watchers w ON w.id = s.watcher_id
       WHERE s.changed = 1 AND s.created_at < ? ${like ? "AND (w.name LIKE ? OR w.url LIKE ?)" : ""} ORDER BY s.created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; watcher_id: string; triggered: number; created_at: string; name: string; url: string }[];
    for (const r of rows) items.push({ type: "change", id: r.id, at: r.created_at, title: r.name, subtitle: r.triggered ? "Changed and matched your rule" : "Changed", status: r.triggered ? "triggered" : "changed", href: `/watchers/${r.watcher_id}?tab=history` });
  }
  if (types.has("price")) {
    const rows = d.prepare(
      `SELECT x.id, x.product_id, x.price, x.prev, x.created_at, p.title, p.url, p.currency FROM (
         SELECT id, product_id, price, created_at, LAG(price) OVER (PARTITION BY product_id ORDER BY created_at) AS prev FROM price_points
       ) x JOIN products p ON p.id = x.product_id
       WHERE x.prev IS NOT NULL AND x.prev != x.price AND x.created_at < ? ${like ? "AND (p.title LIKE ? OR p.url LIKE ?)" : ""} ORDER BY x.created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; product_id: string; price: number; prev: number; created_at: string; title: string | null; url: string; currency: string | null }[];
    for (const r of rows) {
      const pct = Math.round(((r.price - r.prev) / r.prev) * 1000) / 10;
      items.push({ type: "price", id: r.id, at: r.created_at, title: r.title ?? r.url, subtitle: `${r.prev.toLocaleString("en-IN")} → ${r.price.toLocaleString("en-IN")}${r.currency ? ` ${r.currency}` : ""} (${pct > 0 ? "+" : ""}${pct}%)`, status: r.price < r.prev ? "down" : "up", href: `/deals/${r.product_id}`, amount: r.price });
    }
  }
  if (types.has("alert")) {
    const rows = d.prepare(
      `SELECT id, kind, title, body, created_at, read_at FROM notifications WHERE created_at < ? ${like ? "AND (title LIKE ? OR body LIKE ?)" : ""} ORDER BY created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; kind: string; title: string; body: string; created_at: string; read_at: string | null }[];
    for (const r of rows) items.push({ type: "alert", id: r.id, at: r.created_at, title: r.title, subtitle: r.body.replace(/\s+/g, " ").slice(0, 140), status: r.read_at ? "read" : "unread", href: `/notifications` });
  }
  if (types.has("ai")) {
    const rows = d.prepare(
      `SELECT id, purpose, model, provider_name, status, tokens_in, tokens_out, cost, created_at FROM ai_calls WHERE created_at < ? ${like ? "AND (model LIKE ? OR purpose LIKE ?)" : ""} ORDER BY created_at DESC LIMIT ?`,
    ).all(...[before, ...(like ? [like, like] : []), limit]) as { id: string; purpose: string; model: string; provider_name: string | null; status: string; tokens_in: number; tokens_out: number; cost: number; created_at: string }[];
    for (const r of rows) items.push({ type: "ai", id: r.id, at: r.created_at, title: `${r.purpose} · ${r.model}`, subtitle: `${(r.tokens_in + r.tokens_out).toLocaleString("en-IN")} tokens${r.provider_name ? ` via ${r.provider_name}` : ""}`, status: r.status, href: `/ai-log?call=${r.id}`, amount: r.cost || null });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? page[page.length - 1]!.at : null };
}

export const WIPE_SCOPES = ["scrapes", "agent", "ai_log", "ai_cache", "jobs", "alerts", "changes", "prices", "logs", "site_stats", "memory", "private"] as const;
export type WipeScope = (typeof WIPE_SCOPES)[number];

/**
 * Deletes history. With `olderThanDays` only older entries go. Saved tasks, watchers and products stay
 * (their history goes with "changes" and "prices"). The database overwrites deleted rows and is compacted afterwards.
 */
export function wipeHistory(scopes: WipeScope[], olderThanDays?: number) {
  const cutoff = olderThanDays ? new Date(Date.now() - olderThanDays * 86400_000).toISOString() : "9999";
  const d = db();
  const out: Partial<Record<WipeScope | "private", number>> = {};
  const run = (scope: WipeScope, sql: string, ...args: unknown[]) => { out[scope] = (out[scope] ?? 0) + d.prepare(sql).run(...args).changes; };
  d.transaction(() => {
    for (const s of new Set(scopes)) {
      switch (s) {
        case "scrapes": run(s, "DELETE FROM scrape_runs WHERE created_at < ?", cutoff); break;
        case "agent": run(s, "DELETE FROM agent_runs WHERE created_at < ? AND status != 'running'", cutoff); break;
        case "ai_log": run(s, "DELETE FROM ai_calls WHERE created_at < ?", cutoff); break;
        case "ai_cache": run(s, "DELETE FROM ai_cache WHERE created_at < ?", cutoff); break;
        case "jobs": run(s, "DELETE FROM jobs WHERE created_at < ? AND status NOT IN ('queued','running')", cutoff); break;
        case "alerts": run(s, "DELETE FROM notifications WHERE created_at < ?", cutoff); break;
        // Keeps each watcher's latest snapshot so the next check still has something to compare with.
        case "changes": run(s, "DELETE FROM snapshots WHERE created_at < ? AND id NOT IN (SELECT id FROM snapshots s2 WHERE s2.created_at = (SELECT MAX(created_at) FROM snapshots s3 WHERE s3.watcher_id = s2.watcher_id))", cutoff); break;
        case "prices": run(s, "DELETE FROM price_points WHERE created_at < ? AND id NOT IN (SELECT id FROM price_points p2 WHERE p2.created_at = (SELECT MAX(created_at) FROM price_points p3 WHERE p3.product_id = p2.product_id))", cutoff); break;
        case "logs": run(s, "DELETE FROM event_log WHERE created_at < ?", cutoff); break;
        case "site_stats": run(s, "DELETE FROM host_stats WHERE day < ?", cutoff.slice(0, 10)); break;
        case "memory": run(s, "DELETE FROM ai_memory WHERE created_at < ?", cutoff); break;
        case "private": break;
      }
    }
  })();
  if (scopes.includes("private")) out.private = clearEphemeral();
  d.exec("VACUUM");
  try { d.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* another reader is busy; the next checkpoint catches up */ }
  return out;
}
