import "server-only";
import { db } from "../db";
import { aiModelSchema, aiProviderSchema, settingsSchema, type AiProvider, type Settings } from "@/lib/schemas";
import { now, parseJson } from "./util";

const SECTIONS = ["ai", "scraping", "notifications", "data"] as const;

type CacheEntry = { at: number; value: Settings };
const g = globalThis as unknown as { __scaperSettings?: CacheEntry | null };

/** Settings are read on every fetch, so they are cached for a second. */
export function getSettings(): Settings {
  const c = g.__scaperSettings;
  if (c && Date.now() - c.at < 1000) return c.value;
  const rows = db().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const raw: Record<string, unknown> = { ai: {}, scraping: {}, notifications: {}, data: {} };
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

export function saveSettings(patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>): Settings {
  const current = getSettings();
  const aiPatch = { ...patch.ai } as Partial<Ai>;
  if (aiPatch.providers) aiPatch.providers = keepProviderSecrets(aiPatch.providers.map((p) => aiProviderSchema.parse(p)), current.ai.providers);
  const merged = settingsSchema.parse({
    ai: applyLegacyPatch({ ...current.ai, ...aiPatch }, aiPatch),
    scraping: { ...current.scraping, ...patch.scraping },
    notifications: { ...current.notifications, ...patch.notifications },
    data: { ...current.data, ...patch.data },
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
    },
    data: s.data,
  };
}
export type PublicSettings = ReturnType<typeof publicSettings>;



