import "server-only";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { dispatcherFor } from "../fetcher/http";
import { log } from "../log";
import { addAiUsage, aiUsageToday } from "../repo/agent";
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
        id: z.string(),
        type: z.literal("function").default("function"),
        function: z.object({ name: z.string(), arguments: z.string().default("{}") }),
      })).optional().nullable(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).partial().optional().nullable(),
});

export type ModelChoice = "main" | "fast";

export function aiConfig(choice: ModelChoice = "main") {
  const ai = getSettings().ai;
  const model = choice === "fast" ? ai.fastModel || ai.model : ai.model || ai.fastModel;
  return { ...ai, resolvedModel: model, configured: Boolean(ai.baseUrl && model) };
}

function endpoint(baseUrl: string) {
  const b = baseUrl.replace(/\/+$/, "");
  return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
}

/**
 * One call to any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter,
 * Groq, Together, Ollama, LM Studio, vLLM ...). Enforces the daily request cap,
 * a timeout, and two retries on rate limits or server errors.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { model?: ModelChoice; tools?: ToolDef[]; json?: boolean; maxTokens?: number; temperature?: number } = {},
) {
  const cfg = aiConfig(opts.model ?? "main");
  if (!cfg.configured) throw new AiError("not_configured", "Add your AI provider's base URL and model in Settings → AI first.");
  const usage = aiUsageToday();
  if (usage.requests >= cfg.dailyRequestLimit) {
    throw new AiError("quota", `Daily AI limit reached (${cfg.dailyRequestLimit} requests). Raise it in Settings → AI or try again tomorrow.`);
  }

  const body: Record<string, unknown> = {
    model: cfg.resolvedModel,
    messages,
    max_tokens: Math.min(opts.maxTokens ?? cfg.maxTokens, cfg.maxTokens),
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = "auto"; }
  if (opts.json) body.response_format = { type: "json_object" };

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await undiciFetch(endpoint(cfg.baseUrl), {
        method: "POST",
        dispatcher: dispatcherFor(""),
        signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") throw new AiError("timeout", "The AI provider did not answer within 2 minutes.");
      lastError = `Could not reach the AI provider: ${(err.cause as Error | undefined)?.message ?? err.message}`;
      continue;
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) { lastError = `AI provider error ${res.status}: ${text.slice(0, 200)}`; continue; }
    if (!res.ok) {
      // Some local servers reject response_format; retry once without it.
      if (opts.json && res.status === 400 && /response_format/i.test(text) && body.response_format) {
        delete body.response_format;
        continue;
      }
      throw new AiError("upstream", `AI provider error ${res.status}: ${text.slice(0, 300)}`);
    }
    let parsed;
    try {
      parsed = responseSchema.parse(JSON.parse(text));
    } catch {
      throw new AiError("bad_output", "The AI provider returned a response Scaper could not read. Check the base URL points to an OpenAI-compatible API.");
    }
    const tokensIn = parsed.usage?.prompt_tokens ?? 0;
    const tokensOut = parsed.usage?.completion_tokens ?? 0;
    addAiUsage(tokensIn + tokensOut);
    log.info("ai.call", { model: cfg.resolvedModel, tokensIn, tokensOut, tools: opts.tools?.length ?? 0 });
    const choice = parsed.choices[0]!;
    return {
      content: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []) as ToolCall[],
      tokensIn, tokensOut, model: cfg.resolvedModel,
    };
  }
  throw new AiError("upstream", lastError || "The AI provider failed after 3 attempts.");
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
