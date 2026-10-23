import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { decide, decisionsTarget, questionsSchema, stateSchema } from "@/server/ai/decisions";
import { withWork } from "@/server/privacy";
import { getSettings } from "@/server/repo/settings";
import { readAnswers } from "@/lib/decision-policy";

/** Status of the decision model, for the Decisions page and the settings panel. */
export const GET = handler(async () => {
  const t = decisionsTarget({ evenIfOff: true });
  const d = getSettings().ai.decisions;
  return {
    enabled: d.enabled, ready: Boolean(t && d.enabled), model: d.model,
    provider: t ? { id: t.provider.id, name: t.provider.name } : null, endpoint: t?.url ?? null,
    uses: { pickLinks: d.pickLinks, scrapeCheck: d.scrapeCheck, agentGuard: d.agentGuard },
    linkThreshold: d.linkThreshold, riskThreshold: d.riskThreshold,
  };
});

const schema = z.object({
  state: stateSchema,
  questions: questionsSchema,
  // App policy only: how sure the model must be before an answer counts. It does not change the model's numbers.
  threshold: z.number().min(0.5).max(0.99).default(0.7),
  private: z.boolean().optional(),
});

/** Playground: send any state and questions, get the model's answers and Scaper's reading of them at your threshold. */
export const POST = handler(async (req) => {
  rateLimit("decisions:run", 20, 6);
  const input = await readJson(req, schema);
  const priv = input.private ?? getSettings().data.privateMode;
  const result = await withWork({ private: priv, purpose: "decide" }, () =>
    decide({ state: input.state, questions: input.questions, purpose: "playground", signal: req.signal, evenIfOff: true }));
  return { result, read: readAnswers(input.questions, result.answers, input.threshold), threshold: input.threshold };
});
