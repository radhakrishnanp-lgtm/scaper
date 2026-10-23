import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { candidateLinks } from "@/server/ai/crawl";
import { buildPageContext } from "@/server/ai/context";
import { decisionsTarget } from "@/server/ai/decisions";
import { scoreLinks } from "@/server/ai/judge";
import { fetchPage } from "@/server/fetcher";
import { withWork } from "@/server/privacy";
import { getSettings } from "@/server/repo/settings";
import { fetchModeSchema, urlSchema } from "@/lib/schemas";

const schema = z.object({
  url: urlSchema,
  goal: z.string().trim().min(2, "Say what you are looking for").max(300),
  mode: fetchModeSchema.default("fast"),
  private: z.boolean().optional(),
});

/** "What to scrape": every same-site link on a page, scored by the decision model for the goal. */
export const POST = handler(async (req) => {
  rateLimit("decisions:links", 10, 3);
  const input = await readJson(req, schema);
  const priv = input.private ?? getSettings().data.privateMode;
  return withWork({ private: priv, purpose: "links" }, async () => {
    const page = await fetchPage(input.url, input.mode, { signal: req.signal });
    const links = candidateLinks(page.html, page.finalUrl);
    if (!links.length) throw new HttpError(422, "no_links", "That page has no links to other pages of the same site.");
    const excerpt = buildPageContext(page.html, page.finalUrl, { budgetTokens: 1500 }).markdown;
    const r = await scoreLinks({ goal: input.goal, pageUrl: page.finalUrl, pageTitle: page.title, links, excerpt, signal: req.signal });
    const threshold = decisionsTarget({ evenIfOff: true })?.settings.linkThreshold ?? 0.5;
    return {
      page: { url: page.finalUrl, title: page.title },
      threshold, startIsListing: r.startIsListing, ai: r.ai, skipped: Math.max(0, links.length - r.links.length),
      links: r.links.map((l) => ({ text: l.text, url: l.href, area: l.area, p: l.p })),
    };
  });
});
