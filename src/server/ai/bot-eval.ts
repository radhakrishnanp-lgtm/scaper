import "server-only";
import { z } from "zod";
import { log } from "../log";
import { getAgentRun, type AgentStep } from "../repo/agent";
import { addLesson, getBotEval, listBotEvals, listBotMemory, saveBotEval, type Bot, type BotEval } from "../repo/bots";
import { audit } from "../repo/events";
import { looksSecret } from "../repo/knowledge";
import { chat, parseJsonReply } from "./client";

/**
 * A bot's self-evaluation: after each run the fast model grades the run against the bot's own job and
 * instructions, and against what you said about earlier runs (thumbs up or down and your notes). It keeps
 * at most two short lessons per run in the bot's memory, which the bot reads on every later run, and may
 * suggest a change to its instructions for you to apply. Page content is left out, so a page cannot write lessons.
 */

const evalSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  met_job: z.coerce.boolean(),
  summary: z.string().max(500),
  lessons: z.array(z.string().max(300)).max(2).default([]),
  suggestion: z.string().max(600).nullable().optional(),
});

const PROMPT = `You grade one run of the user's own bot inside Scaper, so the bot does better next time. You get the bot's job, its instructions, what started the run, every tool call (name, arguments, ok or the error), its final report, the lessons it already keeps, and what the user said about its earlier runs. Page contents are left out.
Return JSON: {"score": 1-5, "met_job": true or false, "summary": "one sentence", "lessons": ["up to 2 short rules for this bot's next runs"], "suggestion": "one sentence to add to the bot's instructions, or null"}.
Scoring: 5 = did its job well with few, cheap steps; 4 = good with small waste; 3 = partly done or wasteful; 2 = mostly failed; 1 = failed or did something its job does not cover.
Lessons: concrete and about this bot's job (which page or tool works, what to skip, how the user wants results). Follow the user's feedback above anything else. Never personal data or secrets. Do not repeat a lesson it already keeps. Empty when nothing new was learned.
Suggestion: only when the same problem keeps coming back or the user's feedback asks for a lasting change. Otherwise null.`;

function digest(steps: AgentStep[]) {
  return steps.filter((s) => s.type === "tool").map((s, i) => s.type === "tool"
    ? `${i + 1}. ${s.name}(${JSON.stringify(s.args).slice(0, 200)}) → ${s.approval === "declined" ? "declined by the user" : s.ok ? "ok" : `failed: ${s.result.replace(/^Error:\s*/, "").slice(0, 160)}`}`
    : "").join("\n");
}

/** Grades a finished bot run once. Never throws. */
export async function evaluateBotRun(bot: Bot, runId: string, trigger: string): Promise<BotEval | null> {
  try {
    if (!bot.selfEval) return null;
    const existing = getBotEval(runId);
    if (existing?.score) return existing;
    const run = getAgentRun(runId);
    if (!run || run.status === "running" || run.error === "Stopped by you.") return null;
    const lessons = listBotMemory(bot.id, "lesson").map((l) => `- ${l.value}`).join("\n") || "none";
    const feedback = listBotEvals(bot.id, 12).filter((e) => e.user_rating !== 0 || e.user_note).slice(0, 6)
      .map((e) => `- ${e.user_rating > 0 ? "👍" : e.user_rating < 0 ? "👎" : "note"}${e.user_note ? `: ${e.user_note.slice(0, 300)}` : ""}`).join("\n") || "none yet";
    const input = [
      `Bot: ${bot.name}. Role: ${bot.role}`,
      `Job:\n${bot.task.slice(0, 1500)}`,
      bot.instructions ? `Instructions:\n${bot.instructions.slice(0, 1500)}` : "",
      bot.condition ? `It should message the user only when: ${bot.condition}` : "",
      `Started by: ${trigger}${trigger === "chat" ? `\nThe user wrote: ${run.prompt.slice(0, 800)}` : ""}`,
      `Tool calls:\n${digest(run.steps) || "(none)"}`,
      run.status === "error" ? `The run failed: ${(run.error ?? "").slice(0, 300)}` : `Final report:\n${(run.answer ?? "").slice(0, 2000)}`,
      `Lessons it keeps:\n${lessons}`,
      `What the user said about earlier runs:\n${feedback}`,
    ].filter(Boolean).join("\n\n");
    const res = await chat([{ role: "system", content: PROMPT }, { role: "user", content: input }], { model: "fast", json: true, temperature: 0, maxTokens: 600, purpose: "bot-eval", refId: runId });
    const parsed = evalSchema.safeParse(parseJsonReply(res.content));
    if (!parsed.success) { log.warn("bot_eval.bad_output", { botId: bot.id, runId }); return null; }
    const e = parsed.data;
    const kept = e.lessons.map((l) => l.trim()).filter((l) => l.length > 8 && !looksSecret(l));
    for (const [i, l] of kept.entries()) addLesson(bot.id, `run:${runId}:${i}`, l);
    const saved = saveBotEval({
      run_id: runId, bot_id: bot.id, score: e.score, met_job: e.met_job, summary: e.summary, lessons: kept,
      suggestion: e.suggestion && !looksSecret(e.suggestion) ? e.suggestion.trim() || null : null, cost: res.cost,
    });
    audit("bot.evaluated", { botId: bot.id, runId, score: e.score, lessons: kept.length });
    return saved;
  } catch (err) {
    log.warn("bot_eval.failed", { botId: bot.id, runId, error: (err as Error).message });
    return null;
  }
}
