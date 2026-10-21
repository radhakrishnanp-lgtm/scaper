import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { createRecipe, listRecipes } from "@/server/repo/scrapes";
import { recipeSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ recipes: listRecipes() }));

export const POST = handler(async (req) => {
  const recipe = createRecipe(await readJson(req, recipeSchema));
  audit("recipe.created", { recipeId: recipe.id });
  return { recipe };
});
