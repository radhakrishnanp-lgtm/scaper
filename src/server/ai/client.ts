import "server-only";
import { createHash } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { aiModelSchema, type AiModel, type AiProvider, type ModelRef } from "@/lib/schemas";
import { dispatcherFor } from "../fetcher/http";
import { log } from "../log";
import { isPrivate, workContext } from "../privacy";
import { addAiUsage, aiCostThisMonth, aiUsageToday } from "../repo/agent";
import { cachedAiResponse, recordAiCall, storeAiResponse } from "../repo/ai";
import { getSettings } from "../repo/settings";

export class AiError extends Error {
  constructor(public code: "not_configured" | "quota" | "upstream" | "timeout" | "bad_output", message: string) {
    super(message);
    this.name = "AiError";
  }
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string().default(() => `call_${Math.random().toString(36).slice(2, 10)}`),
        type: z.literal("function").default("function"),
        function: z.object({ name: z.string(), arguments: z.string().default("{}") }),
      })).optional().nullable(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).partial().optional().nullable(),
});

/** "main" and "fast" are the two roles set in Settings → AI; a ModelRef names any saved model directly. */
export type ModelChoice = "main" | "fast" | ModelRef;
export type ResolvedModel = { provider: AiProvider; model: string; info: AiModel };

export function resolveModel(choice: ModelChoice = "main", ai = getSettings().ai): ResolvedModel | null {
  const set = (r: ModelRef) => Boolean(r.providerId && r.model);
  const ref = typeof choice === "object" ? choice : choice === "fast" ? (set(ai.fast) ? ai.fast : ai.main) : set(ai.main) ? ai.main : ai.fast;
  const provider = ai.providers.find((p) => p.id === ref.providerId);
  if (!provider || !provider.enabled || !ref.model) return null;
  return { provider, model: ref.model, info: provider.models.find((m) => m.id === ref.model) ?? aiModelSchema.parse({ id: ref.model }) };
}

/** Reads the agent's model picker value: "main", "fast" or "<providerId>::<model>". */
export function parseModelChoice(value: string | null | undefined, useFast = false): ModelChoice {
  if (value === "main" || value === "fast") return value;
  const i = value ? value.indexOf("::") : -1;
  if (value && i > 0) return { providerId: value.slice(0, i), model: value.slice(i + 2) };
  return useFast ? "fast" : "main";
}

export function aiConfig(choice: ModelChoice = "main") {
  const ai = getSettings().ai;
  const r = resolveModel(choice, ai);
  return { ...ai, resolvedModel: r?.model ?? "", providerName: r?.provider.name ?? "", configured: Boolean(r), contextWindow: r?.info.contextWindow ?? null };
}

/** How many tokens of page text to send: most of the model's window, leaving room for the prompt and the answer. */
export function contextBudget(choice: ModelChoice = "main") {
  const ai = getSettings().ai;
  const window = resolveModel(choice, ai)?.info.contextWindow;
  if (!window) return ai.contextTokens;
  return Math.max(1500, Math.min(Math.floor(window * 0.6) - ai.maxTokens, 400_000));
}

/** Accepts a base URL (…/v1) or a full endpoint (…/chat/completions?api-version=…) and points it at `path`. */
export function endpointUrl(baseUrl: string, path: "chat/completions" | "models") {
  const u = new URL(baseUrl);
  const base = u.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "");
  u.pathname = `${base}/${path}`;
  return u.toString();
}

export function providerHeaders(p: Pick<AiProvider, "apiKey" | "auth" | "headers">): Record<string, string> {
  const h: Record<string, string> = {};
  if (p.apiKey && p.auth === "bearer") h.authorization = `Bearer ${p.apiKey}`;
  if (p.apiKey && p.auth === "api-key") h["api-key"] = p.apiKey;
  for (const x of p.headers) if (x.value) h[x.name] = x.value;
  return h;
}

export const costOf = (info: AiModel, tokensIn: number, tokensOut: number) => (tokensIn * info.inputPrice + tokensOut * info.outputPrice) / 1_000_000;
export const modelLabel = (r: Pick<ResolvedModel, "provider" | "model">) => `${r.provider.name} · ${r.model}`;

