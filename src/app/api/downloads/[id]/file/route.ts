import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { handler, idParam, notFound } from "@/server/api";
import { downloadsRoot } from "@/server/downloads/manager";
import { getDownload } from "@/server/repo/downloads";

/** Opens or saves a finished download. Only files inside Scaper's downloads folder are served. */
export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const d = getDownload(id);
  if (!d || d.status !== "done" || !d.path) throw notFound("File");
  const full = path.resolve(d.path);
  if (!full.startsWith(path.resolve(downloadsRoot()) + path.sep) || !fs.existsSync(full)) throw notFound("File");
  const stat = fs.statSync(full);
  const inline = req.nextUrl.searchParams.get("open") === "1";
  const name = encodeURIComponent(path.basename(full));
  return new Response(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, {
    headers: {
      "content-type": d.content_type || "application/octet-stream", "content-length": String(stat.size),
      // Opened files are sandboxed: an HTML or SVG download cannot run scripts on Scaper's origin.
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'", "x-content-type-options": "nosniff",
    },
  });
});
