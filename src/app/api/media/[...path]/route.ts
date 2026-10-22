import { handler, notFound } from "@/server/api";
import { readMedia } from "@/server/watch/visual";

/** Screenshots and visual diffs saved by watchers (data/media). */
export const GET = handler(async (_req, { params }: { params: Promise<{ path: string[] }> }) => {
  const rel = (await params).path.join("/");
  if (!/^watchers\/[0-9a-f-]{36}\/[0-9a-f-]{36}(-diff)?\.png$/.test(rel)) throw notFound("File");
  const data = await readMedia(rel);
  if (!data) throw notFound("File");
  return new Response(new Uint8Array(data), { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } });
});
