import { handler } from "@/server/api";
import { suggest } from "@/server/repo/browser";

/** Address bar suggestions from bookmarks and history. */
export const GET = handler(async (req) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  return { items: q ? suggest(q) : [] };
});
