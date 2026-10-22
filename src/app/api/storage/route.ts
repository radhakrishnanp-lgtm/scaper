import { handler } from "@/server/api";
import { storageUsage } from "@/server/ops/backup";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

const count = (table: string) => (db().prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

export const GET = handler(async () => ({
  usage: await storageUsage(),
  rows: {
    runs: count("scrape_runs"), snapshots: count("snapshots"), pricePoints: count("price_points"), jobs: count("jobs"),
    notifications: count("notifications"), events: count("event_log"),
  },
}));
