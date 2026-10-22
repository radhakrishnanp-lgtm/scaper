import { z } from "zod";
import { handler, idParam, notFound } from "@/server/api";
import { audit } from "@/server/repo/events";
import { getRecipe, updateRecipe } from "@/server/repo/scrapes";
import { getVersion } from "@/server/repo/versions";
import { taskSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string; version: string }> };
const versionParam = z.coerce.number().int().min(1);

export const GET = handler(async (_req, { params }: Ctx) => {
  const p = await params;
  const v = getVersion("task", idParam.parse(p.id), versionParam.parse(p.version));
  if (!v) throw notFound("Version");
  return { version: v };
});

/** Roll back: the old setup is saved again as a new version, so the rollback itself can be undone. */
export const POST = handler(async (_req, { params }: Ctx) => {
  const p = await params;
  const id = idParam.parse(p.id);
  const task = getRecipe(id);
  const v = getVersion("task", id, versionParam.parse(p.version));
  if (!task || !v) throw notFound("Version");
  const data = taskSchema.parse(v.data);
  const updated = updateRecipe(id, data, { source: "restore", note: `Restored version ${v.version}` });
  audit("task.restored", { taskId: id, version: v.version });
  return { task: updated };
});
