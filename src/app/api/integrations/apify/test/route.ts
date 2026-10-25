import { handler, HttpError, rateLimit } from "@/server/api";
import { testApify } from "@/server/integrations/apify";
import { IntegrationError } from "@/server/integrations/firecrawl";
import { audit } from "@/server/repo/events";

/** "Test" on Integrations → Apify: checks the token and shows the account. */
export const POST = handler(async () => {
  rateLimit("apify:test", 6, 3);
  try {
    const r = await testApify();
    audit("apify.tested", { ms: r.ms });
    return { ...r, message: `Signed in to Apify as ${r.username || "your account"}${r.plan ? ` (${r.plan} plan)` : ""}.` };
  } catch (e) {
    if (e instanceof IntegrationError) throw new HttpError(502, "apify", e.message);
    throw e;
  }
});
