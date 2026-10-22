import "server-only";
import { db } from "../db";
import type { ExtractSpec } from "@/lib/schemas";
import type { Cell } from "@/lib/types";
import { newId, now, parseJson } from "./util";

/** How the AI's new selectors compare with the last good run, before anything is applied. */
export type HealCheck = {
  passed: boolean; url: string; before: number; after: number;
  baselineRows: number | null; rowRatio: number | null; keyOverlap: number | null;
  fill: { column: string; before: number | null; after: number }[];
  reasons: string[]; sample: Record<string, Cell>[]; note: string | null; unchanged: string[];
};

type Row = {
  id: string; recipe_id: string; run_id: string | null; status: "pending" | "applied" | "dismissed" | "failed"; reason: string;
  extract: string | null; report: string | null; error: string | null; created_at: string; decided_at: string | null;
};
export type HealProposal = Omit<Row, "extract" | "report"> & { extract: ExtractSpec | null; report: HealCheck | null; version?: number | null };

const toProposal = (r: Row): HealProposal => ({ ...r, extract: parseJson<ExtractSpec | null>(r.extract, null), report: parseJson<HealCheck | null>(r.report, null) });

export function addProposal(input: { recipeId: string; runId: string | null; status: Row["status"]; reason: string; extract?: ExtractSpec | null; report?: HealCheck | null; error?: string | null }) {
  const id = newId();
  db().prepare("INSERT INTO heal_proposals (id, recipe_id, run_id, status, reason, extract, report, error, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.recipeId, input.runId, input.status, input.reason, input.extract ? JSON.stringify(input.extract) : null, input.report ? JSON.stringify(input.report) : null,
      input.error ?? null, now(), input.status === "pending" ? null : now());
  return getProposal(id)!;
}

export function getProposal(id: string): HealProposal | null {
  const r = db().prepare("SELECT * FROM heal_proposals WHERE id = ?").get(id) as Row | undefined;
  return r ? toProposal(r) : null;
}

export function listProposals(recipeId: string, limit = 20): HealProposal[] {
  return (db().prepare("SELECT * FROM heal_proposals WHERE recipe_id = ? ORDER BY created_at DESC LIMIT ?").all(recipeId, limit) as Row[]).map(toProposal);
}

export function pendingProposal(recipeId: string): HealProposal | null {
  const r = db().prepare("SELECT * FROM heal_proposals WHERE recipe_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(recipeId) as Row | undefined;
  return r ? toProposal(r) : null;
}

export function pendingProposalCount(): number {
  return (db().prepare("SELECT COUNT(*) c FROM heal_proposals WHERE status = 'pending'").get() as { c: number }).c;
}

/** The newest attempt of any kind, so a broken task isn't re-diagnosed on every run. */
export function lastAttempt(recipeId: string): HealProposal | null {
  const r = db().prepare("SELECT * FROM heal_proposals WHERE recipe_id = ? ORDER BY created_at DESC LIMIT 1").get(recipeId) as Row | undefined;
  return r ? toProposal(r) : null;
}

export function decideProposal(id: string, status: "applied" | "dismissed") {
  return db().prepare("UPDATE heal_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), id).changes > 0;
}
