import path from "node:path";
import { handler } from "@/server/api";
import { mcpTools } from "@/server/mcp/server";
import { deliveryStats } from "@/server/repo/deliveries";
import { firecrawlUsage } from "@/server/repo/firecrawl-usage";
import { getSettings, serviceAccountEmail } from "@/server/repo/settings";
import { listTokens } from "@/server/repo/tokens";
import { listRecipes } from "@/server/repo/scrapes";

export const dynamic = "force-dynamic";

/** Status of every integration for the Integrations page. */
export const GET = handler(async () => {
  const s = getSettings();
  const week = deliveryStats(new Date(Date.now() - 7 * 86400_000).toISOString());
  const count = (kind: string, status?: string) => week.filter((r) => r.kind === kind && (!status || r.status === status)).reduce((n, r) => n + r.c, 0);
  const tools = mcpTools(true);
  return {
    mcp: { enabled: s.integrations.mcpEnabled, allowWrite: s.integrations.mcpAllowWrite, tools: tools.map((t) => ({ name: t.name, description: t.description, changes: t.changes })), tokens: listTokens().length, bridge: path.join(process.cwd(), "scripts", "scaper-mcp.mjs") },
    webhooks: {
      default: Boolean(s.notifications.webhookUrl), endpoints: s.integrations.webhooks.length, retries: s.integrations.webhookRetries,
      week: { total: count("webhook"), ok: count("webhook", "ok"), failed: count("webhook", "failed"), retrying: count("webhook", "retrying") },
    },
    firecrawl: { configured: Boolean(s.integrations.firecrawlKey), url: s.integrations.firecrawlUrl, tasks: listRecipes().filter((t) => t.mode === "firecrawl").length, dailyCredits: s.integrations.firecrawlDailyCredits, usage: firecrawlUsage() },
    apify: { configured: Boolean(s.integrations.apifyToken), maxChargeUsd: s.integrations.apifyMaxChargeUsd, tasks: listRecipes().filter((t) => t.options.source.type === "apify").map((t) => ({ id: t.id, name: t.name, actorId: t.options.source.type === "apify" ? t.options.source.actorId : "" })) },
    sheets: {
      configured: Boolean(s.integrations.googleServiceAccount), email: serviceAccountEmail(s.integrations.googleServiceAccount),
      tasks: listRecipes().filter((t) => t.options.output.sheets.enabled).map((t) => ({ id: t.id, name: t.name, sheet: t.options.output.sheets.sheet, mode: t.options.output.sheets.mode })),
      week: { total: count("sheets"), ok: count("sheets", "ok"), failed: count("sheets", "failed") },
    },
  };
});
