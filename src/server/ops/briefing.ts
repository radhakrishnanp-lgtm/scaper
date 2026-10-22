import "server-only";
import type { Settings } from "@/lib/schemas";
import { chat } from "../ai/client";
import { UNTRUSTED_NOTE } from "../ai/extract";
import { db } from "../db";
import { listChanges, type ChangeItem } from "../repo/watchers";
import { aiConfig } from "../ai/client";

export type BriefingOptions = { days: number; tags: string[]; match: "any" | "all"; ai: boolean };
export type BriefingWatcher = { id: string; name: string; url: string; changes: number; important: number; latest: string; at: string };
export type Briefing = {
  title: string; from: string; to: string; generatedAt: string;
  stats: { changes: number; important: number; watchers: number; runs: number; failedRuns: number; tasksNeedingAttention: number; openIssues: number; pendingRepairs: number; priceAlerts: number };
  summary: string | null;
  watchers: BriefingWatcher[];
  tasks: { id: string; name: string; problem: string }[];
  prices: { title: string; body: string; at: string }[];
  /** Nothing important happened and you chose to skip quiet briefings. */
  quiet: boolean;
  text: string; markdown: string;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function changeLine(c: ChangeItem) {
  if (c.summary) return c.summary;
  const lines = c.diff?.patch.filter((p) => p.op !== " ").slice(0, 2).map((p) => `${p.op} ${p.text.slice(0, 120)}`) ?? [];
  return lines.join(" · ") || (c.visual_change ? `${c.visual_change}% of the page looks different` : "Changed");
}

const tagMatch = (tags: string[], want: string[], match: "any" | "all") =>
  !want.length || (match === "all" ? want.every((t) => tags.includes(t)) : want.some((t) => tags.includes(t)));

/**
 * A briefing across everything Scaper watches: what changed (important first), tasks that need attention,
 * and price alerts, optionally with an executive summary written by your AI. Filtered by watcher tags.
 */
export async function buildBriefing(o: BriefingOptions): Promise<Briefing> {
  const to = new Date();
  const from = new Date(to.getTime() - o.days * 86400_000);
  const since = from.toISOString();
  const changes = listChanges({ since, limit: 200 }).items.filter((c) => tagMatch(c.watcher_tags, o.tags, o.match));

  const byWatcher = new Map<string, BriefingWatcher>();
  for (const c of changes) {
    const e = byWatcher.get(c.watcher_id) ?? { id: c.watcher_id, name: c.watcher_name, url: c.watcher_url, changes: 0, important: 0, latest: changeLine(c), at: c.created_at };
    e.changes++;
    if (c.important) e.important++;
    byWatcher.set(c.watcher_id, e);
  }
  const watchers = [...byWatcher.values()].sort((a, b) => b.important - a.important || b.changes - a.changes);

  const runs = db().prepare("SELECT COUNT(*) n, SUM(status IN ('error','blocked')) failed FROM scrape_runs WHERE recipe_id IS NOT NULL AND created_at >= ?").get(since) as { n: number; failed: number | null };
  const tasks = (db().prepare(
    `SELECT r.id, r.name, (SELECT diagnosis FROM scrape_runs s WHERE s.recipe_id = r.id ORDER BY created_at DESC LIMIT 1) diagnosis, r.last_status
     FROM recipes r WHERE r.health_alerted_at IS NOT NULL OR r.last_status IN ('error','blocked') LIMIT 20`,
  ).all() as { id: string; name: string; diagnosis: string | null; last_status: string | null }[])
    .map((t) => ({ id: t.id, name: t.name, problem: (t.diagnosis ? (JSON.parse(t.diagnosis) as { title?: string }).title : null) ?? `Last run: ${t.last_status ?? "unknown"}` }));
  const openIssues = (db().prepare("SELECT COUNT(*) c FROM quality_issues WHERE status = 'open'").get() as { c: number }).c;
  const pendingRepairs = (db().prepare("SELECT COUNT(*) c FROM heal_proposals WHERE status = 'pending'").get() as { c: number }).c;
  const prices = (db().prepare("SELECT title, body, created_at FROM notifications WHERE kind IN ('price','deal') AND created_at >= ? ORDER BY created_at DESC LIMIT 10").all(since) as { title: string; body: string; created_at: string }[])
    .map((p) => ({ title: p.title, body: p.body.split("\n")[0]!.slice(0, 160), at: p.created_at }));

  const important = changes.filter((c) => c.important).length;
  const stats = {
    changes: changes.length, important, watchers: watchers.length, runs: runs.n, failedRuns: runs.failed ?? 0,
    tasksNeedingAttention: tasks.length, openIssues, pendingRepairs, priceAlerts: prices.length,
  };
  const quiet = !important && !tasks.length && !prices.length;
  const label = o.days === 1 ? "Daily" : o.days === 7 ? "Weekly" : `${o.days}-day`;
  const title = `${label} briefing: ${plural(changes.length, "change")}${important ? `, ${important} important` : ""}${tasks.length ? `, ${plural(tasks.length, "task")} need attention` : ""}`;

  let summary: string | null = null;
  if (o.ai && aiConfig("main").configured && (changes.length || tasks.length || prices.length)) {
    const facts = [
      ...watchers.slice(0, 30).map((w) => `WATCHER ${w.name}: ${w.changes} change(s), ${w.important} important. Latest: ${w.latest}`),
      ...tasks.map((t) => `TASK ${t.name}: ${t.problem}`),
      ...prices.map((p) => `PRICE ${p.title}: ${p.body}`),
    ].join("\n");
    summary = await chat([
      { role: "system", content: `Write an executive summary of what changed on the websites the user monitors, in 3 to 5 short bullet points ("- "). Lead with what matters most (important changes, failures, price drops). Plain words, no headings, no preamble. ${UNTRUSTED_NOTE}` },
      { role: "user", content: `Period: ${from.toDateString()} to ${to.toDateString()}.\n<page>\n${facts.slice(0, 12_000)}\n</page>` },
    ], { model: "main", temperature: 0.2, maxTokens: 400, purpose: "briefing" }).then((r) => r.content.trim()).catch(() => null);
  }

  const md: string[] = [`# ${title}`, `${from.toDateString()} – ${to.toDateString()}`, ""];
  if (summary) md.push("## Summary", summary, "");
  md.push(`**${plural(changes.length, "change")}** on ${plural(watchers.length, "watcher")} · **${important}** important · **${runs.n}** task runs (${runs.failed ?? 0} failed) · **${openIssues}** open data issues · **${pendingRepairs}** repairs to review`, "");
  if (tasks.length) md.push("## Tasks that need attention", ...tasks.map((t) => `- **${t.name}**: ${t.problem}`), "");
  if (watchers.length) md.push("## Changes", ...watchers.slice(0, 40).map((w) => `- ${w.important ? "**Important** · " : ""}**${w.name}** (${plural(w.changes, "change")}): ${w.latest}`), "");
  if (prices.length) md.push("## Price alerts", ...prices.map((p) => `- **${p.title}**: ${p.body}`), "");
  if (!changes.length && !tasks.length && !prices.length) md.push("Nothing changed in this period.");
  const markdown = md.join("\n").trim();
  const text = markdown.replace(/^#+ /gm, "").replace(/\*\*/g, "");
  return { title, from: since, to: to.toISOString(), generatedAt: to.toISOString(), stats, summary, watchers, tasks, prices, quiet, text, markdown };
}

export function briefingOptions(n: Settings["notifications"], days?: number): BriefingOptions {
  return { days: days ?? (n.digest === "weekly" ? 7 : 1), tags: n.digestTags, match: n.digestTagMatch, ai: n.digestAi };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A standalone HTML page of a briefing, for download, print to PDF or forwarding. */
export function briefingHtml(b: Briefing) {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out: string[] = [];
  let list = false;
  for (const l of b.markdown.split("\n")) {
    if (l.startsWith("- ")) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (l.startsWith("# ")) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith("## ")) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (l) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  const body = out.join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1f2937}h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}li{margin:4px 0}p{color:#4b5563}footer{margin-top:40px;color:#9ca3af;font-size:12px}</style></head>
<body>${body}<footer>Generated by Scaper on ${new Date(b.generatedAt).toLocaleString()}</footer></body></html>`;
}
