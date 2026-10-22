import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { listProviderModels } from "@/server/ai/client";
import { providerWithSavedSecrets } from "@/server/repo/settings";
import { aiProviderSchema } from "@/lib/schemas";

const schema = z.object({ provider: aiProviderSchema });

/** Lists the models a provider offers (GET /models), for the model pickers. Works before the provider is saved. */
export const POST = handler(async (req) => {
  rateLimit("ai:models", 20, 5);
  const { provider } = await readJson(req, schema);
  const models = await listProviderModels(providerWithSavedSecrets(provider));
  return { models };
});
