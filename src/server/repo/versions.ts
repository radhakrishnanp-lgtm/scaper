import "server-only";
import { db } from "../db";
import { newId, now, parseJson } from "./util";

export type VersionKind = "task" | "watcher";
/** Who made the change: you in the editor, the AI repair (asked or automatic), a restore, or an import. */
export type VersionSource = "create" | "edit" | "ai_fix" | "auto_heal" | "restore" | "import" | "agent";

type Row = { id: string; kind: VersionKind; ref_id: string; version: number; data: string; source: VersionSource; note: string; created_at: string };
export type ConfigVersion = Omit<Row, "data"> & { data: Record<string, unknown> };

const TABLE: Record<VersionKind, string> = { task: "recipes", watcher: "watchers" };
const toVersion = (r: Row): ConfigVersion => ({ ...r, data: parseJson<Record<string, unknown>>(r.data, {}) });

/** Stable JSON (sorted keys) so "nothing changed" is detected regardless of key order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function latestVersion(kind: VersionKind, refId: string): ConfigVersion | null {
  const r = db().prepare("SELECT * FROM config_versions WHERE kind = ? AND ref_id = ? ORDER BY version DESC LIMIT 1").get(kind, refId) as Row | undefined;
  return r ? toVersion(r) : null;
}

/**
 * Saves a version when the setup actually changed and bumps the item's version number.
 * Returns the current version number either way.
 */
export function recordVersion(kind: VersionKind, refId: string, data: Record<string, unknown>, source: VersionSource, note = ""): number {
  return db().transaction(() => {
    const last = latestVersion(kind, refId);
    if (last && stableStringify(last.data) === stableStringify(data)) return last.version;
    const version = (last?.version ?? 0) + 1;
    db().prepare("INSERT INTO config_versions (id, kind, ref_id, version, data, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId(), kind, refId, version, JSON.stringify(data), source, note.slice(0, 300), now());
    db().prepare(`UPDATE ${TABLE[kind]} SET version = ? WHERE id = ?`).run(version, refId);
    return version;
  })();
}

/** Items made before version history existed get their current setup saved as version 1 before the first change. */
export function ensureBaseline(kind: VersionKind, refId: string, data: () => Record<string, unknown>) {
  if (!latestVersion(kind, refId)) recordVersion(kind, refId, data(), "create", "Setup when version history started");
}

export function listVersions(kind: VersionKind, refId: string, limit = 100): ConfigVersion[] {
  return (db().prepare("SELECT * FROM config_versions WHERE kind = ? AND ref_id = ? ORDER BY version DESC LIMIT ?").all(kind, refId, limit) as Row[]).map(toVersion);
}

export function getVersion(kind: VersionKind, refId: string, version: number): ConfigVersion | null {
  const r = db().prepare("SELECT * FROM config_versions WHERE kind = ? AND ref_id = ? AND version = ?").get(kind, refId, version) as Row | undefined;
  return r ? toVersion(r) : null;
}

export function deleteVersions(kind: VersionKind, refId: string) {
  return db().prepare("DELETE FROM config_versions WHERE kind = ? AND ref_id = ?").run(kind, refId).changes;
}
