import fsp from "node:fs/promises";
import { handler } from "@/server/api";
import { closeLive, profileDir } from "@/server/live-browser/session";
import { audit } from "@/server/repo/events";

/** Signs you out everywhere: closes the browser and deletes the normal profile (cookies, sign-ins, site data). History and bookmarks stay. */
export const DELETE = handler(async () => {
  await closeLive("profile_cleared");
  await fsp.rm(profileDir(), { recursive: true, force: true });
  audit("browser.profile_cleared", {});
  return { ok: true };
});
