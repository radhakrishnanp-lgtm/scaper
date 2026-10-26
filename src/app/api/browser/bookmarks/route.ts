import { handler, readJson } from "@/server/api";
import { addBookmark, listBookmarks } from "@/server/repo/browser";
import { bookmarkSchema } from "@/lib/schemas";

export const GET = handler(async () => ({ items: listBookmarks() }));
export const POST = handler(async (req) => { const b = await readJson(req, bookmarkSchema); return { bookmark: addBookmark(b.url, b.title) }; });
