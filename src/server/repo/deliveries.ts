import "server-only";
import { db } from "../db";
import { newId, now, pageSize, parseJson } from "./util";

export type DeliveryStatus = "pending" | "ok" | "retrying" | "failed";
type Row = {
  id: string; kind: "webhook" | "sheets"; target: string; target_name: string; event: string; url: string; payload: string; status: DeliveryStatus;
  attempts: number; response_code: number | null; response_body: string | null; error: string | null; latency_ms: number | null;
  next_attempt_at: string | null; ref_id: string | null; created_at: string; updated_at: string;
};
export type Delivery = Omit<Row, "payload"> & { payload: unknown };
const toDelivery = (r: Row): Delivery => ({ ...r, payload: parseJson<unknown>(r.payload, null) });

const MAX_PAYLOAD = 64_000;

export function addDelivery(input: { kind: Row["kind"]; target: string; targetName: string; event: string; url: string; payload: unknown; refId?: string | null }) {
  const id = newId();
  const t = now();
  let body = JSON.stringify(input.payload);
  if (body.length > MAX_PAYLOAD) body = JSON.stringify({ truncated: true, preview: body.slice(0, MAX_PAYLOAD) });
  db().prepare(`INSERT INTO deliveries (id, kind, target, target_name, event, url, payload, status, attempts, ref_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`).run(id, input.kind, input.target, input.targetName, input.event, input.url, body, input.refId ?? null, t, t);
  return id;
}

export function recordAttempt(id: string, r: { status: DeliveryStatus; code?: number | null; body?: string | null; error?: string | null; ms?: number | null; nextAt?: string | null }) {
  db().prepare(`UPDATE deliveries SET status = ?, attempts = attempts + 1, response_code = ?, response_body = ?, error = ?, latency_ms = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .run(r.status, r.code ?? null, r.body?.slice(0, 4000) ?? null, r.error?.slice(0, 1000) ?? null, r.ms ?? null, r.nextAt ?? null, now(), id);
}

export function getDelivery(id: string): Delivery | null {
  const r = db().prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
  return r ? toDelivery(r) : null;
}

export function listDeliveries(opts: { kind?: string; status?: string; target?: string; before?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.target) { where.push("target = ?"); args.push(opts.target); }
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  const limit = pageSize(opts.limit, 200, 50);
  const rows = db().prepare(`SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, limit + 1) as Row[];
  const items = rows.slice(0, limit).map(toDelivery);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function deliveryStats(sinceIso: string) {
  const rows = db().prepare("SELECT kind, status, COUNT(*) c, AVG(latency_ms) ms FROM deliveries WHERE created_at >= ? GROUP BY kind, status").all(sinceIso) as { kind: string; status: DeliveryStatus; c: number; ms: number | null }[];
  return rows;
}

export function dueDeliveries(limit = 10): Delivery[] {
  return (db().prepare("SELECT * FROM deliveries WHERE status = 'retrying' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?").all(now(), limit) as Row[]).map(toDelivery);
}

/** Puts failed deliveries back in the retry queue (all, or since a time). */
export function requeueFailed(sinceIso?: string) {
  return db().prepare(`UPDATE deliveries SET status = 'retrying', next_attempt_at = ?, updated_at = ? WHERE status = 'failed' AND kind = 'webhook' ${sinceIso ? "AND created_at >= ?" : ""}`)
    .run(now(), now(), ...(sinceIso ? [sinceIso] : [])).changes;
}

export function pruneDeliveries(days: number) {
  return db().prepare("DELETE FROM deliveries WHERE created_at < ?").run(new Date(Date.now() - days * 86400_000).toISOString()).changes;
}
