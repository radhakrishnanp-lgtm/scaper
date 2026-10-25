import "server-only";
import { db } from "../db";
import { aiModelSchema, aiProviderSchema, settingsSchema, type AiProvider, type ModelRef, type Settings } from "@/lib/schemas";
import { isDecisionsModel, splitDecisions } from "@/lib/decisions-url";
import { now, parseJson } from "./util";

const SECTIONS = ["ai", "scraping", "notifications", "data", "integrations"] as const;

type CacheEntry = { at: number; value: Settings };
const g = globalThis as unknown as { __scaperSettings?: CacheEntry | null };

/** Settings are read on every fetch, so they are cached for a second. */
export function getSettings(): Settings {
  const c = g.__scaperSettings;
  if (c && Date.now() - c.at < 1000) return c.value;
  const rows = db().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const raw: Record<string, unknown> = { ai: {}, scraping: {}, notifications: {}, data: {}, integrations: {} };
  for (const r of rows) raw[r.key] = parseJson(r.value, {});
  const parsed = settingsSchema.parse(raw);
  const value = { ...parsed, ai: withLegacyProvider(parsed.ai) };
  g.__scaperSettings = { at: Date.now(), value };
  return value;
}

type Ai = Settings["ai"];
const LEGACY_KEYS = ["baseUrl", "apiKey", "model", "fastModel"] as const;
const hostLabel = (url: string) => { try { return new URL(url).hostname.replace(/^api\./, ""); } catch { return "My provider"; } };

/** Older single-provider settings show up as a provider called "default". */
function withLegacyProvider(ai: Ai): Ai {
  if (ai.providers.length || !ai.baseUrl) return ai;
  const models = [...new Set([ai.model, ai.fastModel].filter(Boolean))].map((id) => aiModelSchema.parse({ id }));
  const provider = aiProviderSchema.parse({ id: "default", name: hostLabel(ai.baseUrl), baseUrl: ai.baseUrl, apiKey: ai.apiKey, models });
  return {
    ...ai,
    providers: [provider],
    main: ai.main.providerId ? ai.main : { providerId: "default", model: ai.model || ai.fastModel },
    fast: ai.fast.providerId ? ai.fast : { providerId: "default", model: ai.fastModel },
  };
}

/** Saving the old single-provider fields (older scripts and tests) updates the "default" provider. */
function applyLegacyPatch(ai: Ai, patch: Partial<Ai>): Ai {
  if (!LEGACY_KEYS.some((k) => k in patch) || patch.providers) return ai;
  const providers = [...ai.providers];
  let p = providers.find((x) => x.id === "default");
  const baseUrl = patch.baseUrl ?? p?.baseUrl ?? ai.baseUrl;
  if (!baseUrl) return ai;
  if (!p) { p = aiProviderSchema.parse({ id: "default", name: hostLabel(baseUrl), baseUrl }); providers.unshift(p); }
  const next: AiProvider = { ...p, baseUrl, apiKey: patch.apiKey ?? p.apiKey };
  for (const id of [patch.model, patch.fastModel]) if (id && !next.models.some((m) => m.id === id)) next.models = [...next.models, aiModelSchema.parse({ id })];
  providers[providers.indexOf(p)] = next;
  return {
    ...ai, providers,
    main: patch.model !== undefined ? { providerId: "default", model: patch.model } : ai.main.providerId ? ai.main : { providerId: "default", model: ai.model },
    fast: patch.fastModel !== undefined ? { providerId: "default", model: patch.fastModel } : ai.fast,
  };
}

/** A provider as sent by the settings form (key possibly masked), with the saved secrets filled back in. */
export function providerWithSavedSecrets(p: AiProvider): AiProvider {
  return keepProviderSecrets([aiProviderSchema.parse(p)], getSettings().ai.providers)[0]!;
}

const MASKED = /••••/;
const SECRET_HEADER = /key|token|auth|secret|password|cookie/i;

/** Provider keys and secret headers come back masked from the browser; masked means "keep the saved value". */
function keepProviderSecrets(incoming: AiProvider[], saved: AiProvider[]): AiProvider[] {
  return incoming.map((p) => {
    const old = saved.find((x) => x.id === p.id);
    return {
      ...p,
      apiKey: MASKED.test(p.apiKey) ? old?.apiKey ?? "" : p.apiKey,
      headers: p.headers.map((h) => (MASKED.test(h.value) ? { ...h, value: old?.headers.find((o) => o.name.toLowerCase() === h.name.toLowerCase())?.value ?? "" } : h)),
    };
  });
}

type Integrations = Settings["integrations"];

/** Webhook secrets come back masked from the form; masked means "keep the saved value". */
function keepIntegrationSecrets(next: Integrations, saved: Integrations): Integrations {
  return {
    ...next,
    googleServiceAccount: MASKED.test(next.googleServiceAccount) ? saved.googleServiceAccount : next.googleServiceAccount,
    firecrawlKey: MASKED.test(next.firecrawlKey) ? saved.firecrawlKey : next.firecrawlKey,
    apifyToken: MASKED.test(next.apifyToken) ? saved.apifyToken : next.apifyToken,
    webhooks: next.webhooks.map((w) => {
      const old = saved.webhooks.find((o) => o.id === w.id);
      return { ...w, secret: MASKED.test(w.secret) ? old?.secret ?? "" : w.secret, url: MASKED.test(decodeURI(w.url)) ? old?.url ?? w.url : w.url };
    }),
  };
}

