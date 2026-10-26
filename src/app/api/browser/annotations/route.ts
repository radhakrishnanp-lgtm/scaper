import { handler, readJson } from "@/server/api";
import { annotate, currentAnnotations, isIncognito, liveOpen } from "@/server/live-browser/session";
import { clearAnnotations, recentAnnotations } from "@/server/repo/browser";
import { annotationInputSchema } from "@/lib/schemas";

/** Annotations on the open page, or `?all=1` for the latest on every page. */
export const GET = handler(async (req) => ({ annotations: req.nextUrl.searchParams.get("all") ? recentAnnotations(200) : liveOpen() ? currentAnnotations() : [] }));

/** Draw a box with a note: `{x, y, w, h, note, color}` in page pixels. */
export const POST = handler(async (req) => ({ annotation: await annotate(await readJson(req, annotationInputSchema)) }));

/** Clear the annotations of one page `?url=` or of every page. */
export const DELETE = handler(async (req) => {
  if (isIncognito()) return { removed: 0 };
  const url = req.nextUrl.searchParams.get("url");
  return { removed: clearAnnotations(url ?? undefined) };
});
