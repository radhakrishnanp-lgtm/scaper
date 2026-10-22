import { handler, rateLimit } from "@/server/api";
import { enqueueAndWait } from "@/server/jobs";
import { listBackups } from "@/server/ops/backup";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ backups: await listBackups() }));

export const POST = handler(async () => {
  rateLimit("backup", 4, 2);
  const job = await enqueueAndWait({ kind: "backup", refId: "backup", title: "Backup", unique: true }, 60_000);
  return { job, backups: await listBackups() };
});
