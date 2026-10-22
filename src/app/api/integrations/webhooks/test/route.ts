import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { testEndpoint } from "@/server/integrations/webhooks";
import { getSettings } from "@/server/repo/settings";

const body = z.object({ id: z.string().max(40).optional(), url: z.string().url().max(1000).optional(), secret: z.string().max(200).optional() });

/** Sends a test event to one endpoint (a saved one by id, or a URL being set up). */
export const POST = handler(async (req) => {
  rateLimit("webhook:test", 20, 5);
  const b = await readJson(req, body);
  const saved = b.id ? getSettings().integrations.webhooks.find((w) => w.id === b.id) : undefined;
  const url = b.url && !/%E2%80%A2|•/.test(b.url) ? b.url : saved?.url;
  if (!url) throw new HttpError(400, "validation", "Enter the endpoint URL.");
  const secret = b.secret && !/••••/.test(b.secret) ? b.secret : saved?.secret ?? "";
  try {
    const r = await testEndpoint({ url, secret });
    return { message: `It works: HTTP ${r.code} in ${r.ms} ms.` };
  } catch (e) {
    throw new HttpError(400, "webhook_failed", `The endpoint didn't accept the test: ${(e as Error).message}`);
  }
});
