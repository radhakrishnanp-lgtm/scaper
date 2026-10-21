import { handler, rateLimit, readJson } from "@/server/api";
import { startAgent } from "@/server/ai/agent";
import { agentRequestSchema } from "@/lib/schemas";

export const POST = handler(async (req) => {
  rateLimit("agent", 10, 3);
  const { prompt, useFastModel } = await readJson(req, agentRequestSchema);
  return { run: startAgent(prompt, useFastModel) };
});
