import { handler, HttpError, readJson } from "@/server/api";
import { BotError, createBot, describeSchedule, listBots } from "@/server/repo/bots";
import { listDealSearches } from "@/server/repo/deal-searches";
import { audit } from "@/server/repo/events";
import { listProducts } from "@/server/repo/products";
import { listRecipes } from "@/server/repo/scrapes";
import { listWatchers } from "@/server/repo/watchers";
import { botSchema, MAX_ACTIVE_BOTS } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({
  bots: listBots().map((b) => ({ ...b, scheduleText: describeSchedule(b.schedule) })),
  limit: MAX_ACTIVE_BOTS,
  // What an event trigger can point at.
  targets: {
    tasks: listRecipes().map((t) => ({ id: t.id, name: t.name })),
    watchers: listWatchers().map((w) => ({ id: w.id, name: w.name })),
    products: listProducts().map((p) => ({ id: p.id, name: p.title ?? p.url })),
    searches: listDealSearches().map((d) => ({ id: d.id, name: d.name })),
  },
}));

export const POST = handler(async (req) => {
  const input = await readJson(req, botSchema);
  try {
    const bot = createBot(input);
    audit("bot.created", { botId: bot.id, by: "you" });
    return { bot };
  } catch (e) {
    if (e instanceof BotError) throw new HttpError(e.field ? 400 : 409, e.field ? "validation" : "limit", e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
});
