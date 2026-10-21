import "server-only";
import { db } from "../db";
import { newId, now, pageSize, parseJson } from "./util";

export type AgentStep =
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean }
  | { type: "answer"; text: string };

type Row = {
  id: string; prompt: string; model: string; status: "running" | "done" | "error"; steps: string; answer: string | null;
  tokens_in: number; tokens_out: number; error: string | null; created_at: string; updated_at: string;
};
export type AgentRun = Omit<Row, "steps"> & { steps: AgentStep[] };
const toRun = (r: Row): AgentRun => ({ ...r, steps: parseJson<AgentStep[]>(r.steps, []) });

export function createAgentRun(prompt: string, model: string): AgentRun {
  const id = newId();
  const t = now();
  db().prepare("INSERT INTO agent_runs (id, prompt, model, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)").run(id, prompt, model, t, t);
  return getAgentRun(id)!;
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

export function listAgentRuns(limit?: number) {
  return (db().prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(pageSize(limit, 50, 20)) as Row[]).map(toRun);
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

export function addAiUsage(tokens: number) {
  db().prepare(
    "INSERT INTO ai_usage (day, requests, tokens) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens",
  ).run(today(), tokens);
}
