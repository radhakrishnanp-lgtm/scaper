import "server-only";
import { randomUUID } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { decisionsUrl, isDecisionsModel, isDecisionsUrl, splitDecisions } from "@/lib/decisions-url";
import type { AiProvider, DecisionSettings } from "@/lib/schemas";
import { log } from "../log";
import { isPrivate, workContext } from "../privacy";
import { addAiUsage, aiCostThisMonth, aiUsageToday } from "../repo/agent";
import { recordAiCall } from "../repo/ai";
import { getSettings } from "../repo/settings";
import { AiError, aiDispatcher, providerHeaders } from "./client";

/**
 * Client for the OpenRouter Decisions API (POST …/api/alpha/decisions). A decision model reads `state` and
 * answers named questions with probabilities instead of text:
 *   noul   — probability that a condition holds            → { noul }
 *   choice — one option from a set                         → { choice, probabilities, confidence }
 *   score  — a position on an ordered rubric (index 0 = low) → { score, probabilities, confidence, legend }
 * Field names follow OpenRouter's docs (Oct 2026). Everything provider-specific stays in this file.
 */

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number | null; legend: Record<string, string> | null };

export type DecisionResult = {
  id: string; requestId: string; model: string; provider: string | null;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number; cost: number } ;
  latencyMs: number;
};

export const MAX_QUESTIONS = 200;
const MAX_STATE_CHARS = 400_000;

const nameSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z][\w-]*$/, "Question names use letters, numbers, _ and -, starting with a letter");
export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"), instructions: z.string().trim().min(1, "Instructions are required").max(4000),
    criteria: z.object({ true: z.string().trim().min(1).max(2000), false: z.string().trim().min(1).max(2000) }).optional(),
  }),
  z.object({
    type: z.literal("choice"), instructions: z.string().trim().min(1, "Instructions are required").max(4000),
    criteria: z.record(nameSchema, z.string().max(2000).nullable()).refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 50, "Give 2 to 50 options"),
  }),
  z.object({
    type: z.literal("score"), instructions: z.string().trim().min(1, "Instructions are required").max(4000),
    criteria: z.array(z.string().trim().min(1).max(2000)).min(2, "Give at least 2 levels").max(20),
  }),
]);
export const questionsSchema = z.record(nameSchema, questionSchema).refine((q) => Object.keys(q).length >= 1, "Ask at least one question").refine((q) => Object.keys(q).length <= MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions per request`);
export const stateSchema = z.union([z.string().max(MAX_STATE_CHARS), z.record(z.string(), z.unknown()), z.array(z.unknown()).max(200)])
  .refine((s) => (typeof s === "string" ? s.trim().length > 0 : JSON.stringify(s).length > 2), "The state is empty")
  .refine((s) => (typeof s === "string" ? s : JSON.stringify(s)).length <= MAX_STATE_CHARS, "The state is too large (400 000 characters at most)");

const prob = z.coerce.number().min(0).max(1);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: prob }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), prob).default({}), confidence: z.coerce.number().nullable().optional() }),
  z.object({
    type: z.literal("score"), score: z.coerce.number(), probabilities: z.record(z.string(), prob).default({}), confidence: z.coerce.number().nullable().optional(),
    legend: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
]);
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().nullable().optional(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.coerce.number().optional(), output_tokens: z.coerce.number().optional(), cost: z.coerce.number().optional() }).partial().nullable().optional(),
});

export { decisionsUrl };

export type DecisionsTarget = { provider: AiProvider; model: string; url: string; settings: DecisionSettings };

/** The configured decision model, or null when it is off or its provider is missing. */
export function decisionsTarget(opts: { evenIfOff?: boolean } = {}): DecisionsTarget | null {
  const ai = getSettings().ai;
  const d = ai.decisions;
  if (!d.enabled && !opts.evenIfOff) return null;
  const provider = ai.providers.find((p) => p.id === d.providerId) ?? ai.providers.find((p) => /openrouter\.ai/i.test(p.baseUrl));
  if (!provider || !provider.enabled || !d.model) return null;
  return { provider, model: d.model, url: d.url || decisionsUrl(provider.baseUrl), settings: d };
}

export const decisionsReady = () => Boolean(decisionsTarget());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One decision request: shared daily limit and monthly budget, retries for 429/5xx/network only,
 * a validated response, cost and the AI log (nothing is logged in private mode).
 */
export async function decide(input: {
  state: unknown; questions: Record<string, DecisionQuestion>; purpose: string; refId?: string | null; signal?: AbortSignal; evenIfOff?: boolean;
  /** A provider that is not saved yet (the provider form's test). */
  target?: DecisionsTarget;
}): Promise<DecisionResult> {
  const t = input.target ?? decisionsTarget({ evenIfOff: input.evenIfOff });
  if (!t) throw new AiError("not_configured", "Turn on the decision model in Settings → AI and pick the provider that holds your OpenRouter key.");
  const state = stateSchema.parse(input.state);
  const questions = questionsSchema.parse(input.questions);
  const ai = getSettings().ai;
  if (aiUsageToday().requests >= ai.dailyRequestLimit) throw new AiError("quota", `Daily AI limit reached (${ai.dailyRequestLimit} requests). Raise it in Settings → AI or try again tomorrow.`);
  if (ai.monthlyBudget > 0 && aiCostThisMonth().c >= ai.monthlyBudget) throw new AiError("quota", `Monthly AI budget reached ($${ai.monthlyBudget}). Raise it in Settings → AI.`);

  const priv = isPrivate();
  const ctx = workContext();
  const purpose = `decide:${input.purpose}`;
  const refId = input.refId ?? ctx.refId ?? null;
  const requestId = randomUUID();
  const body = JSON.stringify({ model: t.model, state, questions });
  const started = Date.now();
  const logged = { purpose, ref_id: refId, provider_id: t.provider.id, provider_name: t.provider.name, model: t.model };
  const fail = (code: AiError["code"], message: string, attempts: number) => {
    if (!priv) recordAiCall({ ...logged, status: "error", tokens_in: 0, tokens_out: 0, cost: 0, latency_ms: Date.now() - started, attempts, fallback_from: null, error: message, request: ai.logPrompts ? body.slice(0, 200_000) : null, response: null });
    return new AiError(code, message);
  };

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const timeout = AbortSignal.timeout(t.provider.timeoutSeconds * 1000);
    let res;
    try {
      res = await undiciFetch(t.url, {
        method: "POST",
        dispatcher: aiDispatcher(),
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
        headers: { "content-type": "application/json", "x-title": "Scaper", ...providerHeaders(t.provider) },
        body,
      });
    } catch (e) {
      const err = e as Error;
      if (input.signal?.aborted) throw new AiError("timeout", "Cancelled.");
      if (err.name === "TimeoutError" || err.name === "AbortError") throw fail("timeout", `The decision model did not answer within ${t.provider.timeoutSeconds}s.`, attempt);
      lastError = `Could not reach ${t.provider.name}: ${(err.cause as Error | undefined)?.message ?? err.message}`;
      if (attempt < 3) { await sleep(800 * attempt); continue; }
      throw fail("upstream", lastError, attempt);
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastError = `${t.provider.name} answered ${res.status}${res.status === 429 ? " (rate limit)" : ""}.`;
      if (attempt < 3) { await sleep(1200 * 2 ** (attempt - 1)); continue; }
      throw fail("upstream", lastError, attempt);
    }
    if (!res.ok) {
      const detail = text.slice(0, 240);
      const msg = res.status === 401 || res.status === 403 ? `${t.provider.name} refused the key (${res.status}). Check it in Settings → AI.`
        : res.status === 402 ? `${t.provider.name} says the account has no credit left (402).`
        : res.status === 404 ? `The decisions endpoint or model "${t.model}" was not found (404). Check the model id and endpoint in Settings → AI. ${detail}`
        : res.status === 413 ? "The page was too large for the decision model (413)."
        : `${t.provider.name} rejected the decision request (${res.status}): ${detail}`;
      throw fail("upstream", msg, attempt);
    }
    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(text));
    } catch {
      throw fail("bad_output", "The decision model returned an answer Scaper could not read. Check the endpoint points to the Decisions API.", attempt);
    }
    const missing = Object.keys(questions).filter((k) => !parsed.answers[k]);
    if (missing.length === Object.keys(questions).length) throw fail("bad_output", "The decision model did not answer any of the questions.", attempt);
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    const cost = parsed.usage?.cost ?? (inputTokens * t.settings.inputPrice) / 1_000_000;
    const latencyMs = Date.now() - started;
    addAiUsage(inputTokens, outputTokens, cost);
    if (!priv) {
      recordAiCall({
        ...logged, status: "ok", tokens_in: inputTokens, tokens_out: outputTokens, cost, latency_ms: latencyMs, attempts: attempt, fallback_from: null, error: null,
        request: ai.logPrompts ? body.slice(0, 200_000) : null, response: ai.logPrompts ? JSON.stringify(parsed.answers).slice(0, 200_000) : null,
      });
    }
    log.info("ai.decide", { model: t.model, purpose, questions: Object.keys(questions).length, ms: latencyMs, usageIn: inputTokens });
    const answers: Record<string, DecisionAnswer> = {};
    for (const [k, a] of Object.entries(parsed.answers)) {
      if (!(k in questions)) continue;
      answers[k] = a.type === "noul" ? a
        : a.type === "choice" ? { ...a, confidence: a.confidence ?? null }
        : { ...a, confidence: a.confidence ?? null, legend: a.legend ? Object.fromEntries(Object.entries(a.legend).map(([i, v]) => [i, typeof v === "string" ? v : JSON.stringify(v)])) : null };
    }
    return { id: parsed.id ?? requestId, requestId, model: parsed.model ?? t.model, provider: parsed.provider ?? null, answers, usage: { inputTokens, outputTokens, cost }, latencyMs };
  }
  throw fail("upstream", lastError || "The decision request failed.", 3);
}

/** Probability that a noul answer is "yes", or null when the model skipped it. */
export const yes = (r: DecisionResult, name: string) => {
  const a = r.answers[name];
  return a?.type === "noul" ? a.noul : null;
};

/**
 * "Test connection" for a provider that points at the Decisions API (or holds a decisions model): one yes/no
 * question against the endpoint, shaped like a chat provider's check so the form shows it the same way.
 */
export async function checkDecisionsConnection(p: AiProvider, wanted?: string) {
  const split = splitDecisions(p);
  const model = (wanted && isDecisionsModel(wanted) ? wanted : split.decisions?.model) || getSettings().ai.decisions.model || "openai/gpt-6-luna-decisions";
  const url = isDecisionsUrl(p.baseUrl) ? decisionsUrl(p.baseUrl) : decisionsUrl(split.provider.baseUrl);
  const steps: { label: string; ok: boolean; detail: string }[] = [
    { label: "Decisions API", ok: true, detail: `Sending a test question to ${url}. It has no model list or chat, so those checks are skipped.` },
  ];
  const target: DecisionsTarget = { provider: p, model, url, settings: getSettings().ai.decisions };
  try {
    const r = await decide({
      target, purpose: "provider-check",
      state: "Customer message: My order arrived broken and I need a replacement before Friday.",
      questions: { urgent: { type: "noul", instructions: "Is the customer asking for something time-sensitive?", criteria: { true: "They mention a deadline or urgency", false: "No time pressure" } } },
    });
    const urgent = yes(r, "urgent");
    steps.push({ label: "Model answer", ok: true, detail: `${r.model} answered a test question (yes ${urgent === null ? "not answered" : `${Math.round(urgent * 100)}%`}) in ${(r.latencyMs / 1000).toFixed(1)} s.` });
    return { ok: true, steps, models: [], model, latencyMs: r.latencyMs, tools: null, json: null, decisions: { model, url } };
  } catch (e) {
    steps.push({ label: "Model answer", ok: false, detail: (e as Error).message });
    return { ok: false, steps, models: [], model, latencyMs: null, tools: null, json: null, decisions: { model, url } };
  }
}
