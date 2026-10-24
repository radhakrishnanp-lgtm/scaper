import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { log } from "../log";
import { newId, now, parseJson } from "./util";

// ---------------------------------------------------------------------------------------------
// Notes: Markdown the agent writes for itself (and you can edit). The database is the source of
// truth (so backups include them); each note is mirrored to data/knowledge/<name>.md.

export type NoteKind = "how-to" | "site" | "lesson" | "reference";
export type Note = { id: string; name: string; title: string; kind: NoteKind; body: string; version: number; source: "agent" | "you"; uses: number; created_at: string; updated_at: string };

export const MAX_NOTES = 200;
export const MAX_NOTE_CHARS = 20_000;
export const LESSONS_NOTE = "lessons-learned";

/** Notes are fed back to the model, so they must never hold keys or passwords. */
export const looksSecret = (s: string) => /(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bpassword\s*[:=]\s*\S+|\d{8,10}:[A-Za-z0-9_-]{30,})/i.test(s);

export const knowledgeDir = () => path.join(env.dataDir, "knowledge");
export const noteSlug = (s: string) => s.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note";

function mirror(n: Note | null, name: string) {
  try {
    const dir = knowledgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.md`);
    if (!n) { fs.rmSync(file, { force: true }); return; }
    const head = `---\ntitle: ${JSON.stringify(n.title)}\nkind: ${n.kind}\nversion: ${n.version}\nsource: ${n.source}\nupdated: ${n.updated_at}\n---\n\n`;
    fs.writeFileSync(file, head + n.body.trimEnd() + "\n", "utf8");
  } catch (e) {
    // The database copy is what counts; a read-only disk only loses the mirror.
    log.warn("knowledge.mirror_failed", { name, error: (e as Error).message });
  }
}

export function listNotes(q?: string): Note[] {
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    return db().prepare("SELECT * FROM agent_notes WHERE name LIKE ? OR title LIKE ? OR body LIKE ? ORDER BY updated_at DESC LIMIT 50").all(like, like, like) as Note[];
  }
  return db().prepare("SELECT * FROM agent_notes ORDER BY kind, title").all() as Note[];
}

export function getNote(nameOrId: string): Note | null {
  const k = nameOrId.trim();
  return (db().prepare("SELECT * FROM agent_notes WHERE id = ? OR name = ? OR lower(title) = lower(?)").get(k, noteSlug(k), k) as Note | undefined) ?? null;
}

/** Creates a note, or saves a new version of the note with the same name. */
export function saveNote(input: { name?: string; title: string; kind?: NoteKind; body: string; source?: "agent" | "you" }): Note {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new Error("A note needs a title.");
  const body = input.body.trim();
  if (!body) throw new Error("A note needs some text.");
  if (body.length > MAX_NOTE_CHARS) throw new Error(`Notes are limited to ${MAX_NOTE_CHARS.toLocaleString("en-IN")} characters; split it or summarise.`);
  const name = noteSlug(input.name || title);
  const t = now();
  const cur = getNote(name);
  if (cur) {
    db().prepare("UPDATE agent_notes SET title = ?, kind = ?, body = ?, version = version + 1, source = ?, updated_at = ? WHERE id = ?")
      .run(title, input.kind ?? cur.kind, body, input.source ?? "agent", t, cur.id);
  } else {
    const count = (db().prepare("SELECT COUNT(*) AS n FROM agent_notes").get() as { n: number }).n;
    if (count >= MAX_NOTES) throw new Error(`There are already ${MAX_NOTES} notes. Improve or merge an existing note instead.`);
    db().prepare("INSERT INTO agent_notes (id, name, title, kind, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId(), name, title, input.kind ?? "how-to", body, input.source ?? "agent", t, t);
  }
  const saved = getNote(name)!;
  mirror(saved, name);
  return saved;
}

export function deleteNote(nameOrId: string) {
  const n = getNote(nameOrId);
  if (!n) return false;
  db().prepare("DELETE FROM agent_notes WHERE id = ?").run(n.id);
  mirror(null, n.name);
  return true;
}

export function countNoteUse(id: string) {
  db().prepare("UPDATE agent_notes SET uses = uses + 1 WHERE id = ?").run(id);
}

/** Adds one lesson to the "Lessons learned" note, skipping one that is already there, newest first, at most 40. */
export function addLesson(lesson: string): Note | null {
  const text = lesson.replace(/\s+/g, " ").trim().slice(0, 300);
  if (text.length < 12) return null;
  const cur = getNote(LESSONS_NOTE);
  const lines = (cur?.body ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (lines.some((l) => key(l).includes(key(text)) || key(text).includes(key(l)))) return cur;
  const next = [text, ...lines].slice(0, 40);
  return saveNote({ name: LESSONS_NOTE, title: "Lessons learned", kind: "lesson", body: `What I learned from reviewing my own work. Newest first.\n\n${next.map((l) => `- ${l}`).join("\n")}` });
}

export function lessons(limit = 10): string[] {
  const n = getNote(LESSONS_NOTE);
  return n ? n.body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).slice(0, limit) : [];
}

// ---------------------------------------------------------------------------------------------
// Self-reviews of finished runs

export type Review = { id: string; run_id: string; score: number; summary: string; problems: string[]; lesson: string; note_name: string | null; tokens: number; cost: number; created_at: string };
type ReviewRow = Omit<Review, "problems"> & { problems: string };
const toReview = (r: ReviewRow): Review => ({ ...r, problems: parseJson<string[]>(r.problems, []) });

export function saveReview(r: Omit<Review, "id" | "created_at">): Review {
  const id = newId();
  db().prepare("INSERT OR REPLACE INTO agent_reviews (id, run_id, score, summary, problems, lesson, note_name, tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, r.run_id, r.score, r.summary.slice(0, 600), JSON.stringify(r.problems.slice(0, 6).map((p) => p.slice(0, 300))), r.lesson.slice(0, 300), r.note_name, r.tokens, r.cost, now());
  return getReview(r.run_id)!;
}

export function getReview(runId: string): Review | null {
  const r = db().prepare("SELECT * FROM agent_reviews WHERE run_id = ?").get(runId) as ReviewRow | undefined;
  return r ? toReview(r) : null;
}

export function listReviews(limit = 50): Review[] {
  return (db().prepare("SELECT * FROM agent_reviews ORDER BY created_at DESC LIMIT ?").all(limit) as ReviewRow[]).map(toReview);
}

export function reviewStats() {
  const r = db().prepare("SELECT COUNT(*) AS n, AVG(score) AS avg, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week FROM agent_reviews").get(new Date(Date.now() - 7 * 864e5).toISOString()) as { n: number; avg: number | null; week: number };
  return { reviews: r.n, average: r.avg === null ? null : Math.round(r.avg * 10) / 10, lastWeek: r.week };
}
