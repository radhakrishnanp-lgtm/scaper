import fs from "node:fs/promises";
import { handler, idParam, notFound } from "@/server/api";
import { cancelDownloads } from "@/server/downloads/manager";
import { deleteDownload, getDownload } from "@/server/repo/downloads";

/** Removes one download from the list; `?file=1` deletes the file too. */
export const DELETE = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  const d = getDownload(id);
  if (!d) throw notFound("Download");
  if (["queued", "running", "paused"].includes(d.status)) await cancelDownloads([id]);
  if (req.nextUrl.searchParams.get("file") === "1" && d.path) {
    await fs.rm(d.path, { force: true });
    await fs.rm(`${d.path}.part`, { force: true });
  }
  deleteDownload(id);
  return { ok: true };
});
