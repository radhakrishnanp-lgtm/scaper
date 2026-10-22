import "server-only";
import { db } from "../db";
import type { FetchMode, SiteRuleInput } from "@/lib/schemas";
import { now, parseJson } from "./util";

type SiteRuleRow = {
  host: string; delay_seconds: number | null; mode: FetchMode | null; user_agent: string; headers: string; cookies: string;
  respect_robots: number | null; paused: number; notes: string; created_at: string; updated_at: string;
};
export type SiteRule = Omit<SiteRuleRow, "headers" | "respect_robots" | "paused"> & {
  headers: { name: string; value: string }[]; respect_robots: boolean | null; paused: boolean;
};

const toRule = (r: SiteRuleRow): SiteRule => ({
  ...r, headers: parseJson(r.headers, []), respect_robots: r.respect_robots === null ? null : Boolean(r.respect_robots), paused: Boolean(r.paused),
});

/** A rule for "example.com" also applies to "www.example.com" and other subdomains; the most specific wins. */
export function ruleForHost(host: string): SiteRule | null {
  const parts = host.toLowerCase().split(".");
  const candidates = parts.map((_, i) => parts.slice(i).join(".")).filter((h) => h.includes(".") || h === "localhost");
  if (!candidates.length) return null;
  const rows = db().prepare(`SELECT * FROM site_rules WHERE host IN (${candidates.map(() => "?").join(",")})`).all(...candidates) as SiteRuleRow[];
  if (!rows.length) return null;
  rows.sort((a, b) => b.host.length - a.host.length);
  return toRule(rows[0]!);
}

export function listSiteRules(): SiteRule[] {
  return (db().prepare("SELECT * FROM site_rules ORDER BY host").all() as SiteRuleRow[]).map(toRule);
}

export function getSiteRule(host: string): SiteRule | null {
  const r = db().prepare("SELECT * FROM site_rules WHERE host = ?").get(host) as SiteRuleRow | undefined;
  return r ? toRule(r) : null;
}

export function upsertSiteRule(input: SiteRuleInput, keepCookies = false): SiteRule {
  const t = now();
  const before = getSiteRule(input.host);
  const cookies = keepCookies && before ? before.cookies : input.cookies;
  db().prepare(
    `INSERT INTO site_rules (host, delay_seconds, mode, user_agent, headers, cookies, respect_robots, paused, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET delay_seconds = excluded.delay_seconds, mode = excluded.mode, user_agent = excluded.user_agent,
       headers = excluded.headers, cookies = excluded.cookies, respect_robots = excluded.respect_robots, paused = excluded.paused,
       notes = excluded.notes, updated_at = excluded.updated_at`,
  ).run(input.host, input.delaySeconds, input.mode, input.userAgent, JSON.stringify(input.headers), cookies,
    input.respectRobots === null ? null : input.respectRobots ? 1 : 0, input.paused ? 1 : 0, input.notes, t, t);
  return getSiteRule(input.host)!;
}

export function deleteSiteRule(host: string) {
  return db().prepare("DELETE FROM site_rules WHERE host = ?").run(host).changes > 0;
}

/** Cookies and header values can be session secrets, so the browser only sees that they are set. */
export function publicRule(r: SiteRule) {
  return {
    ...r,
    cookies: r.cookies ? `${r.cookies.split(";").length} cookie(s) set` : "",
    hasCookies: Boolean(r.cookies),
    headers: r.headers.map((h) => ({ name: h.name, value: /auth|token|key|secret|cookie/i.test(h.name) ? "••••" : h.value })),
  };
}

const day = () => new Date().toISOString().slice(0, 10);

/** Per-host, per-day request counters for the Sites page. */
export function recordHostRequest(host: string, outcome: { ok: boolean; blocked: boolean; ms: number; bytes: number; status: number | null }) {
  db().prepare(
    `INSERT INTO host_stats (host, day, requests, ok, blocked, errors, total_ms, bytes, last_status, last_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, day) DO UPDATE SET requests = requests + 1, ok = ok + excluded.ok, blocked = blocked + excluded.blocked,
       errors = errors + excluded.errors, total_ms = total_ms + excluded.total_ms, bytes = bytes + excluded.bytes,
       last_status = excluded.last_status, last_at = excluded.last_at`,
  ).run(host, day(), outcome.ok ? 1 : 0, outcome.blocked ? 1 : 0, !outcome.ok && !outcome.blocked ? 1 : 0, Math.round(outcome.ms), outcome.bytes, outcome.status, now());
}

export type HostSummary = { host: string; requests: number; ok: number; blocked: number; errors: number; avg_ms: number; bytes: number; last_status: number | null; last_at: string | null };

export function hostSummaries(days = 30): HostSummary[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db().prepare(
    `SELECT host, SUM(requests) requests, SUM(ok) ok, SUM(blocked) blocked, SUM(errors) errors,
       CAST(SUM(total_ms) / MAX(SUM(requests), 1) AS INTEGER) avg_ms, SUM(bytes) bytes, MAX(last_at) last_at,
       (SELECT h2.last_status FROM host_stats h2 WHERE h2.host = host_stats.host ORDER BY h2.last_at DESC LIMIT 1) last_status
     FROM host_stats WHERE day >= ? GROUP BY host ORDER BY requests DESC LIMIT 500`,
  ).all(since) as HostSummary[];
}

export function hostDaily(host: string, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db().prepare("SELECT day, requests, ok, blocked, errors FROM host_stats WHERE host = ? AND day >= ? ORDER BY day").all(host, since) as
    { day: string; requests: number; ok: number; blocked: number; errors: number }[];
}

export function pruneHostStats(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db().prepare("DELETE FROM host_stats WHERE day < ?").run(cutoff).changes;
}
