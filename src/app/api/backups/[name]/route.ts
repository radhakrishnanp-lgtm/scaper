import fs from "node:fs/promises";
import { handler, notFound } from "@/server/api";
import { backupPath, deleteBackup } from "@/server/ops/backup";
import { audit } from "@/server/repo/events";

type Ctx = { params: Promise<{ name: string }> };

/** Download a backup. To restore, stop Scaper and copy it over data/scaper.db (see docs/RUNBOOK.md). */
export const GET = handler(async (_req, { params }: Ctx) => {
  const name = (await params).name;
  const file = backupPath(name);
  const data = file ? await fs.readFile(file).catch(() => null) : null;
  if (!data) throw notFound("Backup");
  return new Response(new Uint8Array(data), { headers: { "content-type": "application/vnd.sqlite3", "content-disposition": `attachment; filename="${name}"` } });
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const name = (await params).name;
  if (!(await deleteBackup(name))) throw notFound("Backup");
  audit("backup.deleted", { name });
  return { ok: true };
});
