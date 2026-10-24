import "server-only";
import { botSchema, MAX_ACTIVE_BOTS, type BotInput, type BotSchedule } from "@/lib/schemas";
import { db } from "../db";
import { getAgentRun, type AgentRun } from "./agent";
import { looksSecret } from "./knowledge";
import { newId, now, parseJson } from "./util";

/**
 * Bots: named agents with one job. The settings live as JSON in `config`; the columns hold what the
 * scheduler needs (enabled, next run) and the latest outcome. Runs are ordinary agent runs with bot_id set.
 */

type Row = {
  id: string; name: string; emoji: string; config: string; enabled: number; next_run_at: string | null; last_run_at: string | null;
  last_run_id: string | null; last_status: string | null; run_count: number; finished_reason: string | null; created_at: string; updated_at: string;
};
export type Bot = Omit<BotInput, "name" | "emoji"> & Omit<Row, "config" | "enabled"> & { enabled: boolean; running: boolean };

const runningBots = () => new Set((db().prepare("SELECT DISTINCT bot_id FROM agent_runs WHERE bot_id IS NOT NULL AND status = 'running'").all() as { bot_id: string }[]).map((r) => r.bot_id));

function toBot(r: Row, running = runningBots()): Bot {
  const config = botSchema.parse({ name: r.name, emoji: r.emoji, ...parseJson<Record<string, unknown>>(r.config, {}) });
  return { ...config, ...r, enabled: Boolean(r.enabled), running: running.has(r.id) };
}

/** The editable fields of a bot, as the form and the schema know them. */
const inputOf = (b: Bot): BotInput => botSchema.parse(Object.fromEntries(Object.keys(botSchema.shape).map((k) => [k, (b as Record<string, unknown>)[k]])));

/** When a schedule next fires after `from`, or null for manual bots. */
export function nextRunAt(schedule: BotSchedule, from = new Date()): string | null {
  if (schedule.type === "manual") return null;
  if (schedule.type === "interval") return new Date(from.getTime() + schedule.minutes * 60_000).toISOString();
  const [h, m] = schedule.time.split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const t = new Date(from);
    t.setDate(t.getDate() + d);
    t.setHours(h!, m!, 0, 0);
    if (t <= from) continue;
    if (schedule.days.length && !schedule.days.includes(t.getDay())) continue;
    return t.toISOString();
  }
  return null;
}

export function describeSchedule(s: BotSchedule) {
  if (s.type === "manual") return "When you run it";
  if (s.type === "interval") return s.minutes % 1440 === 0 ? `Every ${s.minutes / 1440} day${s.minutes === 1440 ? "" : "s"}` : s.minutes % 60 === 0 ? `Every ${s.minutes / 60} hour${s.minutes === 60 ? "" : "s"}` : `Every ${s.minutes} minutes`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `At ${s.time}${s.days.length && s.days.length < 7 ? ` on ${[...s.days].sort().map((d) => names[d]).join(", ")}` : " every day"}`;
}

export function listBots(): Bot[] {
  const running = runningBots();
  return (db().prepare("SELECT * FROM bots ORDER BY enabled DESC, name").all() as Row[]).map((r) => toBot(r, running));
}

export function getBot(idOrName: string): Bot | null {
  const k = idOrName.trim();
  const r = db().prepare("SELECT * FROM bots WHERE id = ? OR lower(name) = lower(?)").get(k, k) as Row | undefined;
  return r ? toBot(r) : null;
}

const activeCount = (except?: string) => (db().prepare("SELECT COUNT(*) AS n FROM bots WHERE enabled = 1 AND id != ?").get(except ?? "") as { n: number }).n;
const nameTaken = (name: string, except?: string) => Boolean(db().prepare("SELECT 1 FROM bots WHERE lower(name) = lower(?) AND id != ?").get(name, except ?? ""));

export class BotError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}

