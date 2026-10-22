import "server-only";
import { db } from "../db";
import { newId, now, pageSize } from "./util";

export type AiCallStatus = "ok" | "error" | "cached";

export type AiCall = {
  id: string; created_at: string; purpose: string; ref_id: string | null;
  provider_id: string | null; provider_name: string | null; model: string; status: AiCallStatus;
  tokens_in: number; tokens_out: number; cost: number; latency_ms: number; attempts: number;
  fallback_from: string | null; error: string | null; request: string | null; response: string | null;
};
export type AiCallSummary = Omit<AiCall, "request" | "response"> & { has_request: boolean };

const MAX_REQUEST_CHARS = 120_000;
const MAX_RESPONSE_CHARS = 40_000;

export function recordAiCall(c: Omit<AiCall, "id" | "created_at">) {
  const id = newId();
  db().prepare(
    `INSERT INTO ai_calls (id, created_at, purpose, ref_id, provider_id, provider_name, model, status, tokens_in, tokens_out, cost, latency_ms, attempts, fallback_from, error, request, response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, now(), c.purpose, c.ref_id, c.provider_id, c.provider_name, c.model, c.status, c.tokens_in, c.tokens_out, c.cost, c.latency_ms, c.attempts,
    c.fallback_from, c.error?.slice(0, 2000) ?? null, c.request?.slice(0, MAX_REQUEST_CHARS) ?? null, c.response?.slice(0, MAX_RESPONSE_CHARS) ?? null,
  );
  return id;
}

export type AiCallFilter = { purpose?: string; status?: string; model?: string; refId?: string; q?: string; before?: string; limit?: number };

export function listAiCalls(f: AiCallFilter = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.purpose) { where.push("purpose = ?"); args.push(f.purpose); }
  if (f.status) { where.push("status = ?"); args.push(f.status); }
  if (f.model) { where.push("model = ?"); args.push(f.model); }
  if (f.refId) { where.push("ref_id = ?"); args.push(f.refId); }
  if (f.q) { where.push("(model LIKE ? OR provider_name LIKE ? OR error LIKE ? OR request LIKE ?)"); args.push(...Array(4).fill(`%${f.q}%`)); }
  if (f.before) { where.push("created_at < ?"); args.push(f.before); }
  const limit = pageSize(f.limit, 200, 50);
  const rows = db().prepare(
    `SELECT id, created_at, purpose, ref_id, provider_id, provider_name, model, status, tokens_in, tokens_out, cost, latency_ms, attempts, fallback_from, error,
       request IS NOT NULL AS has_request
     FROM ai_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, limit + 1) as (Omit<AiCallSummary, "has_request"> & { has_request: number })[];
  const items: AiCallSummary[] = rows.slice(0, limit).map((r) => ({ ...r, has_request: Boolean(r.has_request) }));
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.created_at : null };
}

export function getAiCall(id: string): AiCall | null {
  return (db().prepare("SELECT * FROM ai_calls WHERE id = ?").get(id) as AiCall | undefined) ?? null;
}

/** Totals for the AI log header: today, this month, by model and by purpose over `days`. */
export function aiCallStats(days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const d = db();
  const totals = d.prepare(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost), 0) AS cost,
       COALESCE(SUM(status = 'error'), 0) AS errors, COALESCE(SUM(status = 'cached'), 0) AS cached, COALESCE(AVG(CASE WHEN status = 'ok' THEN latency_ms END), 0) AS avg_ms,
       COALESCE(SUM(fallback_from IS NOT NULL), 0) AS fallbacks
     FROM ai_calls WHERE created_at >= ?`,
  ).get(since) as { calls: number; tokens_in: number; tokens_out: number; cost: number; errors: number; cached: number; avg_ms: number; fallbacks: number };
  const byModel = d.prepare(
    `SELECT model, provider_name, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost) AS cost,
       AVG(CASE WHEN status = 'ok' THEN latency_ms END) AS avg_ms, SUM(status = 'error') AS errors
     FROM ai_calls WHERE created_at >= ? GROUP BY model, provider_name ORDER BY calls DESC LIMIT 20`,
  ).all(since) as { model: string; provider_name: string | null; calls: number; tokens_in: number; tokens_out: number; cost: number; avg_ms: number | null; errors: number }[];
  const byPurpose = d.prepare(
    "SELECT purpose, COUNT(*) AS calls, SUM(cost) AS cost, SUM(tokens_in + tokens_out) AS tokens FROM ai_calls WHERE created_at >= ? GROUP BY purpose ORDER BY calls DESC",
  ).all(since) as { purpose: string; calls: number; cost: number; tokens: number }[];
  return { days, totals, byModel, byPurpose };
}

export function deleteAiCalls(olderThanDays?: number) {
  if (olderThanDays === undefined) return db().prepare("DELETE FROM ai_calls").run().changes;
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  return db().prepare("DELETE FROM ai_calls WHERE created_at < ?").run(cutoff).changes;
}

// Response cache: identical request → same answer, for a limited time.
export function cachedAiResponse(key: string, maxAgeHours: number): string | null {
  const row = db().prepare("SELECT value, created_at FROM ai_cache WHERE key = ?").get(key) as { value: string; created_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.created_at) < Date.now() - maxAgeHours * 3600_000) {
    db().prepare("DELETE FROM ai_cache WHERE key = ?").run(key);
    return null;
  }
  return row.value;
}

export function storeAiResponse(key: string, value: string) {
  db().prepare("INSERT INTO ai_cache (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at")
    .run(key, value.slice(0, 200_000), now());
}

export function clearAiCache(olderThanHours?: number) {
  if (olderThanHours === undefined) return db().prepare("DELETE FROM ai_cache").run().changes;
  return db().prepare("DELETE FROM ai_cache WHERE created_at < ?").run(new Date(Date.now() - olderThanHours * 3600_000).toISOString()).changes;
}

// Memory: short facts the agent should always know ("I live in Chennai", "prices in INR").
export type MemoryNote = { id: string; text: string; source: "you" | "agent"; created_at: string };
const MAX_NOTES = 100;

export function listMemory(): MemoryNote[] {
  return db().prepare("SELECT * FROM ai_memory ORDER BY created_at ASC").all() as MemoryNote[];
}

export function addMemory(text: string, source: MemoryNote["source"] = "you"): MemoryNote {
  const clean = text.trim().slice(0, 500);
  const existing = listMemory().find((n) => n.text.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  if (listMemory().length >= MAX_NOTES) throw Object.assign(new Error(`Memory holds up to ${MAX_NOTES} notes. Delete some first.`), { code: "memory_full" });
  const note: MemoryNote = { id: newId(), text: clean, source, created_at: now() };
  db().prepare("INSERT INTO ai_memory (id, text, source, created_at) VALUES (?, ?, ?, ?)").run(note.id, note.text, note.source, note.created_at);
  return note;
}

export function deleteMemory(id: string) {
  return db().prepare("DELETE FROM ai_memory WHERE id = ?").run(id).changes > 0;
}
