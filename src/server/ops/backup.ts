import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { audit } from "../repo/events";

export const backupDir = () => path.join(env.dataDir, "backups");

export type BackupFile = { name: string; size: number; created_at: string };

/** A consistent copy of the live database (SQLite online backup), safe while Scaper runs. */
export async function createBackup(reason: "manual" | "auto" = "manual"): Promise<BackupFile> {
  await fs.mkdir(backupDir(), { recursive: true });
  const name = `scaper-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23)}.db`;
  const file = path.join(backupDir(), name);
  await db().backup(file);
  const st = await fs.stat(file);
  audit("backup.created", { name, size: st.size, reason });
  return { name, size: st.size, created_at: st.mtime.toISOString() };
}

export async function listBackups(): Promise<BackupFile[]> {
  const names = await fs.readdir(backupDir()).catch(() => [] as string[]);
  const files = await Promise.all(names.filter((n) => /^scaper-[\w-]+\.db$/.test(n)).map(async (name) => {
    const st = await fs.stat(path.join(backupDir(), name));
    return { name, size: st.size, created_at: st.mtime.toISOString() };
  }));
  return files.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Only plain backup file names are accepted, so a request can never reach outside the folder. */
export function backupPath(name: string): string | null {
  return /^scaper-[\w-]+\.db$/.test(name) ? path.join(backupDir(), name) : null;
}

export async function deleteBackup(name: string) {
  const file = backupPath(name);
  if (!file) return false;
  await fs.rm(file, { force: true });
  return true;
}

export async function pruneBackups(keep: number) {
  const all = await listBackups();
  for (const b of all.slice(keep)) await deleteBackup(b.name);
  return Math.max(0, all.length - keep);
}

/** Total bytes used by the database, media, exports and backups, for Settings → Data. */
export async function storageUsage() {
  const size = async (p: string): Promise<number> => {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return 0;
    if (!st.isDirectory()) return st.size;
    const entries = await fs.readdir(p).catch(() => [] as string[]);
    let total = 0;
    for (const e of entries) total += await size(path.join(p, e));
    return total;
  };
  const d = env.dataDir;
  const [dbFile, wal, media, exports, backups] = await Promise.all([
    size(path.join(d, "scaper.db")), size(path.join(d, "scaper.db-wal")), size(path.join(d, "media")), size(path.join(d, "exports")), size(backupDir()),
  ]);
  return { database: dbFile + wal, media, exports, backups, total: dbFile + wal + media + exports + backups, dataDir: d };
}
