import "server-only";
import { z } from "zod";
import { log } from "../log";
import { isPrivate } from "../privacy";
import { getAgentRun, type AgentStep } from "../repo/agent";
import { audit } from "../repo/events";
import { addLesson, getNote, getReview, listNotes, looksSecret, saveNote, saveReview, type Review } from "../repo/knowledge";
import { listWorkers } from "../repo/team";
import { getSettings } from "../repo/settings";
import { chat, parseJsonReply } from "./client";

/**
 * Self-review: after a job, the fast model looks at what the agent did (the request, each tool call and
 * whether it worked, the answer) and scores it, names what went wrong and takes one lesson. Lessons go
 * into the "Lessons learned" note the agent sees on every request; a reusable procedure or site detail
 * can become a note of its own. Page content is left out on purpose, so a page cannot write the lessons.
 */

const reviewSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  summary: z.string().max(600),
  problems: z.array(z.string().max(300)).max(6).default([]),
  lesson: z.string().max(300).default(""),
  note: z.object({
    name: z.string().max(60),
    title: z.string().max(120),
    kind: z.enum(["how-to", "site"]),
    markdown: z.string().max(4000),
  }).nullable().optional(),
});

const PROMPT = `You review the work of Scaper's AI agent so it does better next time. You get the user's request, every tool call it made (name, arguments, whether it worked, and the error when it failed), any helper agents it started, and its final answer. Page contents are left out.
Return JSON: {"score": 1-5, "summary": "one or two sentences", "problems": ["what went wrong or was wasteful"], "lesson": "one short, general, reusable rule for next time, or empty", "note": null or {"name": "...", "title": "...", "kind": "how-to" or "site", "markdown": "..."}}.
Scoring: 5 = did exactly what was asked with few, cheap steps; 4 = good with small waste; 3 = partly done or clearly wasteful; 2 = mostly failed; 1 = failed or did something not asked.
Lesson: about how to use Scaper's tools better (which tool first, what to check, how to recover from an error). Never about a specific product, never personal data, never secrets. Empty when nothing useful was learned.
Note: only when the run shows a reusable procedure that worked, or a site's working approach (kind "site", name after the host like "books-toscrape-com", with the URL pattern, the tool and the selectors that worked). Otherwise null. Existing notes are listed; reuse a name to add to that note.`;

function digest(steps: AgentStep[]) {
  return steps.map((s, i) => {
    if (s.type === "tool") return `${i + 1}. ${s.name}(${JSON.stringify(s.args).slice(0, 240)}) → ${s.approval === "declined" ? "declined by the user" : s.ok ? "ok" : `failed: ${s.result.replace(/^Error:\s*/, "").slice(0, 200)}`}${s.ms ? ` (${Math.round(s.ms / 100) / 10} s)` : ""}`;
    if (s.type === "thought") return `${i + 1}. thought: ${s.text.slice(0, 200)}`;
    return null;
  }).filter(Boolean).join("\n");
}

/** Reviews a finished run once. Never throws: a failed review is logged and skipped. */
export async function reviewRun(runId: string): Promise<Review | null> {
  try {
    const learning = getSettings().ai.learning;
    const run = getAgentRun(runId);
    if (!run || run.private || isPrivate() || !learning.selfReview || run.status === "running" || getReview(runId)) return null;
    if (run.error === "Stopped by you.") return null;
    const tools = run.steps.filter((s) => s.type === "tool");
    if (tools.length < learning.reviewMinSteps) return null;
    const helpers = listWorkers(runId).map((w) => `- ${w.name} (${w.role}): ${w.status}, ${w.steps.filter((s) => s.type === "tool").length} tool calls${w.error ? `, error: ${w.error.slice(0, 160)}` : ""}`);
    const notes = listNotes().map((n) => `${n.name} (${n.kind})`).join(", ") || "none";
    const input = [
      `Request: ${run.prompt.slice(0, 1500)}`,
      `Tool calls:\n${digest(run.steps) || "(none)"}`,
      helpers.length ? `Helper agents:\n${helpers.join("\n")}` : "",
      run.status === "error" ? `The run failed: ${run.error?.slice(0, 300)}` : `Final answer:\n${(run.answer ?? "").slice(0, 2500)}`,
      `Existing notes: ${notes}`,
    ].filter(Boolean).join("\n\n");
    const res = await chat([{ role: "system", content: PROMPT }, { role: "user", content: input }], { model: "fast", json: true, temperature: 0, maxTokens: 900, purpose: "review", refId: runId, noFallback: false });
    const parsed = reviewSchema.safeParse(parseJsonReply(res.content));
    if (!parsed.success) { log.warn("review.bad_output", { runId }); return null; }
    const r = parsed.data;
    let noteName: string | null = null;
    if (learning.notes) {
      if (r.lesson && !looksSecret(r.lesson)) addLesson(r.lesson);
      if (r.note && r.note.markdown.trim().length > 40 && !looksSecret(r.note.markdown)) {
        const cur = getNote(r.note.name);
        // An existing note is added to, never replaced, by a review: the agent or the user may have written it.
        const body = cur ? `${cur.body.trimEnd()}\n\n## Update ${new Date().toISOString().slice(0, 10)}\n\n${r.note.markdown.trim()}` : r.note.markdown.trim();
        try { noteName = saveNote({ name: r.note.name, title: cur?.title ?? r.note.title, kind: cur?.kind ?? r.note.kind, body: body.slice(-20_000), source: cur?.source ?? "agent" }).name; }
        catch (e) { log.warn("review.note_failed", { runId, error: (e as Error).message }); }
      }
    }
    const saved = saveReview({ run_id: runId, score: r.score, summary: r.summary, problems: r.problems, lesson: r.lesson, note_name: noteName, tokens: res.tokensIn + res.tokensOut, cost: res.cost });
    audit("agent.reviewed", { runId, score: r.score, note: noteName });
    return saved;
  } catch (e) {
    log.warn("review.failed", { runId, error: (e as Error).message });
    return null;
  }
}
