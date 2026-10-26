import { z } from "zod";
import { handler, notFound, readJson } from "@/server/api";
import { removeExtension } from "@/server/live-browser/extensions";
import { getExtension, setExtensionEnabled } from "@/server/repo/browser";

type Ctx = { params: Promise<{ id: string }> };
const idSchema = z.string().regex(/^[a-z0-9]{8,64}$/, "Invalid id");

export const PATCH = handler(async (req, { params }: Ctx) => {
  const id = idSchema.parse((await params).id);
  const { enabled } = await readJson(req, z.object({ enabled: z.boolean() }));
  if (!setExtensionEnabled(id, enabled)) throw notFound("Extension");
  return { extension: getExtension(id) };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  if (!(await removeExtension(idSchema.parse((await params).id)))) throw notFound("Extension");
  return { ok: true };
});
