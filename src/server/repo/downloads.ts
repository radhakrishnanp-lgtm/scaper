import "server-only";
import { db } from "../db";
import { newId, now, pageSize } from "./util";

export type DownloadStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export type DownloadSource = "manual" | "task" | "agent" | "bot" | "api" | "finder";
export type Download = {
  id: string; url: string; folder: string; file_name: string; path: string | null; status: DownloadStatus;
  bytes: number; total_bytes: number | null; content_type: string | null; resumable: boolean; source: DownloadSource; ref_id: string | null;
  error: string | null; attempts: number; sha256: string | null; created_at: string; updated_at: string; finished_at: string | null;
};
type Row = Omit<Download, "resumable"> & { resumable: number };
const toDownload = (r: Row): Download => ({ ...r, resumable: Boolean(r.resumable) });

export const ACTIVE_DOWNLOAD: DownloadStatus[] = ["queued", "running", "paused"];

/** Adds files to the queue. A link already queued, running, paused or done in the same folder is skipped. */
export function addDownloads(items: { url: string; fileName: string; folder: string }[], source: DownloadSource, refId: string | null = null) {
  const t = now();
  const exists = db().prepare("SELECT 1 FROM downloads WHERE url = ? AND folder = ? AND status IN ('queued','running','paused','done') LIMIT 1");
  const insert = db().prepare(
    `INSERT INTO downloads (id, url, folder, file_name, status, source, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  );
  const added: string[] = [];
  let skipped = 0;
  db().transaction(() => {
    for (const it of items) {
      if (exists.get(it.url, it.folder)) { skipped++; continue; }
      const id = newId();
      insert.run(id, it.url, it.folder, it.fileName, source, refId, t, t);
      added.push(id);
    }
  })();
  return { added, skipped };
}

export function getDownload(id: string): Download | null {
  const r = db().prepare("SELECT * FROM downloads WHERE id = ?").get(id) as Row | undefined;
  return r ? toDownload(r) : null;
}

export function listDownloads(opts: { status?: string; q?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status === "active") where.push("status IN ('queued','running','paused')");
  else if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.q) { where.push("(url LIKE ? OR file_name LIKE ? OR folder LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  const rows = db().prepare(`SELECT * FROM downloads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, pageSize(opts.limit, 500, 200)) as Row[];
  return rows.map(toDownload);
}

export function downloadCounts() {
  const out: Record<DownloadStatus, number> & { bytes: number } = { queued: 0, running: 0, paused: 0, done: 0, failed: 0, cancelled: 0, bytes: 0 };
  for (const r of db().prepare("SELECT status, COUNT(*) c, SUM(bytes) b FROM downloads GROUP BY status").all() as { status: DownloadStatus; c: number; b: number | null }[]) {
    out[r.status] = r.c;
    if (r.status === "done") out.bytes = r.b ?? 0;
  }
  return out;
}

/** The oldest queued download, marked running. */
export function claimNextDownload(): Download | null {
  const r = db().prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Row | undefined;
  if (!r) return null;
  db().prepare("UPDATE downloads SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), r.id);
  return getDownload(r.id);
}

export function updateDownload(id: string, patch: Partial<Omit<Download, "id" | "created_at">>) {
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!fields.length) return;
  const sql = fields.map(([k]) => `${k} = ?`).join(", ");
  db().prepare(`UPDATE downloads SET ${sql}, updated_at = ? WHERE id = ?`).run(...fields.map(([k, v]) => (k === "resumable" ? (v ? 1 : 0) : v)), now(), id);
}

/** Moves downloads between states; returns how many changed. */
export function setDownloadStatus(ids: string[] | "all", from: DownloadStatus[], to: DownloadStatus, error: string | null = null) {
  const inFrom = from.map(() => "?").join(",");
  if (ids === "all") return db().prepare(`UPDATE downloads SET status = ?, error = ?, updated_at = ? WHERE status IN (${inFrom})`).run(to, error, now(), ...from).changes;
  let n = 0;
  const stmt = db().prepare(`UPDATE downloads SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (${inFrom})`);
  for (const id of ids) n += stmt.run(to, error, now(), id, ...from).changes;
  return n;
}

/** After a restart: a download that was running goes back in the queue and resumes from its partial file. */
export function requeueInterruptedDownloads() {
  return db().prepare("UPDATE downloads SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now()).changes;
}

export function deleteDownload(id: string) {
  return db().prepare("DELETE FROM downloads WHERE id = ?").run(id).changes > 0;
}

export function clearFinishedDownloads() {
  return db().prepare("DELETE FROM downloads WHERE status IN ('done','failed','cancelled')").run().changes;
}
