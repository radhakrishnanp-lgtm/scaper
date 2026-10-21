import { handler, idParam, notFound } from "@/server/api";
import { deleteRun, getRun } from "@/server/repo/scrapes";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const run = getRun(idParam.parse((await params).id));
  if (!run) throw notFound("Run");
  return { run };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  if (!deleteRun(idParam.parse((await params).id))) throw notFound("Run");
  return { ok: true };
});
