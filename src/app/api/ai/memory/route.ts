import { z } from "zod";
import { handler, HttpError, readJson } from "@/server/api";
import { addMemory, listMemory } from "@/server/repo/ai";
import { audit } from "@/server/repo/events";

export const dynamic = "force-dynamic";

/** Facts the agent always gets as context ("I'm in Chennai", "show prices in INR", "prefer amazon.in"). */
export const GET = handler(async () => ({ notes: listMemory() }));

export const POST = handler(async (req) => {
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(2, "Write the note first").max(500) }));
  try {
    const note = addMemory(text, "you");
    audit("ai.memory_added", { id: note.id });
    return { note };
  } catch (e) {
    throw new HttpError(400, "memory_full", (e as Error).message);
  }
});
