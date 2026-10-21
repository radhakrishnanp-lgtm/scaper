import { handler } from "@/server/api";
import { db } from "@/server/db";
import { browserInstalled } from "@/server/fetcher/browser";
import { aiConfig } from "@/server/ai/client";
import { aiUsageToday } from "@/server/repo/agent";
import { listNotifications, unreadCount } from "@/server/repo/notifications";
import { schedulerStatus } from "@/server/scheduler";

export const dynamic = "force-dynamic";

const count = (sql: string) => (db().prepare(sql).get() as { c: number }).c;

export const GET = handler(async () => {
  const since = new Date(Date.now() - 86400_000).toISOString();
  return {
    watchers: count("SELECT COUNT(*) c FROM watchers"),
    activeWatchers: count("SELECT COUNT(*) c FROM watchers WHERE enabled = 1"),
    failingWatchers: count("SELECT COUNT(*) c FROM watchers WHERE enabled = 1 AND fail_count > 0"),
    products: count("SELECT COUNT(*) c FROM products"),
    recipes: count("SELECT COUNT(*) c FROM recipes"),
    changes24h: (db().prepare("SELECT COUNT(*) c FROM snapshots WHERE changed = 1 AND created_at >= ?").get(since) as { c: number }).c,
    scrapes24h: (db().prepare("SELECT COUNT(*) c FROM scrape_runs WHERE created_at >= ?").get(since) as { c: number }).c,
    unread: unreadCount(),
    recentAlerts: listNotifications({ limit: 6 }).items,
    upcoming: db().prepare("SELECT id, name, url, next_check_at, last_status FROM watchers WHERE enabled = 1 ORDER BY next_check_at LIMIT 5").all(),
    ai: { configured: aiConfig().configured, usage: aiUsageToday() },
    browser: browserInstalled(),
    scheduler: schedulerStatus(),
  };
});
