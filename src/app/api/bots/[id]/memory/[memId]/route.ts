import { handler, idParam, notFound } from "@/server/api";
import { forgetFact, getBot } from "@/server/repo/bots";

type Ctx = { params: Promise<{ id: string; memId: string }> };

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const p = await params;
  const id = idParam.parse(p.id);
  if (!getBot(id)) throw notFound("Bot");
  if (!forgetFact(id, idParam.parse(p.memId))) throw notFound("Memory");
  return { ok: true };
});
