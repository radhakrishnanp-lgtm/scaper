import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { deletePlaybook, getPlaybook, savePlaybook, type DecisionQuestions } from "@/server/repo/team";
import { playbookSchema } from "@/server/ai/team";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = handler(async (req, { params }: Ctx) => {
  const cur = getPlaybook(idParam.parse((await params).id));
  if (!cur) throw notFound("Playbook");
  const input = await readJson(req, playbookSchema);
  // The name stays; each save is a new version and the use counts are kept.
  const pb = savePlaybook({ ...input, name: cur.name, questions: input.questions as DecisionQuestions | null, source: "you" });
  return { playbook: pb };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deletePlaybook(id)) throw notFound("Playbook");
  audit("agent.playbook_deleted", { id });
  return { ok: true };
});
