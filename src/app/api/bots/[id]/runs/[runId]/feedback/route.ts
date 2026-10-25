import { handler, idParam, notFound, readJson } from "@/server/api";
import { getAgentRun } from "@/server/repo/agent";
import { getBot, setBotFeedback } from "@/server/repo/bots";
import { audit } from "@/server/repo/events";
import { botFeedbackSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** 👍 / 👎 and a note on one bot run. The note becomes a lesson the bot follows from its next run on. */
export const POST = handler(async (req, { params }: Ctx) => {
  const p = await params;
  const botId = idParam.parse(p.id);
  const runId = idParam.parse(p.runId);
  const bot = getBot(botId);
  const run = getAgentRun(runId);
  if (!bot || !run || run.bot_id !== botId) throw notFound("Run");
  const { rating, note } = await readJson(req, botFeedbackSchema);
  const e = setBotFeedback(botId, runId, rating, note);
  audit("bot.feedback", { botId, runId, rating, note: Boolean(note) });
  return { eval: e };
});
