import { handler } from "@/server/api";
import { aiConfig } from "@/server/ai/client";
import { aiUsageHistory, aiUsageToday } from "@/server/repo/agent";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const cfg = aiConfig("main");
  return { today: aiUsageToday(), history: aiUsageHistory(30), limit: cfg.dailyRequestLimit, configured: cfg.configured };
});
