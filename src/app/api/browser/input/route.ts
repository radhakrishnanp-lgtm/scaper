import { handler, readJson } from "@/server/api";
import { input } from "@/server/live-browser/session";
import { browserInputSchema } from "@/lib/schemas";

/** Your mouse, wheel and keys for the active tab, in page pixels: `{events: [...]}`. */
export const POST = handler(async (req) => {
  const { events } = await readJson(req, browserInputSchema);
  await input(events);
  return { ok: true };
});