/** The service account's email, so the settings page can say "share your sheet with …". */
export function serviceAccountEmail(json: string) {
  try { return String((JSON.parse(json) as { client_email?: string }).client_email ?? "") || null; } catch { return null; }
}

/**
 * A provider saved with OpenRouter's Decisions endpoint or a decisions model becomes a chat provider (…/api/v1, same key)
 * and the decision model setting, since the Decisions API cannot answer chat requests.
 */
function moveDecisionsOut(patch: Partial<Ai>, current: Ai): Partial<Ai> {
  let decisions = patch.decisions ? { ...current.decisions, ...patch.decisions } : undefined;
  const providers = (patch.providers ?? []).map((p) => {
    const split = splitDecisions(p);
    if (!split.decisions) return p;
    const d = split.decisions;
    decisions = { ...(decisions ?? current.decisions), enabled: true, providerId: d.providerId, ...(d.model ? { model: d.model } : {}), ...(d.url ? { url: d.url } : {}) };
    return split.provider;
  });
  if (!decisions) return { providers };
  const chat = (r: ModelRef) => (isDecisionsModel(r.model) ? { providerId: "", model: "" } : r);
  return {
    providers, decisions,
    main: chat(patch.main ?? current.main), fast: chat(patch.fast ?? current.fast),
    fallbacks: (patch.fallbacks ?? current.fallbacks).filter((r) => !isDecisionsModel(r.model)),
  };
}

export function saveSettings(patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>): Settings {
  const current = getSettings();
  const aiPatch = { ...patch.ai } as Partial<Ai>;
  if (aiPatch.providers) {
    aiPatch.providers = keepProviderSecrets(aiPatch.providers.map((p) => aiProviderSchema.parse(p)), current.ai.providers);
    Object.assign(aiPatch, moveDecisionsOut(aiPatch, current.ai));
  }
  const merged = settingsSchema.parse({
    ai: applyLegacyPatch({ ...current.ai, ...aiPatch }, aiPatch),
    // The proxy's password comes back masked from the form; masked means "keep the saved one".
    scraping: { ...current.scraping, ...patch.scraping, ...(patch.scraping?.proxyUrl?.includes("••••") ? { proxyUrl: current.scraping.proxyUrl } : {}) },
    notifications: { ...current.notifications, ...patch.notifications },
    data: { ...current.data, ...patch.data },
    integrations: keepIntegrationSecrets({ ...current.integrations, ...patch.integrations }, current.integrations),
  });
  const stmt = db().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  db().transaction(() => {
    for (const s of SECTIONS) stmt.run(s, JSON.stringify(merged[s]), now());
  })();
  g.__scaperSettings = null;
  return merged;
}

const mask = (v: string) => (!v ? "" : v.length > 8 ? `••••${v.slice(-4)}` : "••••");
const maskUrl = (v: string) => (v ? v.replace(/^(https?:\/\/[^/]+\/).*$/, "$1••••") : "");

/** Secrets never leave the server: the browser only sees whether they are set. */
export function publicSettings(s: Settings) {
  const n = s.notifications;
  return {
    ai: {
      ...s.ai,
      apiKey: mask(s.ai.apiKey),
      hasApiKey: Boolean(s.ai.apiKey),
      providers: s.ai.providers.map((p) => ({
        ...p,
        apiKey: mask(p.apiKey),
        hasApiKey: Boolean(p.apiKey),
        headers: p.headers.map((h) => (SECRET_HEADER.test(h.name) && h.value ? { ...h, value: mask(h.value) } : h)),
      })),
    },
    scraping: { ...s.scraping, proxyUrl: s.scraping.proxyUrl.replace(/\/\/([^@/]+)@/, "//••••@") },
    notifications: {
      ...n,
      webhookUrl: maskUrl(n.webhookUrl),
      ntfyUrl: maskUrl(n.ntfyUrl),
      telegramBotToken: mask(n.telegramBotToken),
      hasTelegramToken: Boolean(n.telegramBotToken),
      discordWebhookUrl: maskUrl(n.discordWebhookUrl),
      slackWebhookUrl: maskUrl(n.slackWebhookUrl),
      ntfyToken: mask(n.ntfyToken),
      smtpPass: n.smtpPass ? "••••••" : "",
      hasSmtpPass: Boolean(n.smtpPass),
      whatsappToken: mask(n.whatsappToken),
      hasWhatsappToken: Boolean(n.whatsappToken),
      callmebotKey: mask(n.callmebotKey),
      hasCallmebotKey: Boolean(n.callmebotKey),
    },
    data: s.data,
    integrations: {
      ...s.integrations,
      webhooks: s.integrations.webhooks.map((w) => ({ ...w, secret: mask(w.secret), url: maskUrl(w.url) })),
      googleServiceAccount: s.integrations.googleServiceAccount ? "••••••" : "",
      serviceAccountEmail: serviceAccountEmail(s.integrations.googleServiceAccount),
      firecrawlKey: mask(s.integrations.firecrawlKey),
      hasFirecrawlKey: Boolean(s.integrations.firecrawlKey),
      apifyToken: mask(s.integrations.apifyToken),
      hasApifyToken: Boolean(s.integrations.apifyToken),
    },
  };
}
export type PublicSettings = ReturnType<typeof publicSettings>;



