import "server-only";
import { db } from "../db";
import { newId, now, pageSize } from "./util";

export type Notification = {
  id: string; kind: string; title: string; body: string; url: string | null;
  watcher_id: string | null; product_id: string | null; read_at: string | null; created_at: string;
};

export function addNotification(n: { kind: string; title: string; body: string; url?: string | null; watcherId?: string | null; productId?: string | null }) {
  const row: Notification = {
    id: newId(), kind: n.kind, title: n.title.slice(0, 200), body: n.body.slice(0, n.kind === "briefing" ? 12_000 : 2000), url: n.url ?? null,
    watcher_id: n.watcherId ?? null, product_id: n.productId ?? null, read_at: null, created_at: now(),
  };
  db().prepare(
    "INSERT INTO notifications (id, kind, title, body, url, watcher_id, product_id, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.kind, row.title, row.body, row.url, row.watcher_id, row.product_id, row.read_at, row.created_at);
  return row;
}

export function listNotifications(opts: { limit?: number; before?: string; unreadOnly?: boolean; kind?: string; q?: string } = {}) {
  const limit = pageSize(opts.limit, 100, 30);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  if (opts.q) { where.push("(title LIKE ? OR body LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  if (opts.unreadOnly) where.push("read_at IS NULL");
  const rows = db().prepare(
    `SELECT * FROM notifications ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, limit + 1) as Notification[];
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function unreadCount() {
  return (db().prepare("SELECT COUNT(*) c FROM notifications WHERE read_at IS NULL").get() as { c: number }).c;
}

export function markRead(ids: string[] | "all") {
  if (ids === "all") return db().prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(now()).changes;
  const stmt = db().prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL");
  return db().transaction(() => ids.reduce((n, id) => n + stmt.run(now(), id).changes, 0))();
}

export function deleteNotifications(ids: string[] | "read") {
  if (ids === "read") return db().prepare("DELETE FROM notifications WHERE read_at IS NOT NULL").run().changes;
  const stmt = db().prepare("DELETE FROM notifications WHERE id = ?");
  return db().transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

/** Alerts per day and kind, for the dashboard. */
export function notificationsPerDay(days = 14) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare("SELECT substr(created_at, 1, 10) day, kind, COUNT(*) c FROM notifications WHERE created_at >= ? GROUP BY day, kind ORDER BY day").all(since) as { day: string; kind: string; c: number }[];
}

export function deleteNotification(id: string) {
  return db().prepare("DELETE FROM notifications WHERE id = ?").run(id).changes > 0;
}

export function pruneNotifications(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare("DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL").run(cutoff).changes;
}
