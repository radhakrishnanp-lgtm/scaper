import { handler, readJson } from "@/server/api";
import fs from "node:fs";
import { firefox } from "playwright";
import { canShowWindow, closeLive, currentAnnotations, liveState, openLive } from "@/server/live-browser/session";
import { listBookmarks, listExtensions } from "@/server/repo/browser";
import { getSettings } from "@/server/repo/settings";
import { browserSessionSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const firefoxInstalled = () => { try { return fs.existsSync(/* turbopackIgnore: true */ firefox.executablePath()); } catch { return false; } };

/** The browser's state (open, mode, tabs), annotations on the open page, bookmarks and extensions. */
export const GET = handler(async () => {
  const d = getSettings().data;
  return {
    state: liveState(), annotations: currentAnnotations(), bookmarks: listBookmarks(), extensions: listExtensions(),
    settings: { quality: d.browserQuality, home: d.browserHome, search: d.browserSearch, history: d.browserHistory, historyDays: d.browserHistoryDays, privateMode: d.privateMode,
      engine: d.browserEngine, window: d.browserWindow, canWindow: canShowWindow(), firefoxInstalled: firefoxInstalled() },
  };
});

/** Open the browser `{action: "open", mode: normal|incognito}` or close it `{action: "close"}`. */
export const POST = handler(async (req) => {
  const { action, mode } = await readJson(req, browserSessionSchema);
  if (action === "close") { await closeLive(); return { state: liveState() }; }
  return { state: await openLive(mode) };
});
