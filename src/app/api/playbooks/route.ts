import { handler, readJson } from "@/server/api";
import { playbookSchema } from "@/server/ai/team";
import { audit } from "@/server/repo/events";
import { listPlaybooks, savePlaybook, type DecisionQuestions } from "@/server/repo/team";



/** Playbooks: helper instructions, examples and decision questions the supervisor reuses and improves. */
export const GET = handler(async (req) => ({ playbooks: listPlaybooks(req.nextUrl.searchParams.get("q") ?? undefined) }));

export const POST = handler(async (req) => {
  const input = await readJson(req, playbookSchema);
  const pb = savePlaybook({ ...input, questions: input.questions as DecisionQuestions | null, source: "you" });
  audit("agent.playbook_saved", { name: pb.name, version: pb.version, by: "you" });
  return { playbook: pb };
});
