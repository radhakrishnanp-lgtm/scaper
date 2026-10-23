import "server-only";
import { db } from "../db";
import { newId, now, parseJson } from "./util";

// ---------------------------------------------------------------------------------------------
// Helper agents

export type WorkerStep =
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean; ms?: number }
  | { type: "message"; from: "supervisor"; text: string };

export type DecisionQuestions = Record<string, { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown }>;

type WorkerRow = {
  id: string; team_id: string; name: string; role: string; instructions: string; task: string; examples: string; tools: string; questions: string | null;
  model: string; playbook_id: string | null; status: "running" | "done" | "error" | "stopped"; steps: string; result: string | null; error: string | null;
  tokens_in: number; tokens_out: number; cost: number; created_at: string; updated_at: string;
};
export type Worker = Omit<WorkerRow, "tools" | "questions" | "steps"> & { tools: string[]; questions: DecisionQuestions | null; steps: WorkerStep[] };
const toWorker = (r: WorkerRow): Worker => ({ ...r, tools: parseJson<string[]>(r.tools, []), questions: parseJson<DecisionQuestions | null>(r.questions ?? "null", null), steps: parseJson<WorkerStep[]>(r.steps, []) });

export function createWorker(w: Pick<Worker, "team_id" | "name" | "role" | "instructions" | "task" | "examples" | "tools" | "questions" | "model" | "playbook_id">): Worker {
  const id = newId();
  const t = now();
  db().prepare(`INSERT INTO agent_workers (id, team_id, name, role, instructions, task, examples, tools, questions, model, playbook_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, w.team_id, w.name, w.role, w.instructions, w.task, w.examples, JSON.stringify(w.tools), w.questions ? JSON.stringify(w.questions) : null, w.model, w.playbook_id, t, t);
  return getWorker(id)!;
}

export function getWorker(id: string): Worker | null {
  const r = db().prepare("SELECT * FROM agent_workers WHERE id = ?").get(id) as WorkerRow | undefined;
  return r ? toWorker(r) : null;
}

export function findWorker(teamId: string, name: string): Worker | null {
  const r = db().prepare("SELECT * FROM agent_workers WHERE team_id = ? AND lower(name) = lower(?)").get(teamId, name.trim()) as WorkerRow | undefined;
  return r ? toWorker(r) : null;
}

export function listWorkers(teamId: string): Worker[] {
  return (db().prepare("SELECT * FROM agent_workers WHERE team_id = ? ORDER BY created_at").all(teamId) as WorkerRow[]).map(toWorker);
}

export function updateWorker(id: string, patch: Partial<Pick<Worker, "status" | "steps" | "result" | "error" | "tokens_in" | "tokens_out" | "cost">>) {
  const cur = getWorker(id);
  if (!cur) return;
  // A stopped or finished helper never comes back to life.
  const status = cur.status !== "running" && patch.status === "running" ? cur.status : patch.status ?? cur.status;
  const n = { ...cur, ...patch, status };
  db().prepare("UPDATE agent_workers SET status = ?, steps = ?, result = ?, error = ?, tokens_in = ?, tokens_out = ?, cost = ?, updated_at = ? WHERE id = ?")
    .run(n.status, JSON.stringify(n.steps), n.result, n.error, n.tokens_in, n.tokens_out, n.cost, now(), id);
}

export function failStaleWorkers() {
  db().prepare("UPDATE agent_workers SET status = 'error', error = 'Stopped because the app restarted', updated_at = ? WHERE status = 'running'").run(now());
}

// ---------------------------------------------------------------------------------------------
// Shared memory

export type MemoryEntry = { id: string; team_id: string; author: string; key: string; value: string; created_at: string };

export function writeTeamMemory(teamId: string, author: string, key: string, value: string): MemoryEntry {
  const count = (db().prepare("SELECT COUNT(*) AS n FROM team_memory WHERE team_id = ?").get(teamId) as { n: number }).n;
  if (count >= 500) throw new Error("The team's shared memory is full (500 notes). Summarise instead of adding more.");
  const e = { id: newId(), team_id: teamId, author: author.slice(0, 60), key: key.trim().slice(0, 120) || "note", value: value.slice(0, 8000), created_at: now() };
  db().prepare("INSERT INTO team_memory (id, team_id, author, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, e.team_id, e.author, e.key, e.value, e.created_at);
  return e;
}

export function readTeamMemory(teamId: string, opts: { key?: string; limit?: number } = {}): MemoryEntry[] {
  const limit = Math.min(500, opts.limit ?? 200);
  if (opts.key) return db().prepare("SELECT * FROM team_memory WHERE team_id = ? AND key LIKE ? ORDER BY created_at LIMIT ?").all(teamId, `%${opts.key}%`, limit) as MemoryEntry[];
  return db().prepare("SELECT * FROM team_memory WHERE team_id = ? ORDER BY created_at LIMIT ?").all(teamId, limit) as MemoryEntry[];
}

// ---------------------------------------------------------------------------------------------
// Playbooks: instructions that get better with use

type PlaybookRow = {
  id: string; name: string; kind: string; instructions: string; examples: string; questions: string | null; notes: string;
  version: number; uses: number; wins: number; source: "agent" | "you"; created_at: string; updated_at: string;
};
export type Playbook = Omit<PlaybookRow, "questions"> & { questions: DecisionQuestions | null };
const toPlaybook = (r: PlaybookRow): Playbook => ({ ...r, questions: parseJson<DecisionQuestions | null>(r.questions ?? "null", null) });

export function listPlaybooks(q?: string): Playbook[] {
  const rows = q
    ? db().prepare("SELECT * FROM agent_playbooks WHERE name LIKE ? OR kind LIKE ? OR instructions LIKE ? OR notes LIKE ? ORDER BY (wins + 1.0) / (uses + 2.0) DESC, updated_at DESC LIMIT 50").all(...Array(4).fill(`%${q}%`))
    : db().prepare("SELECT * FROM agent_playbooks ORDER BY updated_at DESC LIMIT 200").all();
  return (rows as PlaybookRow[]).map(toPlaybook);
}

export function getPlaybook(idOrName: string): Playbook | null {
  const r = db().prepare("SELECT * FROM agent_playbooks WHERE id = ? OR lower(name) = lower(?)").get(idOrName, idOrName.trim()) as PlaybookRow | undefined;
  return r ? toPlaybook(r) : null;
}

/** Creates a playbook, or saves a new version of one with the same name (the old text is replaced, the counts kept). */
export function savePlaybook(p: { name: string; kind?: string; instructions: string; examples?: string; questions?: DecisionQuestions | null; notes?: string; source?: "agent" | "you" }): Playbook {
  const t = now();
  const cur = getPlaybook(p.name);
  if (cur) {
    db().prepare("UPDATE agent_playbooks SET kind = ?, instructions = ?, examples = ?, questions = ?, notes = ?, version = version + 1, source = ?, updated_at = ? WHERE id = ?")
      .run(p.kind ?? cur.kind, p.instructions, p.examples ?? cur.examples, p.questions === undefined ? (cur.questions ? JSON.stringify(cur.questions) : null) : p.questions ? JSON.stringify(p.questions) : null, p.notes ?? cur.notes, p.source ?? "agent", t, cur.id);
    return getPlaybook(cur.id)!;
  }
  const id = newId();
  db().prepare("INSERT INTO agent_playbooks (id, name, kind, instructions, examples, questions, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, p.name.trim().slice(0, 80), (p.kind ?? "").slice(0, 80), p.instructions, p.examples ?? "", p.questions ? JSON.stringify(p.questions) : null, p.notes ?? "", p.source ?? "agent", t, t);
  return getPlaybook(id)!;
}

/** Counts a use and, when it worked, a win; the success rate orders playbooks for the supervisor. */
export function scorePlaybook(id: string, worked: boolean | null, note?: string) {
  const cur = getPlaybook(id);
  if (!cur) return null;
  const notes = note ? `${cur.notes ? `${cur.notes}\n` : ""}${new Date().toISOString().slice(0, 10)}: ${note}`.slice(-4000) : cur.notes;
  db().prepare("UPDATE agent_playbooks SET uses = uses + ?, wins = wins + ?, notes = ?, updated_at = ? WHERE id = ?").run(worked === null ? 1 : 0, worked ? 1 : 0, notes, now(), id);
  return getPlaybook(id);
}

export function deletePlaybook(id: string) {
  return db().prepare("DELETE FROM agent_playbooks WHERE id = ?").run(id).changes > 0;
}
