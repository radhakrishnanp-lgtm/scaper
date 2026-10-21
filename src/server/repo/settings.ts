import "server-only";
import { db } from "../db";
import { settingsSchema, type Settings } from "@/lib/schemas";
import { now, parseJson } from "./util";

const SECTIONS = ["ai", "scraping", "notifications"] as const;

export function getSettings(): Settings {
  const rows = db().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const raw: Record<string, unknown> = { ai: {}, scraping: {}, notifications: {} };
  for (const r of rows) raw[r.key] = parseJson(r.value, {});
  return settingsSchema.parse(raw);
}

export function saveSettings(patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>): Settings {
  const current = getSettings();
  const merged = settingsSchema.parse({
    ai: { ...current.ai, ...patch.ai },
    scraping: { ...current.scraping, ...patch.scraping },
    notifications: { ...current.notifications, ...patch.notifications },
  });
  const stmt = db().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  db().transaction(() => {
    for (const s of SECTIONS) stmt.run(s, JSON.stringify(merged[s]), now());
  })();
  return merged;
}

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");

/** Secrets never leave the server: the browser only sees whether they are set. */
export function publicSettings(s: Settings) {
  return {
    ai: { ...s.ai, apiKey: mask(s.ai.apiKey), hasApiKey: Boolean(s.ai.apiKey) },
    scraping: { ...s.scraping, proxyUrl: s.scraping.proxyUrl.replace(/\/\/([^@/]+)@/, "//••••@") },
    notifications: {
      ...s.notifications,
      telegramBotToken: mask(s.notifications.telegramBotToken),
      hasTelegramToken: Boolean(s.notifications.telegramBotToken),
    },
  };
}
export type PublicSettings = ReturnType<typeof publicSettings>;
