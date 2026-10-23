/**
 * Turning decision-model probabilities into outcomes. This is plain code on purpose: thresholds are app policy,
 * hard rules always win, and the model can only make Scaper more careful, never less.
 */

export type DecisionQuestionShape =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswerShape =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number | null; legend: Record<string, string> | null };

export type ReadLine = {
  name: string; type: DecisionQuestionShape["type"];
  /** "yes" / "no" for noul, the option for choice, the level for score; "unsure" when below the threshold. */
  verdict: string; sure: boolean;
  /** The probability compared with the threshold. */
  p: number | null;
  detail: string;
};

export type ReadOutcome = { lines: ReadLine[]; outcome: "clear" | "needs_review"; reasons: string[] };

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Reads every answer against one threshold. A noul is "yes" at p ≥ t, "no" at p ≤ 1 − t, otherwise unsure. */
export function readAnswers(questions: Record<string, DecisionQuestionShape>, answers: Record<string, DecisionAnswerShape | undefined>, threshold: number): ReadOutcome {
  const t = Math.min(0.99, Math.max(0.5, threshold));
  const lines: ReadLine[] = [];
  const reasons: string[] = [];
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a || a.type !== q.type) {
      lines.push({ name, type: q.type, verdict: "no answer", sure: false, p: null, detail: "The model did not answer this question." });
      reasons.push(`${name}: no answer.`);
      continue;
    }
    if (a.type === "noul") {
      const verdict = a.noul >= t ? "yes" : a.noul <= 1 - t ? "no" : "unsure";
      const sure = verdict !== "unsure";
      lines.push({ name, type: "noul", verdict, sure, p: a.noul, detail: `${pct(a.noul)} likely yes; yes from ${pct(t)}, no at ${pct(1 - t)} or below.` });
      if (!sure) reasons.push(`${name}: ${pct(a.noul)} is between ${pct(1 - t)} and ${pct(t)}.`);
    } else if (a.type === "choice") {
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
      const p = a.probabilities[a.choice] ?? top?.[1] ?? null;
      const sure = p !== null && p >= t;
      lines.push({ name, type: "choice", verdict: sure ? a.choice : "unsure", sure, p, detail: p === null ? `Most likely "${a.choice}" (no probability returned).` : `Most likely "${a.choice}" at ${pct(p)}; needs ${pct(t)}.` });
      if (!sure) reasons.push(`${name}: the top option "${a.choice}" is ${p === null ? "unscored" : `only ${pct(p)}`}.`);
    } else {
      const levels = q.type === "score" ? q.criteria : [];
      const idx = Math.max(0, Math.min(levels.length - 1, Math.round(a.score)));
      const pTop = Math.max(0, ...Object.values(a.probabilities));
      const sure = pTop >= t;
      lines.push({ name, type: "score", verdict: levels[idx] ?? String(idx), sure, p: pTop, detail: `Score ${a.score.toFixed(2)} of ${levels.length - 1}${a.confidence !== null ? `, confidence ${pct(Math.max(0, Math.min(1, a.confidence)))}` : ""}.` });
      if (!sure) reasons.push(`${name}: spread between levels (top level ${pct(pTop)}).`);
    }
  }
  return { lines, outcome: reasons.length ? "needs_review" : "clear", reasons };
}

// ---------------------------------------------------------------------------------------------
// "Is this OK to scrape?"

export type Finding = { level: "stop" | "caution" | "ok" | "info"; source: "rule" | "ai"; text: string };
export type CheckOutcome = "ok" | "caution" | "stop";

/** Any stop wins, then any caution. AI findings are never "stop" and never cancel a rule's finding. */
export function combineFindings(findings: Finding[]): CheckOutcome {
  if (findings.some((f) => f.level === "stop")) return "stop";
  if (findings.some((f) => f.level === "caution")) return "caution";
  return "ok";
}

export type ScrapeSignals = {
  personalData?: number | null; membersOnly?: number | null; hasGoal?: number | null;
  kind?: string | null; kindP?: number | null; goal?: string;
};

/** What the decision model's answers add to a scrape check, at threshold t. Only "caution", "ok" or "info". */
export function aiScrapeFindings(s: ScrapeSignals, t: number): Finding[] {
  const f: Finding[] = [];
  const at = (p: number | null | undefined) => typeof p === "number" && p >= t;
  if (at(s.personalData)) f.push({ level: "caution", source: "ai", text: `Personal details of private people are likely on this page (${pct(s.personalData!)}). Collect only what you need, keep it private, and check the site's terms and your local privacy law.` });
  if (at(s.membersOnly)) f.push({ level: "caution", source: "ai", text: `This looks like members-only content (${pct(s.membersOnly!)}). Only scrape it with your own account and the site's permission.` });
  if (s.kind && at(s.kindP)) {
    if (s.kind === "account_area") f.push({ level: "caution", source: "ai", text: "This looks like a signed-in account area (orders, settings or messages)." });
    else if (s.kind === "checkout") f.push({ level: "caution", source: "ai", text: "This looks like a cart, checkout or payment page. Scaper should not submit anything here." });
    else if (s.kind === "login") f.push({ level: "caution", source: "ai", text: "This looks like a login or sign-up page; the data is probably behind it." });
    else if (s.kind === "error_or_block") f.push({ level: "caution", source: "ai", text: "This looks like an error or access-denied page rather than content." });
  }
  if (s.goal && typeof s.hasGoal === "number") {
    if (s.hasGoal >= t) f.push({ level: "ok", source: "ai", text: `Has what you asked for (${pct(s.hasGoal)}).` });
    else if (s.hasGoal <= 1 - t) f.push({ level: "caution", source: "ai", text: `Probably does not have "${s.goal}" (${pct(s.hasGoal)} likely). Try a category or search page instead.` });
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Agent guardrail

export type GuardSignals = { matchesRequest: number | null; narrowScope: number | null; reversible: number | null; ambiguous: number | null; needsReview: number | null };

/**
 * Whether the agent must stop and ask before an action that changes things. Deterministic rules first:
 * deleting is always asked; an unreadable check is asked. The model can then add a reason to ask, never remove one.
 */
export function guardVerdict(input: { destructive: boolean; signals: GuardSignals | null; error?: string | null }, t: number): { ask: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.destructive) reasons.push("It deletes something, which always needs your OK.");
  if (input.error) reasons.push(`The safety check could not run (${input.error}), so Scaper asks.`);
  const s = input.signals;
  if (s) {
    const low = (p: number | null) => p === null || p <= 1 - t;
    const high = (p: number | null) => p !== null && p >= t;
    if (low(s.matchesRequest)) reasons.push(`It may not be what you asked for (${s.matchesRequest === null ? "no answer" : pct(s.matchesRequest)} match).`);
    if (high(s.ambiguous)) reasons.push(`Something about it is ambiguous (${pct(s.ambiguous!)}).`);
    if (high(s.needsReview)) reasons.push(`The check thinks a person should look at it (${pct(s.needsReview!)}).`);
    if (low(s.narrowScope) && s.narrowScope !== null) reasons.push(`Its scope looks broad (${pct(s.narrowScope)} narrow).`);
    if (low(s.reversible) && s.reversible !== null && !input.destructive) reasons.push(`It may be hard to undo (${pct(s.reversible)} reversible).`);
  }
  return { ask: reasons.length > 0, reasons };
}

export const DESTRUCTIVE_TOOL = /^(delete_|remove_|clear_|purge_|untrack_|forget$)/;
