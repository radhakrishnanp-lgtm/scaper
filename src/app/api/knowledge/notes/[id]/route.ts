import { handler, HttpError, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { deleteNote, getNote, looksSecret, saveNote } from "@/server/repo/knowledge";
import { noteInputSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const note = getNote(idParam.parse((await params).id));
  if (!note) throw notFound("Note");
  return { note };
});

/** Saves your edit as a new version under the same name. */
export const PUT = handler(async (req, { params }: Ctx) => {
  const cur = getNote(idParam.parse((await params).id));
  if (!cur) throw notFound("Note");
  const input = await readJson(req, noteInputSchema);
  if (looksSecret(input.body)) throw new HttpError(400, "validation", "Please fix the highlighted fields.", { body: "Notes are read by the AI; keep keys and passwords out of them" });
  return { note: saveNote({ ...input, name: cur.name, source: "you" }) };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteNote(id)) throw notFound("Note");
  audit("agent.note_deleted", { id });
  return { ok: true };
});