export type ChatOptions = {
  model?: ModelChoice; tools?: ToolDef[]; json?: boolean; maxTokens?: number; temperature?: number;
  /** What the call is for, shown in the AI log ("extract", "agent", "plan" ...). Defaults to the surrounding work. */
  purpose?: string; refId?: string | null;
  /** Allow an identical earlier answer to be reused (Settings → AI → cache). */
  cache?: boolean;
  signal?: AbortSignal;
  /** Capability tests must hit exactly the model asked for. */
  noFallback?: boolean;
};

export type ChatResult = {
  content: string; toolCalls: ToolCall[]; tokensIn: number; tokensOut: number; model: string; providerName: string;
  cost: number; latencyMs: number; cached: boolean; fallbackFrom: string | null; truncated: boolean;
};

type Attempt = Pick<ChatResult, "content" | "toolCalls" | "tokensIn" | "tokensOut" | "truncated"> & { attempts: number };

/**
 * One request to an OpenAI-compatible Chat Completions API (OpenAI, Azure, OpenRouter, Groq, Together, Gemini,
 * Mistral, DeepSeek, xAI, Ollama, LM Studio, vLLM, LiteLLM ...). Retries rate limits and server errors with
 * backoff (honouring Retry-After), and adapts to providers that reject some parameters.
 */
