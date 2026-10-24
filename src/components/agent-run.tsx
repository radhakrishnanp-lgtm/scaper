"use client";

import { useState } from "react";
import { Bot, Check, CheckCircle2, ChevronRight, EyeOff, Hand, Square, Wrench, X, XCircle } from "lucide-react";
import type { AgentRun, AgentStep } from "@/server/repo/agent";
import { CopyButton } from "@/components/data-table";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";

/** Pieces of an agent run (steps, approval card, one question and answer), shared by the agent and bot pages. */

export const TOOL_LABEL: Record<string, string> = {
  read_page: "Read page", extract_items: "Extracted items", extract_with_ai: "Extracted with AI", extract_with_selectors: "Extracted with selectors",
  suggest_selectors: "Worked out selectors", map_site: "Mapped site", plan_category_scrape: "Planned category scrape",
  browser_open: "Opened in browser", browser_act: "Browser action", browser_read: "Read browser page", browser_extract: "Extracted from browser",
  list_tasks: "Listed tasks", run_task: "Ran task", create_task: "Created task", set_task_schedule: "Changed schedule", delete_task: "Deleted task",
  list_runs: "Listed runs", get_run_rows: "Read run rows", compare_runs: "Compared runs",
  list_watchers: "Listed watchers", create_watcher: "Created watcher", check_watcher: "Checked watcher", pause_watcher: "Paused watcher", delete_watcher: "Deleted watcher", recent_changes: "Read recent changes",
  scan_deals: "Scanned deals", price_history: "Checked price history", list_tracked_products: "Listed tracked products", track_product: "Started tracking", untrack_product: "Stopped tracking", create_deal_search: "Created deal search",
  task_health: "Checked task health", repair_task: "Started AI repair", job_status: "Checked job", change_inbox: "Read change inbox", review_changes: "Marked changes reviewed", briefing: "Wrote briefing",
  notify_user: "Sent alert", site_info: "Checked site", slow_down_site: "Slowed down site", remember: "Remembered", forget: "Forgot", search_scaper: "Searched Scaper", ai_usage: "Checked AI usage",
  spawn_agents: "Started helpers", team_status: "Checked the team", wait_for_agents: "Waited for helpers", message_agent: "Messaged a helper", stop_agent: "Stopped a helper",
  app_guide: "Read the Scaper guide", list_notes: "Listed notes", read_note: "Read a note", write_note: "Wrote a note", delete_note: "Deleted a note",
  find_playbooks: "Looked up playbooks", save_playbook: "Saved a playbook", rate_playbook: "Rated a playbook", shared_memory_write: "Shared a note", shared_memory_read: "Read shared memory",
  decide: "Asked the decision model", check_scrape: "Checked if OK to scrape", pick_links: "Scored links",
  list_bots: "Listed bots", create_bot: "Created a bot", update_bot: "Changed a bot", run_bot: "Started a bot", delete_bot: "Deleted a bot",
  bot_memory_read: "Read its memory", bot_memory_write: "Saved to its memory", bot_memory_forget: "Forgot from its memory", notify_owner: "Sent you a message", bot_finish: "Finished its job",
  // Older conversations
  open_page: "Opened page",
};
export const money = (v: number) => (v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "");


