import { z } from "zod";
import { handler, notFound, readJson } from "@/server/api";
import { removeIncognitoNote } from "@/server/live-browser/session";
import { deleteAnnotation, updateAnnotation } from "@/server/repo/browser";

type Ctx = { params: Promise<{ id: string }> };
const patchSchema = z.object({ note: z.string().trim().max(2000).optional(), color: z.enum(["amber", "red", "green", "blue", "violet"]).optional() });

export const PATCH = handler(async (req, { params }: Ctx) => {
  const a = updateAnnotation((await params).id, await readJson(req, patchSchema));
  if (!a) throw notFound("Annotation");
  return { annotation: a };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = (await params).id;
  if (!removeIncognitoNote(id) && !deleteAnnotation(id)) throw notFound("Annotation");
  return { ok: true };
});
