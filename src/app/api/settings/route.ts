import { handler, HttpError, readJson } from "@/server/api";
import { env } from "@/server/env";
import { aiUsageToday } from "@/server/repo/agent";
import { audit } from "@/server/repo/events";
import { getSettings, publicSettings, saveSettings } from "@/server/repo/settings";
import { settingsPatchSchema } from "@/lib/schemas";
import { isBrowserFile } from "@/server/fetcher/browser-setup";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({
  settings: publicSettings(getSettings()),
  usage: aiUsageToday(),
  passwordProtected: Boolean(env.SCAPER_APP_PASSWORD),
}));

const MASKED = /••••/;

/** Masked secrets coming back from the form mean "unchanged", so they are dropped before saving. */
function dropMasked<T extends Record<string, unknown> | undefined>(section: T): T {
  if (!section) return section;
  return Object.fromEntries(Object.entries(section).filter(([, v]) => !(typeof v === "string" && MASKED.test(v)))) as T;
}

/** The partial schema fills in defaults for fields that were not sent; only the fields the client sent are saved. */
function onlySent<T extends Record<string, unknown> | undefined>(section: T, sent: unknown): T {
  if (!section || !sent || typeof sent !== "object") return section;
  return Object.fromEntries(Object.entries(section).filter(([k]) => k in sent)) as T;
}

export const PUT = handler(async (req) => {
  const raw = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = await readJson(req, settingsPatchSchema);
  const patch = {
    ai: onlySent(parsed.ai, raw.ai), scraping: onlySent(parsed.scraping, raw.scraping), notifications: onlySent(parsed.notifications, raw.notifications),
    data: onlySent(parsed.data, raw.data), integrations: onlySent(parsed.integrations, raw.integrations),
  };
  if (patch.scraping?.proxyUrl) {
    const ok = /^(https?|socks5h?):\/\/[^\s]+$/i.test(patch.scraping.proxyUrl) || MASKED.test(patch.scraping.proxyUrl);
    if (!ok) throw new HttpError(400, "validation", "Please fix the highlighted fields.", { "scraping.proxyUrl": "Use http://, https:// or socks5://, for example socks5://127.0.0.1:1080" });
  }
  if (patch.scraping?.browserPath && !isBrowserFile(patch.scraping.browserPath)) {
    throw new HttpError(400, "validation", "Please fix the highlighted fields.", { "scraping.browserPath": "Choose the full path of Chrome, Edge, Brave or Chromium on this computer" });
  }
  const saved = saveSettings({ ai: dropMasked(patch.ai), scraping: dropMasked(patch.scraping), notifications: dropMasked(patch.notifications), data: patch.data, integrations: patch.integrations });
  audit("settings.updated", { sections: Object.keys(raw) });
  return { settings: publicSettings(saved) };
});
