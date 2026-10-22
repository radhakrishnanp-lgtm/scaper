import { handler, HttpError, readJson } from "@/server/api";
import { env } from "@/server/env";
import { aiUsageToday } from "@/server/repo/agent";
import { audit } from "@/server/repo/events";
import { getSettings, publicSettings, saveSettings } from "@/server/repo/settings";
import { settingsPatchSchema } from "@/lib/schemas";

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

export const PUT = handler(async (req) => {
  const patch = await readJson(req, settingsPatchSchema);
  if (patch.scraping?.proxyUrl) {
    const ok = /^https?:\/\/[^\s]+$/i.test(patch.scraping.proxyUrl) || MASKED.test(patch.scraping.proxyUrl);
    if (!ok) throw new HttpError(400, "validation", "Please fix the highlighted fields.", { "scraping.proxyUrl": "Use the form http://user:pass@host:port" });
  }
  const saved = saveSettings({ ai: dropMasked(patch.ai), scraping: dropMasked(patch.scraping), notifications: dropMasked(patch.notifications), data: patch.data, integrations: patch.integrations });
  audit("settings.updated", { sections: Object.keys(patch) });
  return { settings: publicSettings(saved) };
});
