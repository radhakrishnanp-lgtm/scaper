import { handler } from "@/server/api";
import { aiConfig } from "@/server/ai/client";
import { aiCostThisMonth, aiUsageHistory, aiUsageToday } from "@/server/repo/agent";
import { aiCallStats } from "@/server/repo/ai";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const cfg = aiConfig("main");
  const history = aiUsageHistory(30);
  const today = history.find((h) => h.day === new Date().toISOString().slice(0, 10));
  return {
    today: { ...aiUsageToday(), cost: today?.cost ?? 0 },
    month: aiCostThisMonth(),
    history,
    limit: cfg.dailyRequestLimit,
    budget: cfg.monthlyBudget,
    configured: cfg.configured,
    stats: aiCallStats(30),
  };
});
