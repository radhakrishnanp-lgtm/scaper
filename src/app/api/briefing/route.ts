import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { configuredChannels, deliver } from "@/server/notify";
import { buildBriefing } from "@/server/ops/briefing";
import { audit } from "@/server/repo/events";
import { getSettings } from "@/server/repo/settings";

const body = z.object({
  days: z.number().int().min(1).max(31).default(1),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  match: z.enum(["any", "all"]).optional(),
  ai: z.boolean().optional(),
  send: z.boolean().default(false),
});

/** Preview a briefing (or send it now to every configured channel). */
export const POST = handler(async (req) => {
  const b = await readJson(req, body);
  const n = getSettings().notifications;
  const ai = b.ai ?? n.digestAi;
  if (ai) rateLimit("ai:briefing", 6, 3);
  const briefing = await buildBriefing({ days: b.days, tags: b.tags ?? n.digestTags, match: b.match ?? n.digestTagMatch, ai });
  if (b.send) {
    await deliver({ kind: "briefing", title: briefing.title, body: briefing.text }, { ...configuredChannels(), desktop: false });
    audit("digest.sent", { changes: briefing.stats.changes, manual: true });
  }
  return { briefing };
});
