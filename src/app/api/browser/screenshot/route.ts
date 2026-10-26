import { handler } from "@/server/api";
import { screenshot } from "@/server/live-browser/session";

export const dynamic = "force-dynamic";

/** A JPEG of the active tab; `?download=1` saves it as a file. */
export const GET = handler(async (req) => {
  const buf = await screenshot(85);
  const name = `scaper-browser-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
  return new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", ...(req.nextUrl.searchParams.get("download") ? { "content-disposition": `attachment; filename="${name}"` } : {}) } });
});
