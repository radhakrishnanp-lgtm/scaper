import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { browserInstalled } from "@/server/fetcher/browser";
import { schedulerStatus } from "@/server/scheduler";

export const dynamic = "force-dynamic";

/** Liveness and readiness: database reachable, scheduler running, browser present. */
export async function GET() {
  let database = "ok";
  try { db().prepare("SELECT 1").get(); } catch { database = "error"; }
  const scheduler = schedulerStatus();
  const ok = database === "ok";
  return NextResponse.json(
    { ok, database, scheduler: scheduler.running ? "running" : "stopped", browser: browserInstalled() ? "installed" : "missing", time: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
