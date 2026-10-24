import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { stopAgent } from "@/server/ai/agent";
import { BotError, botRuns, deleteBot, describeSchedule, getBot, listBotMemory, updateBot } from "@/server/repo/bots";
import { audit } from "@/server/repo/events";
import { botPatchSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const bot = getBot(idParam.parse((await params).id));
  if (!bot) throw notFound("Bot");
  return { bot: { ...bot, scheduleText: describeSchedule(bot.schedule) }, runs: botRuns(bot.id, 40), memory: listBotMemory(bot.id) };
});

export const PUT = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!getBot(id)) throw notFound("Bot");
  const raw = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = await readJson(req, botPatchSchema);
  // The partial schema fills defaults for fields that were not sent; keep only what the client sent.
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw));
  try {
    const bot = updateBot(id, patch);
    audit("bot.updated", { botId: id, fields: Object.keys(patch) });
    return { bot };
  } catch (e) {
    if (e instanceof BotError) throw new HttpError(e.field ? 400 : 409, e.field ? "validation" : "limit", e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
});

/** Deletes the bot and its memory; a running run is stopped. Past runs stay in the history. */
export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const bot = getBot(id);
  if (!bot) throw notFound("Bot");
  for (const r of botRuns(id, 5)) if (r.status === "running") stopAgent(r.id);
  deleteBot(id);
  audit("bot.deleted", { botId: id, name: bot.name });
  return { ok: true };
});
