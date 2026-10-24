import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { checkConnection } from "@/server/ai/client";
import { checkDecisionsConnection } from "@/server/ai/decisions";
import { audit } from "@/server/repo/events";
import { providerWithSavedSecrets } from "@/server/repo/settings";
import { aiProviderSchema } from "@/lib/schemas";
import { isDecisionsModel, isDecisionsUrl } from "@/lib/decisions-url";

const schema = z.object({ provider: aiProviderSchema, model: z.string().trim().max(200).optional() });

/** "Test connection" in the provider form: checks the address, the key and one model before anything is saved. */
export const POST = handler(async (req) => {
  rateLimit("ai:check", 10, 4);
  const { provider, model } = await readJson(req, schema);
  const p = providerWithSavedSecrets(provider);
  // OpenRouter's Decisions API has no model list or chat endpoint; it gets its own check.
  const decisions = isDecisionsUrl(p.baseUrl) || (model ? isDecisionsModel(model) : p.models.length > 0 && p.models.every((m) => isDecisionsModel(m.id)));
  const result = decisions ? await checkDecisionsConnection(p, model) : await checkConnection(p, model);
  audit("ai.connection_checked", { provider: provider.name, ok: result.ok, model: result.model, decisions });
  return result;
});