export function createBot(input: BotInput): Bot {
  const b = botSchema.parse(input);
  if (nameTaken(b.name)) throw new BotError(`You already have a bot called "${b.name}".`, "name");
  if (activeCount() >= MAX_ACTIVE_BOTS) throw new BotError(`You can have up to ${MAX_ACTIVE_BOTS} active bots. Pause or delete one first.`);
  const { name, emoji, ...config } = b;
  const id = newId();
  const t = now();
  db().prepare("INSERT INTO bots (id, name, emoji, config, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run(id, name, emoji || "🤖", JSON.stringify(config), nextRunAt(b.schedule), t, t);
  return getBot(id)!;
}

export function updateBot(id: string, patch: Partial<BotInput> & { enabled?: boolean }): Bot {
  const cur = getBot(id);
  if (!cur) throw new BotError("That bot no longer exists.");
  const { enabled, ...fields } = patch;
  const wasEnabled = cur.enabled;
  const next = botSchema.parse({ ...inputOf(cur), ...fields });
  if (nameTaken(next.name, id)) throw new BotError(`You already have a bot called "${next.name}".`, "name");
  const on = enabled ?? wasEnabled;
  if (on && !wasEnabled && activeCount(id) >= MAX_ACTIVE_BOTS) throw new BotError(`You can have up to ${MAX_ACTIVE_BOTS} active bots. Pause another one first.`);
  const { name, emoji, ...rest } = next;
  const scheduleChanged = JSON.stringify(next.schedule) !== JSON.stringify(cur.schedule);
  const nextRun = !on ? null : scheduleChanged || !wasEnabled || !cur.next_run_at ? nextRunAt(next.schedule) : cur.next_run_at;
  db().prepare("UPDATE bots SET name = ?, emoji = ?, config = ?, enabled = ?, next_run_at = ?, finished_reason = ?, updated_at = ? WHERE id = ?")
    .run(name, emoji || "🤖", JSON.stringify(rest), on ? 1 : 0, nextRun, on && !wasEnabled ? null : cur.finished_reason, now(), id);
  return getBot(id)!;
}

export function deleteBot(id: string) {
  return db().prepare("DELETE FROM bots WHERE id = ?").run(id).changes > 0;
}

/** The bot reached its end condition: pause it and say why. */
export function finishBot(id: string, reason: string) {
  db().prepare("UPDATE bots SET enabled = 0, next_run_at = NULL, finished_reason = ?, updated_at = ? WHERE id = ?").run(reason.slice(0, 500), now(), id);
}

/** Enabled bots whose schedule is due and that are not running; their next run is moved on at once. */
export function claimDueBots(limit = 3): Bot[] {
  if (limit <= 0) return [];
  const t = now();
  const rows = db().prepare("SELECT * FROM bots WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?").all(t, limit * 2) as Row[];
  const running = runningBots();
  const out: Bot[] = [];
  for (const r of rows) {
    const b = toBot(r, running);
    db().prepare("UPDATE bots SET next_run_at = ? WHERE id = ?").run(nextRunAt(b.schedule), b.id);
    if (!b.running && out.length < limit) out.push(b);
  }
  return out;
}

export function markBotStarted(id: string, runId: string) {
  db().prepare("UPDATE bots SET last_run_at = ?, last_run_id = ?, last_status = 'running', run_count = run_count + 1 WHERE id = ?").run(now(), runId, id);
}

export function markBotFinished(id: string, status: string) {
  db().prepare("UPDATE bots SET last_status = ? WHERE id = ?").run(status, id);
}

/** Last time a run of this bot was started by an event, for the cooldown. */
export function lastEventRunAt(id: string): number {
  const r = db().prepare("SELECT created_at FROM agent_runs WHERE bot_id = ? AND trigger LIKE 'event:%' ORDER BY created_at DESC LIMIT 1").get(id) as { created_at: string } | undefined;
  return r ? Date.parse(r.created_at) : 0;
}

export function botRuns(botId: string, limit = 30, trigger?: "chat"): AgentRun[] {
  const rows = db().prepare(`SELECT id FROM agent_runs WHERE bot_id = ? ${trigger ? "AND trigger = ?" : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...(trigger ? [botId, trigger, limit] : [botId, limit])) as { id: string }[];
  return rows.map((r) => getAgentRun(r.id)!).filter(Boolean);
}

/** Runs and tokens per bot today, for the daily guard. */
export function botRunsToday(botId: string) {
  return (db().prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE bot_id = ? AND created_at >= ?").get(botId, `${new Date().toISOString().slice(0, 10)}T00:00:00`) as { n: number }).n;
}

// ---------------------------------------------------------------------------------------------
// Each bot's own memory

export type BotMemory = { id: string; bot_id: string; kind: "fact" | "run"; key: string; value: string; created_at: string; updated_at: string };
export const MAX_BOT_FACTS = 60;
const MAX_RUN_SUMMARIES = 20;

export function listBotMemory(botId: string, kind?: "fact" | "run"): BotMemory[] {
  return db().prepare(`SELECT * FROM bot_memory WHERE bot_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY updated_at DESC`).all(...(kind ? [botId, kind] : [botId])) as BotMemory[];
}

export function rememberFact(botId: string, key: string, value: string): BotMemory {
  const k = key.trim().slice(0, 80);
  const v = value.trim().slice(0, 2000);
  if (!k || !v) throw new BotError("A memory needs a name and some text.");
  if (looksSecret(`${k} ${v}`)) throw new BotError("That looks like a key or password. Bots never keep secrets in memory.");
  const t = now();
  const existing = db().prepare("SELECT id FROM bot_memory WHERE bot_id = ? AND kind = 'fact' AND key = ?").get(botId, k) as { id: string } | undefined;
  if (existing) {
    db().prepare("UPDATE bot_memory SET value = ?, updated_at = ? WHERE id = ?").run(v, t, existing.id);
    return db().prepare("SELECT * FROM bot_memory WHERE id = ?").get(existing.id) as BotMemory;
  }
  const count = (db().prepare("SELECT COUNT(*) AS n FROM bot_memory WHERE bot_id = ? AND kind = 'fact'").get(botId) as { n: number }).n;
  if (count >= MAX_BOT_FACTS) throw new BotError(`This bot already keeps ${MAX_BOT_FACTS} facts. Forget or merge some first.`);
  const id = newId();
  db().prepare("INSERT INTO bot_memory (id, bot_id, kind, key, value, created_at, updated_at) VALUES (?, ?, 'fact', ?, ?, ?, ?)").run(id, botId, k, v, t, t);
  return db().prepare("SELECT * FROM bot_memory WHERE id = ?").get(id) as BotMemory;
}

export function forgetFact(botId: string, keyOrId: string) {
  return db().prepare("DELETE FROM bot_memory WHERE bot_id = ? AND (id = ? OR (kind = 'fact' AND key = ?))").run(botId, keyOrId, keyOrId.trim()).changes > 0;
}

export function clearBotMemory(botId: string) {
  return db().prepare("DELETE FROM bot_memory WHERE bot_id = ?").run(botId).changes;
}

/** A short line about each finished run, so the next run knows what happened before. Keeps the last 20. */
export function addRunSummary(botId: string, runId: string, text: string) {
  const t = now();
  db().prepare("INSERT OR REPLACE INTO bot_memory (id, bot_id, kind, key, value, created_at, updated_at) VALUES (?, ?, 'run', ?, ?, ?, ?)")
    .run(newId(), botId, runId, text.replace(/\s+/g, " ").trim().slice(0, 600), t, t);
  db().prepare("DELETE FROM bot_memory WHERE bot_id = ? AND kind = 'run' AND id NOT IN (SELECT id FROM bot_memory WHERE bot_id = ? AND kind = 'run' ORDER BY updated_at DESC LIMIT ?)")
    .run(botId, botId, MAX_RUN_SUMMARIES);
}
