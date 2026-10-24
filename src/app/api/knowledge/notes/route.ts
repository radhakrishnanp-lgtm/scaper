import { z } from "zod";
import { handler, HttpError, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { looksSecret, saveNote } from "@/server/repo/knowledge";
import { noteInputSchema } from "@/lib/schemas";

export const POST = handler(async (req) => {
  const input = await readJson(req, noteInputSchema.extend({ name: z.string().max(60).optional() }));
  if (looksSecret(input.body)) throw new HttpError(400, "validation", "Please fix the highlighted fields.", { body: "Notes are read by the AI; keep keys and passwords out of them" });
  const note = saveNote({ ...input, source: "you" });
  audit("agent.note_written", { name: note.name, by: "you" });
  return { note };
});
