import "server-only";
import { db } from "../db";
import { log } from "../log";
import { now, pageSize, parseJson } from "./util";

/** Audit log for actions that change data or reach the outside world. Kept 30 days. */
export function audit(event: string, data: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  log[level](event, data);
  db().prepare("INSERT INTO event_log (level, event, data, created_at) VALUES (?, ?, ?, ?)").run(level, event, JSON.stringify(data), now());
}

export function listEvents(limit?: number, beforeId?: number) {
  const rows = db()
    .prepare(`SELECT * FROM event_log ${beforeId ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(beforeId ? [beforeId, pageSize(limit)] : [pageSize(limit)])) as {
    id: number; level: string; event: string; data: string; created_at: string;
  }[];
  return rows.map((r) => ({ ...r, data: parseJson<Record<string, unknown>>(r.data, {}) }));
}

export function pruneEvents(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare("DELETE FROM event_log WHERE created_at < ?").run(cutoff).changes;
}
