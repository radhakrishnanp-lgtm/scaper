import { handler, HttpError, rateLimit } from "@/server/api";
import { IntegrationError, testFirecrawl } from "@/server/integrations/firecrawl";
import { audit } from "@/server/repo/events";

/** "Test" on Integrations → Firecrawl: loads example.com through your key and reads the credits left. */
export const POST = handler(async () => {
  rateLimit("firecrawl:test", 6, 3);
  try {
    const r = await testFirecrawl();
    audit("firecrawl.tested", { ms: r.ms });
    return { ...r, message: `Firecrawl loaded "${r.title}" in ${(r.ms / 1000).toFixed(1)} s.${r.credits !== null ? ` ${r.credits.toLocaleString("en-IN")} credits left.` : ""}` };
  } catch (e) {
    if (e instanceof IntegrationError) throw new HttpError(502, "firecrawl", e.message);
    throw e;
  }
});
