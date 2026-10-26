import fsp from "node:fs/promises";
import { handler } from "@/server/api";
import { closeLive, profileDir } from "@/server/live-browser/session";
import { audit } from "@/server/repo/events";

/** Signs you out everywhere: closes the browser and deletes the normal profile of every engine (cookies, sign-ins, site data). History and bookmarks stay. */
export const DELETE = handler(async () => {
  await closeLive("profile_cleared");
  for (const engine of ["chromium", "chrome", "msedge", "firefox"] as const) await fsp.rm(profileDir(engine), { recursive: true, force: true });
  audit("browser.profile_cleared", {});
  return { ok: true };
});
