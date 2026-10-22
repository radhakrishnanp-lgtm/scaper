import { handler, notFound } from "@/server/api";
import { readMedia } from "@/server/watch/visual";

/** Screenshots and visual diffs saved by watchers, and failure screenshots of task runs (data/media). */
export const GET = handler(async (_req, { params }: { params: Promise<{ path: string[] }> }) => {
  const rel = (await params).path.join("/");
  const watcher = /^watchers\/[0-9a-f-]{36}\/[0-9a-f-]{36}(-diff)?\.png$/.test(rel);
  const run = /^runs\/[0-9a-f-]{36}\.jpg$/.test(rel);
  if (!watcher && !run) throw notFound("File");
  const data = await readMedia(rel);
  if (!data) throw notFound("File");
  return new Response(new Uint8Array(data), { headers: { "content-type": run ? "image/jpeg" : "image/png", "cache-control": "private, max-age=31536000, immutable" } });
});
