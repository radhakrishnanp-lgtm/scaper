import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { runBot } from "@/server/ai/bots";
import { BotError, getBot } from "@/server/repo/bots";
import { botRunInputSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** Run now (no prompt) or chat with the bot (a prompt, optionally following up an earlier chat). */
export const POST = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getBot(id)) throw notFound("Bot");
  const input = await readJson(req, botRunInputSchema);
  try {
    const run = input.prompt ? runBot(id, { trigger: "chat", prompt: input.prompt, followUpOf: input.followUpOf }) : runBot(id, { trigger: "manual" });
    return { run };
  } catch (e) {
    if (e instanceof BotError) throw new HttpError(409, "bot_busy", e.message);
    throw e;
  }
});
