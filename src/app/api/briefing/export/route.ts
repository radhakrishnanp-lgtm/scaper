import { handler } from "@/server/api";
import { briefingHtml, buildBriefing } from "@/server/ops/briefing";
import { getSettings } from "@/server/repo/settings";

/** Download a briefing as an HTML page (print it to PDF from the browser) or Markdown. */
export const GET = handler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const n = getSettings().notifications;
  const days = Math.min(31, Math.max(1, Number(sp.get("days") ?? 1)));
  const tags = sp.get("tags") ? sp.get("tags")!.split(",").map((t) => t.trim()).filter(Boolean) : n.digestTags;
  const b = await buildBriefing({ days, tags, match: n.digestTagMatch, ai: sp.get("ai") === "1" });
  const stamp = new Date().toISOString().slice(0, 10);
  if (sp.get("format") === "md") {
    return new Response(b.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="scaper-briefing-${stamp}.md"` } });
  }
  return new Response(briefingHtml(b), { headers: { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="scaper-briefing-${stamp}.html"` } });
});
