import { handler, idParam, notFound, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { deleteRecipe, getRecipe, updateRecipe } from "@/server/repo/scrapes";
import { recipeSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const recipe = getRecipe(idParam.parse((await params).id));
  if (!recipe) throw notFound("Recipe");
  return { recipe };
});

export const PUT = handler(async (req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  const recipe = updateRecipe(id, await readJson(req, recipeSchema));
  if (!recipe) throw notFound("Recipe");
  audit("recipe.updated", { recipeId: id });
  return { recipe };
});

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const id = idParam.parse((await params).id);
  if (!deleteRecipe(id)) throw notFound("Recipe");
  audit("recipe.deleted", { recipeId: id });
  return { ok: true };
});
