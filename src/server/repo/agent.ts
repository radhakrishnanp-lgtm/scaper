import "server-only";
import type { GuardSignals } from "@/lib/decision-policy";
import { db } from "../db";
import { ephemeral } from "./ephemeral";
import { newId, now, pageSize, parseJson } from "./util";

export type AgentStep =
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean; ms?: number; approval?: "allowed" | "declined" | "auto" }
  | { type: "answer"; text: string };

/** A change the agent wants to make and is waiting for you to allow. */
export type PendingApproval = {
  callId: string; tool: string; args: Record<string, unknown>; summary: string; askedAt: string;
  /** Why Scaper asks (deleting, or what the decision model flagged), with the model's probabilities. */
  risk?: { reasons: string[]; signals: GuardSignals | null; error: string | null };
};

type Row = {
  id: string; prompt: string; model: string; status: "running" | "done" | "error"; steps: string; answer: string | null;
  tokens_in: number; tokens_out: number; error: string | null; parent_id: string | null; created_at: string; updated_at: string;
  cost: number; pending: string | null; model_label: string | null;
  /** The bot this run belongs to, and what started it (manual, schedule, chat, event:<name>). */
  bot_id?: string | null; trigger?: string | null;
};
export type AgentRun = Omit<Row, "steps" | "pending"> & { steps: AgentStep[]; pending: PendingApproval | null; private?: boolean };
const toRun = (r: Row): AgentRun => ({ ...r, steps: parseJson<AgentStep[]>(r.steps, []), pending: parseJson<PendingApproval | null>(r.pending, null) });

// Private conversations stay in memory for two hours and are never written to the database.
const privateRuns = ephemeral<AgentRun>("agent", 2 * 3600_000, 100);

export function createAgentRun(prompt: string, model: string, parentId: string | null = null, opts: { private?: boolean; modelLabel?: string; botId?: string | null; trigger?: string | null } = {}): AgentRun {
  const id = newId();
  const t = now();
  if (opts.private) {
    return privateRuns.set(id, {
      id, prompt, model, status: "running", steps: [], answer: null, tokens_in: 0, tokens_out: 0, error: null, parent_id: parentId,
      created_at: t, updated_at: t, cost: 0, pending: null, model_label: opts.modelLabel ?? null, private: true, bot_id: opts.botId ?? null, trigger: opts.trigger ?? null,
    });
  }
  db().prepare("INSERT INTO agent_runs (id, prompt, model, status, parent_id, created_at, updated_at, model_label, bot_id, trigger) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)")
    .run(id, prompt, model, parentId, t, t, opts.modelLabel ?? null, opts.botId ?? null, opts.trigger ?? null);
  return getAgentRun(id)!;
}

/** The earlier runs a follow-up builds on, oldest first (at most `max`). */
export function agentThread(id: string, max = 8): AgentRun[] {
  const out: AgentRun[] = [];
  let cur = getAgentRun(id)?.parent_id ?? null;
  while (cur && out.length < max) {
    const r = getAgentRun(cur);
    if (!r) break;
    out.unshift(r);
    cur = r.parent_id;
  }
  return out;
}

export function deleteAgentRun(id: string) {
  const p = privateRuns.get(id);
  if (p) {
    for (const r of privateRuns.values()) if (r.parent_id === id) privateRuns.set(r.id, { ...r, parent_id: p.parent_id });
    privateRuns.delete(id);
    return;
  }
  const d = db();
  d.transaction(() => {
    d.prepare("UPDATE agent_runs SET parent_id = (SELECT parent_id FROM agent_runs WHERE id = ?) WHERE parent_id = ?").run(id, id);
    d.prepare("DELETE FROM agent_runs WHERE id = ?").run(id);
  })();
}

export function updateAgentRun(id: string, patch: Partial<Pick<AgentRun, "status" | "steps" | "answer" | "tokens_in" | "tokens_out" | "error" | "cost" | "pending">>) {
  const cur = getAgentRun(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  if (cur.private) { privateRuns.set(id, { ...next, updated_at: now() }); return; }
  db().prepare("UPDATE agent_runs SET status = ?, steps = ?, answer = ?, tokens_in = ?, tokens_out = ?, error = ?, cost = ?, pending = ?, updated_at = ? WHERE id = ?")
    .run(next.status, JSON.stringify(next.steps), next.answer, next.tokens_in, next.tokens_out, next.error, next.cost, next.pending ? JSON.stringify(next.pending) : null, now(), id);
}

export function getAgentRun(id: string): AgentRun | null {
  const p = privateRuns.get(id);
  if (p) return p;
  const r = db().prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row | undefined;
  return r ? toRun(r) : null;
}

/** The agent page's conversations; bot runs live on each bot's page. */
export function listAgentRuns(limit?: number, q?: string) {
  const where = q ? "WHERE bot_id IS NULL AND (prompt LIKE ? OR answer LIKE ?)" : "WHERE bot_id IS NULL";
  const args: unknown[] = q ? [`%${q}%`, `%${q}%`] : [];
  const saved = (db().prepare(`SELECT * FROM agent_runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, pageSize(limit, 100, 30)) as Row[]).map(toRun);
  const priv = privateRuns.values().filter((r) => !r.bot_id).filter((r) => !q || r.prompt.toLowerCase().includes(q.toLowerCase()) || (r.answer ?? "").toLowerCase().includes(q.toLowerCase()));
  return [...priv, ...saved];
}

/** Marks runs left "running" by a crash or restart as failed. */
export function failStaleAgentRuns() {
  db().prepare("UPDATE agent_runs SET status = 'error', error = 'Stopped because the app restarted', pending = NULL, updated_at = ? WHERE status = 'running'").run(now());
}

const today = () => new Date().toISOString().slice(0, 10);

export function aiUsageToday() {
  return (db().prepare("SELECT requests, tokens FROM ai_usage WHERE day = ?").get(today()) as { requests: number; tokens: number } | undefined)
    ?? { requests: 0, tokens: 0 };
}

/** Daily counters only (no content), so limits and budgets work in private mode too. */
export function addAiUsage(tokensIn: number, tokensOut = 0, cost = 0) {
  db().prepare(
    `INSERT INTO ai_usage (day, requests, tokens, tokens_in, tokens_out, cost) VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens, tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out, cost = cost + excluded.cost`,
  ).run(today(), tokensIn + tokensOut, tokensIn, tokensOut, cost);
}

/** Requests, tokens and cost per day, for the AI usage chart. */
export function aiUsageHistory(days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db().prepare("SELECT day, requests, tokens, tokens_in, tokens_out, cost FROM ai_usage WHERE day >= ? ORDER BY day").all(since) as
    { day: string; requests: number; tokens: number; tokens_in: number; tokens_out: number; cost: number }[];
}

/** Spend so far in this calendar month (UTC), for the monthly budget. */
export function aiCostThisMonth() {
  const month = new Date().toISOString().slice(0, 7);
  return (db().prepare("SELECT COALESCE(SUM(cost), 0) AS c, COALESCE(SUM(requests), 0) AS r, COALESCE(SUM(tokens), 0) AS t FROM ai_usage WHERE day LIKE ?").get(`${month}%`) as { c: number; r: number; t: number });
}
