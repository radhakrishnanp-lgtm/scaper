import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { resolveModel, testModel } from "@/server/ai/client";
import { audit } from "@/server/repo/events";
import { providerWithSavedSecrets } from "@/server/repo/settings";
import { aiModelSchema, aiProviderSchema } from "@/lib/schemas";

const schema = z.object({
  // A saved provider by id, or the provider as it stands in the form.
  providerId: z.string().max(40).optional(),
  provider: aiProviderSchema.optional(),
  model: z.string().trim().min(1, "Choose a model").max(200),
});

/** Capability test for one model: does it answer, does it do JSON mode, can it call tools. */
export const POST = handler(async (req) => {
  rateLimit("ai:test", 10, 4);
  const input = await readJson(req, schema);
  let resolved;
  if (input.provider) {
    const provider = providerWithSavedSecrets(input.provider);
    resolved = { provider, model: input.model, info: provider.models.find((m) => m.id === input.model) ?? aiModelSchema.parse({ id: input.model }) };
  } else {
    resolved = resolveModel({ providerId: input.providerId ?? "", model: input.model });
    if (!resolved) throw new HttpError(404, "not_found", "That provider is not saved or is switched off.");
  }
  const result = await testModel(resolved);
  audit("ai.tested", { provider: resolved.provider.name, model: input.model, tools: result.tools, json: result.json });
  return result;
});
