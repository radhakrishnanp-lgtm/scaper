import { handler } from "@/server/api";
import { db } from "@/server/db";
import { browserInstalled } from "@/server/fetcher/browser";
import { aiConfig } from "@/server/ai/client";
import { aiUsageToday } from "@/server/repo/agent";
import { jobCounts, jobsPerDay, listJobs } from "@/server/repo/jobs";
import { listNotifications, notificationsPerDay, unreadCount } from "@/server/repo/notifications";
import { schedulerStatus } from "@/server/scheduler";

export const dynamic = "force-dynamic";

const count = (sql: string, ...args: unknown[]) => (db().prepare(sql).get(...args) as { c: number }).c;

export const GET = handler(async () => {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const since14 = new Date(Date.now() - 14 * 86400_000).toISOString();
  const changesPerDay = db().prepare("SELECT substr(created_at, 1, 10) day, COUNT(*) c FROM snapshots WHERE changed = 1 AND created_at >= ? GROUP BY day ORDER BY day").all(since14);
  const rowsPerDay = db().prepare("SELECT substr(created_at, 1, 10) day, SUM(row_count) c FROM scrape_runs WHERE created_at >= ? GROUP BY day ORDER BY day").all(since14);
  const jobs7 = db().prepare("SELECT status, COUNT(*) c FROM jobs WHERE created_at >= ? AND status IN ('succeeded','failed') GROUP BY status").all(new Date(Date.now() - 7 * 86400_000).toISOString()) as { status: string; c: number }[];
  const ok7 = jobs7.find((j) => j.status === "succeeded")?.c ?? 0;
  const fail7 = jobs7.find((j) => j.status === "failed")?.c ?? 0;
  return {
    watchers: count("SELECT COUNT(*) c FROM watchers"),
    activeWatchers: count("SELECT COUNT(*) c FROM watchers WHERE enabled = 1"),
    failingWatchers: count("SELECT COUNT(*) c FROM watchers WHERE enabled = 1 AND fail_count > 0"),
    products: count("SELECT COUNT(*) c FROM products"),
    recipes: count("SELECT COUNT(*) c FROM recipes"),
    scheduledTasks: count("SELECT COUNT(*) c FROM recipes WHERE (schedule_minutes IS NOT NULL OR cron IS NOT NULL) AND next_run_at IS NOT NULL"),
    dealSearches: count("SELECT COUNT(*) c FROM deal_searches"),
    changes24h: count("SELECT COUNT(*) c FROM snapshots WHERE changed = 1 AND created_at >= ?", since),
    scrapes24h: count("SELECT COUNT(*) c FROM scrape_runs WHERE created_at >= ?", since),
    rows24h: count("SELECT COALESCE(SUM(row_count), 0) c FROM scrape_runs WHERE created_at >= ?", since),
    priceDrops24h: count("SELECT COUNT(*) c FROM notifications WHERE kind = 'price' AND created_at >= ?", since),
    successRate7d: ok7 + fail7 ? Math.round((ok7 / (ok7 + fail7)) * 1000) / 10 : null,
    unread: unreadCount(),
    recentAlerts: listNotifications({ limit: 6 }).items,
    upcoming: db().prepare("SELECT id, name, url, next_check_at, last_status FROM watchers WHERE enabled = 1 ORDER BY next_check_at LIMIT 6").all(),
    jobs: jobCounts(),
    activeJobs: listJobs({ status: "active", limit: 8 }).items,
    charts: { jobs: jobsPerDay(14), changes: changesPerDay, rows: rowsPerDay, alerts: notificationsPerDay(14) },
    ai: { configured: aiConfig().configured, usage: aiUsageToday() },
    browser: browserInstalled(),
    scheduler: schedulerStatus(),
  };
});
