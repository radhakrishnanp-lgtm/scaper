import "server-only";
import { db } from "../db";
import { newId, now, pageSize, parseJson } from "./util";

export type AgentStep =
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean }
  | { type: "answer"; text: string };

type Row = {
  id: string; prompt: string; model: string; status: "running" | "done" | "error"; steps: string; answer: string | null;
  tokens_in: number; tokens_out: number; error: string | null; parent_id: string | null; created_at: string; updated_at: string;
};
export type AgentRun = Omit<Row, "steps"> & { steps: AgentStep[] };
const toRun = (r: Row): AgentRun => ({ ...r, steps: parseJson<AgentStep[]>(r.steps, []) });

export function createAgentRun(prompt: string, model: string, parentId: string | null = null): AgentRun {
  const id = newId();
  const t = now();
  db().prepare("INSERT INTO agent_runs (id, prompt, model, status, parent_id, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(id, prompt, model, parentId, t, t);
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
  const d = db();
  d.transaction(() => {
    d.prepare("UPDATE agent_runs SET parent_id = (SELECT parent_id FROM agent_runs WHERE id = ?) WHERE parent_id = ?").run(id, id);
    d.prepare("DELETE FROM agent_runs WHERE id = ?").run(id);
  })();
}

export function updateAgentRun(id: string, patch: Partial<Pick<AgentRun, "status" | "steps" | "answer" | "tokens_in" | "tokens_out" | "error">>) {
  const cur = getAgentRun(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db().prepare("UPDATE agent_runs SET status = ?, steps = ?, answer = ?, tokens_in = ?, tokens_out = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(next.status, JSON.stringify(next.steps), next.answer, next.tokens_in, next.tokens_out, next.error, now(), id);
}

export function getAgentRun(id: string): AgentRun | null {
  const r = db().prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row | undefined;
  return r ? toRun(r) : null;
}

export function listAgentRuns(limit?: number, q?: string) {
  const where = q ? "WHERE prompt LIKE ?" : "";
  const args: unknown[] = q ? [`%${q}%`] : [];
  return (db().prepare(`SELECT * FROM agent_runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, pageSize(limit, 100, 30)) as Row[]).map(toRun);
}

/** Marks runs left "running" by a crash or restart as failed. */
export function failStaleAgentRuns() {
  db().prepare("UPDATE agent_runs SET status = 'error', error = 'Stopped because the app restarted', updated_at = ? WHERE status = 'running'").run(now());
}

const today = () => new Date().toISOString().slice(0, 10);

export function aiUsageToday() {
  return (db().prepare("SELECT requests, tokens FROM ai_usage WHERE day = ?").get(today()) as { requests: number; tokens: number } | undefined)
    ?? { requests: 0, tokens: 0 };
}

export function addAiUsage(tokensIn: number, tokensOut = 0) {
  db().prepare(
    `INSERT INTO ai_usage (day, requests, tokens, tokens_in, tokens_out) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
  ).run(today(), tokensIn + tokensOut, tokensIn, tokensOut);
}

/** Requests and tokens per day, for the AI usage chart. */
export function aiUsageHistory(days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db().prepare("SELECT day, requests, tokens, tokens_in, tokens_out FROM ai_usage WHERE day >= ? ORDER BY day").all(since) as
    { day: string; requests: number; tokens: number; tokens_in: number; tokens_out: number }[];
}
