import { handler, readJson } from "@/server/api";
import { hostStates } from "@/server/fetcher/politeness";
import { audit } from "@/server/repo/events";
import { getSiteRule, hostSummaries, listSiteRules, publicRule, upsertSiteRule } from "@/server/repo/sites";
import { siteRuleSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** Every site Scaper has talked to: request stats for 30 days, live backoff state, and your rules. */
export const GET = handler(async () => {
  const rules = listSiteRules().map(publicRule);
  const live = new Map(hostStates().map((h) => [h.host, h]));
  const stats = hostSummaries(30);
  const hosts = [...new Set([...stats.map((s) => s.host), ...rules.map((r) => r.host)])];
  return {
    sites: hosts.map((host) => ({
      host, stats: stats.find((s) => s.host === host) ?? null, rule: rules.find((r) => r.host === host) ?? null,
      backoff: live.get(host) ?? null,
    })),
  };
});

/** Create or update a site rule. Cookies sent back masked mean "keep the saved ones". */
export const POST = handler(async (req) => {
  const input = await readJson(req, siteRuleSchema);
  const keep = /cookie\(s\) set$/.test(input.cookies) && Boolean(getSiteRule(input.host)?.cookies);
  const rule = upsertSiteRule(input, keep);
  audit("site.rule_saved", { host: rule.host, cookies: Boolean(rule.cookies) });
  return { rule: publicRule(rule) };
});