function prettyResult(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export function StepView({ step, n }: { step: AgentStep; n: number }) {
  if (step.type === "answer") return null;
  if (step.type === "thought") return <p className="pl-8 text-sm text-muted italic">{step.text}</p>;
  const target = typeof step.args.url === "string" ? step.args.url : typeof step.args.name === "string" ? step.args.name : typeof step.args.task === "string" ? step.args.task : "";
  const args = Object.entries(step.args).filter(([k]) => k !== "url");
  return (
    <details className="group rounded-lg border border-border bg-surface-2/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        <span className="w-4 shrink-0 text-right text-xs text-muted tabular-nums">{n}</span>
        <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
        {step.ok ? <Wrench className="size-4 shrink-0 text-accent" aria-hidden /> : <XCircle className="size-4 shrink-0 text-danger" aria-label="Failed" />}
        <span className="shrink-0 font-medium">{TOOL_LABEL[step.name] ?? step.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{target}</span>
        {step.approval === "allowed" && <Badge tone="success">you allowed</Badge>}
        {step.approval === "declined" && <Badge tone="warning">you declined</Badge>}
        {step.ms !== undefined && step.ms >= 1000 && <span className="shrink-0 text-xs text-muted tabular-nums">{(step.ms / 1000).toFixed(1)}s</span>}
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2">
        {args.length > 0 && <p className="font-mono text-xs break-all text-muted">{args.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ")}</p>}
        {typeof step.args.url === "string" && <a href={step.args.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-accent hover:underline">{step.args.url}</a>}
        <pre className="scroll-thin max-h-72 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">{prettyResult(step.result)}</pre>
      </div>
    </details>
  );
}

export function StatusIcon({ status }: { status: AgentRun["status"] }) {
  if (status === "running") return <span className="size-2 animate-pulse rounded-full bg-accent" aria-label="Working" />;
  if (status === "done") return <CheckCircle2 className="size-4 text-success" aria-label="Done" />;
  return <XCircle className="size-4 text-danger" aria-label="Failed" />;
}

const sig = (p: number | null) => (p === null ? "–" : `${Math.round(p * 100)}%`);

/** "The agent wants to …": shown while a change waits for your OK. */
export function ApprovalCard({ run, onAnswered, who = "The agent" }: { run: AgentRun; onAnswered: () => void; who?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const p = run.pending!;
  const answer = async (decision: "allow" | "allow_all" | "deny") => {
    setBusy(decision);
    try { await api(`/api/agent/runs/${run.id}/approve`, { body: { decision } }); onAnswered(); }
    catch (e) { toast.error("Could not send your answer", errorText(e)); } finally { setBusy(null); }
  };
  const args = Object.entries(p.args).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <div role="alertdialog" aria-label={`${who} asks for your OK`} className="rounded-xl border-2 border-warning/60 bg-warning-soft/30 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold"><Hand className="size-4 text-warning" />{who} wants to: {p.summary}</p>
      {args.length > 0 && (
        <dl className="mt-2 grid gap-x-3 gap-y-0.5 font-mono text-xs sm:grid-cols-[auto_1fr]">
          {args.slice(0, 12).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-all">{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}
        </dl>
      )}
      {p.risk && (p.risk.reasons.length > 0 || p.risk.signals) && (
        <div className="mt-3 rounded-lg border border-border bg-surface/70 p-3">
          <p className="text-xs font-medium">{p.risk.reasons.length ? "Why Scaper asks" : "Safety check"}</p>
          {p.risk.reasons.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{p.risk.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          {p.risk.signals && (
            <p className="mt-1.5 text-xs text-muted">
              Decision model: matches your request {sig(p.risk.signals.matchesRequest)} · narrow scope {sig(p.risk.signals.narrowScope)} · easy to undo {sig(p.risk.signals.reversible)} · ambiguous {sig(p.risk.signals.ambiguous)} · needs a person {sig(p.risk.signals.needsReview)}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={<Check className="size-4" />} loading={busy === "allow"} disabled={Boolean(busy)} onClick={() => void answer("allow")}>Allow</Button>
        <Button size="sm" variant="secondary" loading={busy === "allow_all"} disabled={Boolean(busy)} onClick={() => void answer("allow_all")}>Allow all for this request</Button>
        <Button size="sm" variant="ghost" icon={<X className="size-4" />} loading={busy === "deny"} disabled={Boolean(busy)} onClick={() => void answer("deny")}>Decline</Button>
      </div>
      <p className="mt-2 text-xs text-muted">Waits up to 30 minutes, then declines. Change this in Settings → AI.</p>
    </div>
  );
}

/** One question and its answer; earlier turns of a conversation render compact. */
export function Turn({ run, compact, onStop, stopping, onAnswered, avatar, who, hidePrompt }: { run: AgentRun; compact?: boolean; onStop?: () => void; stopping?: boolean; onAnswered?: () => void; avatar?: React.ReactNode; who?: string; hidePrompt?: boolean }) {
  const tools = run.steps.filter((s) => s.type === "tool");
  const failed = tools.filter((s) => s.type === "tool" && !s.ok).length;
  let n = 0;
  return (
    <div className="space-y-3">
      {!hidePrompt && (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm whitespace-pre-wrap text-accent-fg">{run.prompt}</p>
        </div>
      )}
      <div className="flex gap-3">
        <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">{avatar ?? <Bot className="size-4" />}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <StatusIcon status={run.status} />
            <span className="font-mono">{run.model_label ?? run.model}</span>
            {run.private && <Badge><EyeOff className="size-3" />private</Badge>}
            <span>{tools.length} tool call{tools.length === 1 ? "" : "s"}{failed ? ` (${failed} failed)` : ""}</span>
            <span>{(run.tokens_in + run.tokens_out).toLocaleString("en-IN")} tokens{run.cost ? ` · ${money(run.cost)}` : ""}</span>
            <time title={dateTime(run.created_at)}>{timeAgo(run.created_at)}</time>
            {run.status === "running" && onStop && <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} loading={stopping} onClick={onStop}>Stop</Button>}
          </div>
          {compact ? (
            tools.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">{tools.length === 1 ? "Show the step" : `Show the ${tools.length} steps`}</summary><div className="mt-2 space-y-1.5">{run.steps.map((s, i) => <StepView key={i} step={s} n={s.type === "tool" ? ++n : n} />)}</div></details>
          ) : (
            run.steps.length > 0 && <div className="space-y-1.5">{run.steps.map((s, i) => <StepView key={i} step={s} n={s.type === "tool" ? ++n : n} />)}</div>
          )}
          {run.status === "running" && run.pending && onAnswered && <ApprovalCard run={run} onAnswered={onAnswered} who={who} />}
          {run.status === "running" && run.pending && !onAnswered && <p className="flex items-center gap-2 text-sm text-warning" role="status"><Hand className="size-4" />Waiting for your OK above.</p>}
          {run.status === "running" && !run.pending && <div className="flex items-center gap-2 text-sm text-muted" role="status"><span className="skeleton h-4 w-4 rounded-full" />Working: each page load waits for the site&apos;s polite delay.</div>}
          {run.status === "error" && run.error && <p role="alert" className={cn("rounded-lg p-3 text-sm", run.error === "Stopped by you." ? "bg-surface-2 text-muted" : "bg-danger-soft/60 text-danger")}>{run.error}</p>}
          {run.answer && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <Markdown text={run.answer} />
              {!compact && <div className="mt-3 flex justify-end border-t border-border pt-2"><CopyButton text={run.answer} label="Copy answer" /></div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