export async function callModel(r: ResolvedModel, messages: ChatMessage[], opts: ChatOptions, defaults: { maxTokens: number; temperature: number }): Promise<Attempt> {
  const body: Record<string, unknown> = {
    model: r.model,
    messages,
    max_tokens: opts.maxTokens ?? defaults.maxTokens,
    temperature: opts.temperature ?? defaults.temperature,
  };
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = "auto"; }
  if (opts.json && r.info.json !== false) body.response_format = { type: "json_object" };

  let lastError = "";
  let lastCode: AiError["code"] = "upstream";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(r.provider.timeoutSeconds * 1000)]) : AbortSignal.timeout(r.provider.timeoutSeconds * 1000);
    let res;
    try {
      res = await undiciFetch(endpointUrl(r.provider.baseUrl, "chat/completions"), {
        method: "POST",
        dispatcher: dispatcherFor(""),
        signal,
        headers: { "content-type": "application/json", ...providerHeaders(r.provider) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = e as Error;
      if (opts.signal?.aborted) throw new AiError("timeout", "Cancelled.");
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new AiError("timeout", `${r.provider.name} did not answer within ${r.provider.timeoutSeconds}s.`);
      lastError = `Could not reach ${r.provider.name}: ${(err.cause as Error | undefined)?.message ?? err.message}`;
      if (attempt < 3) { await sleep(1000 * attempt); continue; }
      break;
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastError = `${r.provider.name} answered ${res.status}: ${text.slice(0, 200)}`;
      if (attempt < 3) { await sleep(retryAfterMs(res.headers.get("retry-after")) ?? 1500 * 2 ** (attempt - 1)); continue; }
      break;
    }
    if (!res.ok) {
      // Providers differ in what they accept; drop the parameter they complain about and try again.
      if (res.status === 400 || res.status === 422) {
        if (body.response_format && /response_format|json_object|json mode/i.test(text)) { delete body.response_format; continue; }
        if ("max_tokens" in body && /max_completion_tokens/i.test(text)) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue; }
        if ("temperature" in body && /temperature/i.test(text) && /support|unsupported|only the default/i.test(text)) { delete body.temperature; continue; }
      }
      lastCode = "upstream";
      if (res.status === 401 || res.status === 403) lastError = `${r.provider.name} refused the API key (${res.status}). Check the key in Settings → AI.`;
      else if (res.status === 404) lastError = `${r.provider.name} does not know the model "${r.model}" or the URL is wrong (404). ${text.slice(0, 160)}`;
      else if (opts.tools?.length && /tool|function/i.test(text)) lastError = `${r.provider.name} rejected tool calling for "${r.model}" (${res.status}): ${text.slice(0, 200)}. Pick a model that supports tools.`;
      else lastError = `${r.provider.name} error ${res.status}: ${text.slice(0, 300)}`;
      throw new AiError(lastCode, lastError);
    }
    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(text));
    } catch {
      throw new AiError("bad_output", `${r.provider.name} returned a response Scaper could not read. Check the base URL points to an OpenAI-compatible API.`);
    }
    const choice = parsed.choices[0]!;
    return {
      content: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []) as ToolCall[],
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
      truncated: choice.finish_reason === "length",
      attempts: attempt,
    };
  }
  throw new AiError(lastCode, lastError || `${r.provider.name} failed after several attempts.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function retryAfterMs(h: string | null) {
  if (!h) return null;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 20_000) : null;
}

/** The model call everything goes through: limits, budget, fallbacks, cost, cache and the AI log. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const ai = getSettings().ai;
  const primary = resolveModel(opts.model ?? "main", ai);
  if (!primary) throw new AiError("not_configured", "Add an AI provider and choose a model in Settings → AI first.");
  if (aiUsageToday().requests >= ai.dailyRequestLimit) {
    throw new AiError("quota", `Daily AI limit reached (${ai.dailyRequestLimit} requests). Raise it in Settings → AI or try again tomorrow.`);
  }
  if (ai.monthlyBudget > 0) {
    const spent = aiCostThisMonth().c;
    if (spent >= ai.monthlyBudget) throw new AiError("quota", `Monthly AI budget reached ($${spent.toFixed(2)} of $${ai.monthlyBudget}). Raise it in Settings → AI.`);
  }
  const ctx = workContext();
  const priv = isPrivate();
  const purpose = opts.purpose ?? ctx.purpose ?? "other";
  const refId = opts.refId ?? ctx.refId ?? null;

  const candidates: ResolvedModel[] = [primary];
  if (!opts.noFallback) {
    for (const ref of ai.fallbacks) {
      const r = resolveModel(ref, ai);
      if (r && !candidates.some((c) => c.provider.id === r.provider.id && c.model === r.model)) candidates.push(r);
    }
  }
  const usable = candidates.filter((c) => !(opts.tools?.length && c.info.tools === false));
  if (!usable.length) throw new AiError("not_configured", `"${primary.model}" cannot call tools (its capability test said so). Choose another model for the agent in Settings → AI.`);

  const logged = (r: ResolvedModel) => ({ purpose, ref_id: refId, provider_id: r.provider.id, provider_name: r.provider.name, model: r.model });
  const requestText = ai.logPrompts ? JSON.stringify({ messages, tools: opts.tools?.map((t) => t.function.name), json: Boolean(opts.json) }) : null;

  const cacheKey = opts.cache && ai.cacheHours > 0 && !priv && !opts.tools?.length
    ? createHash("sha256").update(JSON.stringify([primary.provider.id, primary.model, messages, Boolean(opts.json), opts.temperature ?? ai.temperature])).digest("hex")
    : null;
  if (cacheKey) {
    const hit = cachedAiResponse(cacheKey, ai.cacheHours);
    if (hit) {
      const prev = JSON.parse(hit) as Pick<ChatResult, "content" | "toolCalls" | "tokensIn" | "tokensOut">;
      recordAiCall({ ...logged(primary), status: "cached", tokens_in: 0, tokens_out: 0, cost: 0, latency_ms: 0, attempts: 0, fallback_from: null, error: null, request: requestText, response: ai.logPrompts ? prev.content : null });
      return { ...prev, tokensIn: 0, tokensOut: 0, model: primary.model, providerName: primary.provider.name, cost: 0, latencyMs: 0, cached: true, fallbackFrom: null, truncated: false };
    }
  }

  let lastErr: AiError | null = null;
  for (const [i, c] of usable.entries()) {
    const started = Date.now();
    try {
      const r = await callModel(c, messages, opts, ai);
      const cost = costOf(c.info, r.tokensIn, r.tokensOut);
      const latencyMs = Date.now() - started;
      addAiUsage(r.tokensIn, r.tokensOut, cost);
      const fallbackFrom = i ? modelLabel(usable[0]!) : null;
      if (!priv) {
        recordAiCall({
          ...logged(c), status: "ok", tokens_in: r.tokensIn, tokens_out: r.tokensOut, cost, latency_ms: latencyMs, attempts: r.attempts, fallback_from: fallbackFrom, error: null,
          request: requestText, response: ai.logPrompts ? JSON.stringify({ content: r.content, tool_calls: r.toolCalls.length ? r.toolCalls : undefined, truncated: r.truncated || undefined }) : null,
        });
      }
      if (cacheKey && !r.toolCalls.length) storeAiResponse(cacheKey, JSON.stringify({ content: r.content, toolCalls: [], tokensIn: r.tokensIn, tokensOut: r.tokensOut }));
      log.info("ai.call", { model: c.model, provider: c.provider.name, purpose, usageIn: r.tokensIn, usageOut: r.tokensOut, ms: latencyMs, fallback: Boolean(fallbackFrom) });
      return { ...r, model: c.model, providerName: c.provider.name, cost, latencyMs, cached: false, fallbackFrom };
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError("upstream", (e as Error).message);
      if (!priv) recordAiCall({ ...logged(c), status: "error", tokens_in: 0, tokens_out: 0, cost: 0, latency_ms: Date.now() - started, attempts: 1, fallback_from: i ? modelLabel(usable[0]!) : null, error: err.message, request: requestText, response: null });
      lastErr = err;
      // Only outages move on to the next model; a bad answer or a cancelled request does not.
      if (!(err.code === "upstream" || err.code === "timeout") || opts.signal?.aborted) throw err;
      if (i < usable.length - 1) log.warn("ai.fallback", { from: modelLabel(c), to: modelLabel(usable[i + 1]!), error: err.message });
    }
  }
  throw lastErr ?? new AiError("upstream", "The AI request failed.");
}

/** Pulls the first JSON object or array out of a model reply (models often wrap JSON in prose or code fences). */
export function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new AiError("bad_output", "The AI reply did not contain JSON.");
    const open = candidate[start];
    const end = candidate.lastIndexOf(open === "[" ? "]" : "}");
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new AiError("bad_output", "The AI reply contained broken JSON.");
    }
  }
}

const modelListSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    context_length: z.number().optional().nullable(),
    context_window: z.number().optional().nullable(),
    pricing: z.object({ prompt: z.union([z.string(), z.number()]).optional(), completion: z.union([z.string(), z.number()]).optional() }).partial().optional().nullable(),
  }).passthrough()).default([]),
}).passthrough();

/** Lists a provider's models via GET /models, with context size and prices when the provider reports them (OpenRouter does). */
export async function listProviderModels(p: AiProvider): Promise<AiModel[]> {
  let res;
  try {
    res = await undiciFetch(endpointUrl(p.baseUrl, "models"), { dispatcher: dispatcherFor(""), signal: AbortSignal.timeout(20_000), headers: providerHeaders(p) });
  } catch (e) {
    throw new AiError("upstream", `Could not reach ${p.name}: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new AiError("upstream", res.status === 401 || res.status === 403 ? `${p.name} refused the API key (${res.status}).` : `${p.name} answered ${res.status} for the model list: ${text.slice(0, 200)}`);
  let parsed;
  try { parsed = modelListSchema.parse(JSON.parse(text)); } catch { throw new AiError("bad_output", `${p.name} returned a model list Scaper could not read.`); }
  const perMillion = (v: string | number | undefined) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : 0; };
  return parsed.data.slice(0, 2000).map((m) => aiModelSchema.parse({
    id: m.id.slice(0, 200),
    contextWindow: m.context_length ?? m.context_window ?? null,
    inputPrice: perMillion(m.pricing?.prompt),
    outputPrice: perMillion(m.pricing?.completion),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Capability test: a plain reply, JSON mode and tool calling, each against exactly this model. */
export async function testModel(r: ResolvedModel) {
  const ai = getSettings().ai;
  const started = Date.now();
  const base = await callModel(r, [{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 16, temperature: 0 }, ai);
  const latencyMs = Date.now() - started;
  const notes: string[] = [];
  let json = false;
  try {
    const j = await callModel({ ...r, info: { ...r.info, json: null } }, [{ role: "user", content: 'Reply with this JSON object only: {"ok": true}' }], { json: true, maxTokens: 30, temperature: 0 }, ai);
    json = (parseJsonReply(j.content) as { ok?: unknown })?.ok === true;
  } catch (e) { notes.push(`JSON: ${(e as Error).message}`); }
  // true: it called the tool. false: the provider refused tool calling. null: it answered without the tool (may still work).
  let tools: boolean | null = false;
  try {
    const t = await callModel(r, [{ role: "user", content: "What time is it? Use the get_time tool." }], {
      maxTokens: 60, temperature: 0,
      tools: [{ type: "function", function: { name: "get_time", description: "Returns the current time.", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    }, ai);
    tools = t.toolCalls.some((c) => c.function.name === "get_time") ? true : null;
    if (!tools) notes.push("The model answered without calling the test tool, so the agent may not work well with it.");
  } catch (e) { notes.push(`Tools: ${(e as Error).message}`); }
  addAiUsage(base.tokensIn, base.tokensOut, costOf(r.info, base.tokensIn, base.tokensOut));
  return { reply: base.content.trim().slice(0, 100), latencyMs, json, tools, notes };
}
