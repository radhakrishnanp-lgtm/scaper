import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { extensionsRoot, installFromStore, installPackage } from "@/server/live-browser/extensions";
import { liveState } from "@/server/live-browser/session";
import { listExtensions } from "@/server/repo/browser";

export const GET = handler(async () => ({ items: listExtensions(), folder: extensionsRoot(), restartNeeded: liveState().open && liveState().mode === "normal" }));

const storeSchema = z.object({ store: z.string().trim().min(10).max(500) });

/**
 * Install an extension: JSON `{store: "<Chrome Web Store link or id>"}`, or the .zip / .crx file itself as the body
 * (content-type application/zip, application/x-chrome-extension or application/octet-stream).
 */
export const POST = handler(async (req) => {
  rateLimit("browser:extensions", 10, 5);
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return { extension: await installFromStore((await readJson(req, storeSchema)).store), restart: liveState().open };
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 60 * 1024 * 1024) throw new HttpError(413, "too_large", "Extension packages are limited to 60 MB.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, "empty", "Choose a .zip or .crx file.");
  return { extension: await installPackage(buf, "upload"), restart: liveState().open };
});
