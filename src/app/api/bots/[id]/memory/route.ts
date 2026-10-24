import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { BotError, clearBotMemory, getBot, listBotMemory, rememberFact } from "@/server/repo/bots";
import { audit } from "@/server/repo/events";
import { botMemoryInputSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getBot(id)) throw notFound("Bot");
  return { memory: listBotMemory(id) };
});

/** Add or change one fact the bot keeps (same name = replaced). */
export const POST = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getBot(id)) throw notFound("Bot");
  const input = await readJson(req, botMemoryInputSchema);
  try {
    return { memory: rememberFact(id, input.key, input.value) };
  } catch (e) {
    if (e instanceof BotError) throw new HttpError(400, "validation", e.message, { value: e.message });
    throw e;
  }
});

/** Forget everything: facts and run summaries. */
export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getBot(id)) throw notFound("Bot");
  const removed = clearBotMemory(id);
  audit("bot.memory_cleared", { botId: id, removed });
  return { removed };
});
