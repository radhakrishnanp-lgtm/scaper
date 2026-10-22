import "server-only";
import { db } from "../db";
import { settingsSchema, type Settings } from "@/lib/schemas";
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
  const value = settingsSchema.parse(raw);
  g.__scaperSettings = { at: Date.now(), value };
  return value;
}

export function saveSettings(patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>): Settings {
  const current = getSettings();
  const merged = settingsSchema.parse({
    ai: { ...current.ai, ...patch.ai },
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

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
const maskUrl = (v: string) => (v ? v.replace(/^(https?:\/\/[^/]+\/).*$/, "$1••••") : "");

/** Secrets never leave the server: the browser only sees whether they are set. */
export function publicSettings(s: Settings) {
  const n = s.notifications;
  return {
    ai: { ...s.ai, apiKey: mask(s.ai.apiKey), hasApiKey: Boolean(s.ai.apiKey) },
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



