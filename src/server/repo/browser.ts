import "server-only";
import { db } from "../db";
import { newId, now } from "./util";

/** History, bookmarks, extensions and annotations of Scaper's own visual browser. */

export type HistoryEntry = { id: number; url: string; title: string; host: string; visited_at: string };

/** One visit; the same page opened again within a minute only updates its title. */
export function addHistory(url: string, title: string) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return; }
  const last = db().prepare("SELECT id, url, visited_at FROM browser_history ORDER BY id DESC LIMIT 1").get() as { id: number; url: string; visited_at: string } | undefined;
  if (last && last.url === url && Date.now() - Date.parse(last.visited_at) < 60_000) {
    if (title) db().prepare("UPDATE browser_history SET title = ? WHERE id = ?").run(title.slice(0, 300), last.id);
    return;
  }
  db().prepare("INSERT INTO browser_history (url, title, host, visited_at) VALUES (?, ?, ?, ?)").run(url.slice(0, 4000), title.slice(0, 300), host, now());
}

export function setHistoryTitle(url: string, title: string) {
  if (!title) return;
  db().prepare("UPDATE browser_history SET title = ? WHERE id = (SELECT id FROM browser_history WHERE url = ? ORDER BY id DESC LIMIT 1)").run(title.slice(0, 300), url);
}

export function listHistory(opts: { q?: string; limit?: number; before?: number } = {}): HistoryEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.q) { where.push("(url LIKE ? OR title LIKE ?)"); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  if (opts.before) { where.push("id < ?"); args.push(opts.before); }
  return db().prepare(`SELECT * FROM browser_history ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(opts.limit ?? 100, 500)) as HistoryEntry[];
}

/** Address bar suggestions: most visited pages that match, then bookmarks. */
export function suggest(q: string, limit = 8) {
  const like = `%${q}%`;
  const bookmarks = db().prepare("SELECT url, title FROM browser_bookmarks WHERE url LIKE ? OR title LIKE ? LIMIT ?").all(like, like, limit) as { url: string; title: string }[];
  const visited = db().prepare(
    "SELECT url, MAX(title) AS title, COUNT(*) AS n FROM browser_history WHERE url LIKE ? OR title LIKE ? GROUP BY url ORDER BY n DESC, MAX(id) DESC LIMIT ?",
  ).all(like, like, limit) as { url: string; title: string }[];
  const seen = new Set<string>();
  return [...bookmarks.map((b) => ({ ...b, bookmark: true })), ...visited.map((v) => ({ ...v, bookmark: false }))]
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, limit);
}

export function deleteHistory(opts: { id?: number; olderThanDays?: number; all?: boolean }) {
  if (opts.id) return db().prepare("DELETE FROM browser_history WHERE id = ?").run(opts.id).changes;
  if (opts.olderThanDays) return db().prepare("DELETE FROM browser_history WHERE visited_at < ?").run(new Date(Date.now() - opts.olderThanDays * 86_400_000).toISOString()).changes;
  if (opts.all) return db().prepare("DELETE FROM browser_history").run().changes;
  return 0;
}

export type Bookmark = { id: string; url: string; title: string; created_at: string };
export const listBookmarks = () => db().prepare("SELECT * FROM browser_bookmarks ORDER BY created_at DESC").all() as Bookmark[];
export function addBookmark(url: string, title: string): Bookmark {
  db().prepare("INSERT INTO browser_bookmarks (id, url, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title")
    .run(newId(), url, title.slice(0, 300), now());
  return db().prepare("SELECT * FROM browser_bookmarks WHERE url = ?").get(url) as Bookmark;
}
export const deleteBookmark = (id: string) => db().prepare("DELETE FROM browser_bookmarks WHERE id = ?").run(id).changes > 0;

export type Extension = {
  id: string; name: string; version: string; description: string; source: "upload" | "store" | "folder"; store_id: string | null;
  options_page: string | null; popup_page: string | null; enabled: boolean; installed_at: string;
};
type ExtRow = Omit<Extension, "enabled"> & { enabled: number };
const toExt = (r: ExtRow): Extension => ({ ...r, enabled: Boolean(r.enabled) });
export const listExtensions = () => (db().prepare("SELECT * FROM browser_extensions ORDER BY installed_at").all() as ExtRow[]).map(toExt);
export const getExtension = (id: string) => { const r = db().prepare("SELECT * FROM browser_extensions WHERE id = ?").get(id) as ExtRow | undefined; return r ? toExt(r) : null; };
export function saveExtension(e: Omit<Extension, "installed_at" | "enabled"> & { enabled?: boolean }) {
  db().prepare(
    `INSERT INTO browser_extensions (id, name, version, description, source, store_id, options_page, popup_page, enabled, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description, source = excluded.source,
       store_id = excluded.store_id, options_page = excluded.options_page, popup_page = excluded.popup_page`,
  ).run(e.id, e.name, e.version, e.description, e.source, e.store_id, e.options_page, e.popup_page, e.enabled === false ? 0 : 1, now());
  return getExtension(e.id)!;
}
export const setExtensionEnabled = (id: string, on: boolean) => db().prepare("UPDATE browser_extensions SET enabled = ? WHERE id = ?").run(on ? 1 : 0, id).changes > 0;
export const deleteExtensionRow = (id: string) => db().prepare("DELETE FROM browser_extensions WHERE id = ?").run(id).changes > 0;

export type AnnotationElement = { tag: string; text: string; selector: string; href?: string };
export type Annotation = {
  id: string; url: string; title: string; x: number; y: number; w: number; h: number; note: string; color: string;
  element: AnnotationElement | null; created_at: string;
};
type AnnRow = Omit<Annotation, "element"> & { element: string | null };
const toAnn = (r: AnnRow): Annotation => ({ ...r, element: r.element ? JSON.parse(r.element) as AnnotationElement : null });

export function saveAnnotation(a: Omit<Annotation, "id" | "created_at">): Annotation {
  const row: Annotation = { ...a, id: newId(), created_at: now() };
  db().prepare("INSERT INTO browser_annotations (id, url, title, x, y, w, h, note, color, element, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.url, row.title.slice(0, 300), row.x, row.y, row.w, row.h, row.note, row.color, row.element ? JSON.stringify(row.element) : null, row.created_at);
  return row;
}
export const annotationsFor = (url: string) => (db().prepare("SELECT * FROM browser_annotations WHERE url = ? ORDER BY created_at").all(url) as AnnRow[]).map(toAnn);
export const recentAnnotations = (limit = 50) => (db().prepare("SELECT * FROM browser_annotations ORDER BY created_at DESC LIMIT ?").all(limit) as AnnRow[]).map(toAnn);
export function updateAnnotation(id: string, patch: { note?: string; color?: string }) {
  const cur = db().prepare("SELECT * FROM browser_annotations WHERE id = ?").get(id) as AnnRow | undefined;
  if (!cur) return null;
  db().prepare("UPDATE browser_annotations SET note = ?, color = ? WHERE id = ?").run(patch.note ?? cur.note, patch.color ?? cur.color, id);
  return toAnn({ ...cur, note: patch.note ?? cur.note, color: patch.color ?? cur.color });
}
export const deleteAnnotation = (id: string) => db().prepare("DELETE FROM browser_annotations WHERE id = ?").run(id).changes > 0;
export const clearAnnotations = (url?: string) => (url ? db().prepare("DELETE FROM browser_annotations WHERE url = ?").run(url) : db().prepare("DELETE FROM browser_annotations").run()).changes;
