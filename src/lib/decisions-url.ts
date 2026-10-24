/**
 * OpenRouter's Decisions API (…/api/alpha/decisions) is not a Chat Completions API: it takes { model, state, questions }
 * and answers with probabilities. People paste it into the provider form anyway, so both the form and the server split
 * such a provider into a normal chat provider (…/api/v1, the same key) plus the decision model setting.
 */

/** True for a Decisions endpoint such as https://openrouter.ai/api/alpha/decisions. */
export function isDecisionsUrl(url: string) {
  try { return /\/decisions\/?$/i.test(new URL(url).pathname); } catch { return false; }
}

/** True for a decisions model id such as openai/gpt-6-luna-decisions. */
export const isDecisionsModel = (id: string) => /[-/:]decisions?$/i.test(id.trim());

/** OpenRouter's base URL (…/api/v1 or a chat endpoint) → its Decisions endpoint (…/api/alpha/decisions). */
export function decisionsUrl(baseUrl: string) {
  const u = new URL(baseUrl);
  if (isDecisionsUrl(baseUrl)) { u.search = ""; return u.toString(); }
  u.pathname = `${u.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "").replace(/\/v1$/, "")}/alpha/decisions`;
  u.search = "";
  return u.toString();
}

/** A Decisions endpoint → the chat base URL next to it (…/api/alpha/decisions → …/api/v1). */
export function chatBaseFromDecisions(url: string) {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/+$/, "").replace(/\/(alpha\/)?decisions$/i, "")}/v1`;
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

type ProviderLike = { id: string; baseUrl: string; models: { id: string }[] };

/**
 * Splits decisions parts out of a provider. Returns the provider as a chat provider and, when it held a decisions
 * endpoint or model, what the decision model setting should become. `url` is kept only when it is not the one
 * Scaper would work out from the new base URL anyway.
 */
export function splitDecisions<P extends ProviderLike>(p: P): { provider: P; decisions: { providerId: string; model: string; url: string } | null } {
  const urlIs = isDecisionsUrl(p.baseUrl);
  const model = p.models.find((m) => isDecisionsModel(m.id))?.id ?? "";
  if (!urlIs && !model) return { provider: p, decisions: null };
  let baseUrl = p.baseUrl;
  let url = "";
  if (urlIs) {
    try {
      baseUrl = chatBaseFromDecisions(p.baseUrl);
      if (decisionsUrl(baseUrl) !== decisionsUrl(p.baseUrl)) url = decisionsUrl(p.baseUrl);
    } catch { /* invalid URL: leave it for validation to report */ }
  }
  return {
    provider: { ...p, baseUrl, models: p.models.filter((m) => !isDecisionsModel(m.id)) },
    decisions: { providerId: p.id, model, url },
  };
}
