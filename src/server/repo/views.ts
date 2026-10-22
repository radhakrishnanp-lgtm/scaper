import "server-only";
import { db } from "../db";
import { newId, now, parseJson } from "./util";

type Row = { id: string; scope: string; name: string; state: string; created_at: string; updated_at: string };
export type SavedView = Omit<Row, "state"> & { state: Record<string, unknown> };
const toView = (r: Row): SavedView => ({ ...r, state: parseJson<Record<string, unknown>>(r.state, {}) });

/** Saved table views (columns, widths, filters, sort) per dataset scope, such as "task:<id>". */
export function listViews(scope: string): SavedView[] {
  return (db().prepare("SELECT * FROM saved_views WHERE scope = ? ORDER BY created_at LIMIT 50").all(scope) as Row[]).map(toView);
}

export function saveView(input: { id?: string; scope: string; name: string; state: Record<string, unknown> }): SavedView {
  const t = now();
  if (input.id) {
    const changed = db().prepare("UPDATE saved_views SET name = ?, state = ?, updated_at = ? WHERE id = ? AND scope = ?").run(input.name, JSON.stringify(input.state), t, input.id, input.scope).changes;
    if (changed) return toView(db().prepare("SELECT * FROM saved_views WHERE id = ?").get(input.id) as Row);
  }
  const id = newId();
  db().prepare("INSERT INTO saved_views (id, scope, name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.scope, input.name, JSON.stringify(input.state), t, t);
  return toView(db().prepare("SELECT * FROM saved_views WHERE id = ?").get(id) as Row);
}

export function deleteView(id: string) {
  return db().prepare("DELETE FROM saved_views WHERE id = ?").run(id).changes > 0;
}
