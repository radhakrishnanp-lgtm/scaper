import { handler, idParam, notFound, rateLimit } from "@/server/api";
import { getRecipe } from "@/server/repo/scrapes";
import { runScrape } from "@/server/scrape";

export const POST = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  rateLimit("scrape", 30, 10);
  const recipe = getRecipe(idParam.parse((await params).id));
  if (!recipe) throw notFound("Recipe");
  return { run: await runScrape({ url: recipe.url, mode: recipe.mode, extract: recipe.extract, recipeId: recipe.id }) };
});
