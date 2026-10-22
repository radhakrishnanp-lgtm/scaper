import "server-only";
import { db } from "../db";
import type { RuleResult } from "@/lib/validation";
import { newId, now } from "./util";

export type QualityIssue = {
  id: string; recipe_id: string; rule_id: string; label: string; severity: "warn" | "fail"; status: "open" | "resolved"; detail: string;
  first_run_id: string | null; last_run_id: string | null; runs: number; first_seen: string; last_seen: string; resolved_at: string | null;
};

/**
 * Issues follow rules across runs: a failing rule opens an issue (new), keeps it open while it fails,
 * and resolves it on the first run where it passes again.
 */
export function trackIssues(recipeId: string, runId: string, results: RuleResult[]) {
  return db().transaction(() => {
    const open = db().prepare("SELECT * FROM quality_issues WHERE recipe_id = ? AND status = 'open'").all(recipeId) as QualityIssue[];
    const byRule = new Map(open.map((i) => [i.rule_id, i]));
    const t = now();
    const opened: QualityIssue[] = [];
    const resolved: QualityIssue[] = [];
    const checked = new Set(results.map((r) => r.ruleId));
    for (const r of results) {
      const existing = byRule.get(r.ruleId);
      if (r.status === "pass") {
        if (existing) {
          db().prepare("UPDATE quality_issues SET status = 'resolved', resolved_at = ?, last_run_id = ? WHERE id = ?").run(t, runId, existing.id);
          resolved.push({ ...existing, status: "resolved", resolved_at: t });
        }
        continue;
      }
      const detail = `${r.detail} (${r.percent}% passed)`;
      if (existing) {
        db().prepare("UPDATE quality_issues SET last_seen = ?, last_run_id = ?, runs = runs + 1, detail = ?, severity = ?, label = ? WHERE id = ?")
          .run(t, runId, detail, r.status, r.label, existing.id);
      } else {
        const issue: QualityIssue = {
          id: newId(), recipe_id: recipeId, rule_id: r.ruleId, label: r.label, severity: r.status, status: "open", detail,
          first_run_id: runId, last_run_id: runId, runs: 1, first_seen: t, last_seen: t, resolved_at: null,
        };
        db().prepare(`INSERT INTO quality_issues (id, recipe_id, rule_id, label, severity, status, detail, first_run_id, last_run_id, runs, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`).run(issue.id, recipeId, r.ruleId, r.label, r.status, detail, runId, runId, t, t);
        opened.push(issue);
      }
    }
    // A rule you deleted or turned off closes its issue.
    for (const i of open) {
      if (!checked.has(i.rule_id)) {
        db().prepare("UPDATE quality_issues SET status = 'resolved', resolved_at = ? WHERE id = ?").run(t, i.id);
      }
    }
    return { opened, resolved };
  })();
}

export function listIssues(recipeId: string, status?: "open" | "resolved", limit = 100): QualityIssue[] {
  return db().prepare(`SELECT * FROM quality_issues WHERE recipe_id = ? ${status ? "AND status = ?" : ""} ORDER BY status = 'open' DESC, last_seen DESC LIMIT ?`)
    .all(recipeId, ...(status ? [status] : []), limit) as QualityIssue[];
}

export function openIssueCounts(): Record<string, number> {
  const rows = db().prepare("SELECT recipe_id, COUNT(*) c FROM quality_issues WHERE status = 'open' GROUP BY recipe_id").all() as { recipe_id: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.recipe_id, r.c]));
}
