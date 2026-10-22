import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { env } from "@/server/env";
import { backupDir } from "@/server/ops/backup";
import { audit } from "@/server/repo/events";
import { WIPE_SCOPES, wipeHistory } from "@/server/repo/history";

const schema = z.object({
  scopes: z.array(z.enum([...WIPE_SCOPES, "exports", "backups"])).min(1, "Choose what to delete").max(20),
  olderThanDays: z.number().int().min(1).max(3650).optional(),
});

async function wipeFiles(dir: string, olderThanDays?: number) {
  const cutoff = olderThanDays ? Date.now() - olderThanDays * 86400_000 : Infinity;
  let n = 0;
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) { await fs.rm(p, { force: true }); n++; }
    }
  };
  await walk(dir);
  return n;
}

/** Settings → Privacy: delete history by kind and age, then compact the database so nothing readable is left. */
export const POST = handler(async (req) => {
  rateLimit("privacy:wipe", 6, 3);
  const { scopes, olderThanDays } = await readJson(req, schema);
  const db = scopes.filter((s): s is (typeof WIPE_SCOPES)[number] => s !== "exports" && s !== "backups");
  const removed: Record<string, number> = db.length ? wipeHistory(db, olderThanDays) as Record<string, number> : {};
  if (scopes.includes("exports")) removed.exports = await wipeFiles(path.join(env.dataDir, "exports"), olderThanDays);
  // Backups are full copies of the database, so they would otherwise keep what was just deleted.
  if (scopes.includes("backups")) removed.backups = await wipeFiles(backupDir(), olderThanDays);
  // The audit line itself says only what kinds were wiped, not what they contained.
  if (!scopes.includes("logs")) audit("privacy.wiped", { scopes, olderThanDays: olderThanDays ?? null });
  return { removed };
});
