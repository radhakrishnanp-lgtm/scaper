import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { checkConnection } from "@/server/ai/client";
import { audit } from "@/server/repo/events";
import { providerWithSavedSecrets } from "@/server/repo/settings";
import { aiProviderSchema } from "@/lib/schemas";

const schema = z.object({ provider: aiProviderSchema, model: z.string().trim().max(200).optional() });

/** "Test connection" in the provider form: checks the address, the key and one model before anything is saved. */
export const POST = handler(async (req) => {
  rateLimit("ai:check", 10, 4);
  const { provider, model } = await readJson(req, schema);
  const result = await checkConnection(providerWithSavedSecrets(provider), model);
  audit("ai.connection_checked", { provider: provider.name, ok: result.ok, model: result.model });
  return result;
});
