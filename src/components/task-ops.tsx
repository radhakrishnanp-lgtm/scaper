"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bot, Check, CheckCircle2, CircleDot, History, Plus, RotateCcw, ShieldCheck, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type { Diagnosis, DiagnosisAction, Dataset } from "@/lib/types";
import { VALIDATION_CHECKS, VALUE_TYPES, type ValidationRule } from "@/lib/schemas";
import { describeRule, runValidation } from "@/lib/validation";
import type { Task } from "@/server/repo/scrapes";
import type { HealCheck, HealProposal } from "@/server/repo/heal";
import type { QualityIssue } from "@/server/repo/quality";
import type { RunValidationSummary } from "@/server/repo/scrapes";
import { api, errorText } from "@/lib/api-client";
import { dateTime, duration, hostOf, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/cn";
import { DataTable } from "./data-table";
import { ConfirmDialog, Dialog } from "./dialog";
import { DiffViewer } from "./diff-viewer";
import { CheckResults, DiagnosisCard, RunChart, ScoreBadge, StatusStrip, dailyCells, diagnosisHref, type RunPoint } from "./ops-bits";
import { RunStatusBadge } from "./status";
import { useToast } from "./toast";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, Input, LoadingRows, Segmented, Select, Stat } from "./ui";

export type HealthData = {
  successRate7d: number | null; successRate30d: number | null; runs30d: number; failStreak: number; p50: number | null; p95: number | null;
  expected: { low: number; high: number; median: number; runs: number } | null; unhealthySince: string | null;
  daily: { day: string; ok: number; failed: number; other: number }[];
  runs: (RunPoint & { id: string; jobId: string | null; pages: number; diagnosis: Diagnosis | null; validation: RunValidationSummary | null })[];
  latestDiagnosis: Diagnosis | null; issues: QualityIssue[]; pendingRepair: HealProposal | null;
};

const SOURCE: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" }> = {
  create: { label: "Created", tone: "neutral" }, edit: { label: "You edited", tone: "neutral" }, ai_fix: { label: "AI repair", tone: "accent" },
  auto_heal: { label: "Automatic repair", tone: "accent" }, restore: { label: "Restored", tone: "warning" }, import: { label: "Imported", tone: "neutral" }, agent: { label: "Agent", tone: "accent" },
};

/** The checks behind an AI repair, in words: rows before and after, against the last good run, and column fill. */
export function HealReport({ r }: { r: HealCheck }) {
  return (
    <div className="space-y-3">
      <Callout tone={r.passed ? "success" : "warning"} icon={r.passed ? <ShieldCheck className="size-4 text-success" /> : undefined}
        title={r.passed ? "The new selectors pass every check" : "The new selectors did not pass every check"}>
        {r.passed ? "They find data like the last good run did. " : <><ul className="list-disc pl-4">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></>}
        {r.note ? ` ${r.note}` : ""}
      </Callout>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Old selectors" value={r.before.toLocaleString("en-IN")} hint="rows on the page now" />
        <Stat label="New selectors" value={r.after.toLocaleString("en-IN")} hint="rows on the page now" />
        <Stat label="Last good run" value={r.baselineRows === null ? "—" : r.baselineRows.toLocaleString("en-IN")} hint={r.rowRatio !== null ? `${Math.round(r.rowRatio * 100)}% of its rows per page` : "no earlier run"} />
        <Stat label="Same items" value={r.keyOverlap === null ? "—" : `${Math.round(r.keyOverlap * 100)}%`} hint="key values seen before" />
      </div>
      {r.fill.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Column</th><th className="px-3 py-2 text-right font-medium">Filled before</th><th className="px-3 py-2 text-right font-medium">Filled now</th></tr></thead>
            <tbody className="divide-y divide-border">
              {r.fill.map((f) => {
                const drop = f.before !== null && f.before - f.after > 30;
                return (
                  <tr key={f.column}>
                    <td className="px-3 py-1.5">{f.column}{r.unchanged.includes(f.column) && <span className="ml-2 text-xs text-muted">unchanged</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">{f.before === null ? "—" : `${f.before}%`}</td>
                    <td className={cn("px-3 py-1.5 text-right tabular-nums", drop && "font-medium text-danger")}>{f.after}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">Tested on <a className="text-accent hover:underline" href={r.url} target="_blank" rel="noreferrer noopener">{hostOf(r.url)}</a>.</p>
    </div>
  );
}

type HealResponse = HealCheck & { extract: Task["extract"] };

/** "Fix with AI": your model proposes new selectors for the same columns, tested on the live page and checked against the last good run. */
export function HealDialog({ id, onClose, onApplied }: { id: string; onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<HealResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    let stop = false;
    api<HealResponse>(`/api/tasks/${id}/heal`, { method: "POST" }).then((r) => { if (!stop) setRes(r); }, (e) => { if (!stop) setErr(errorText(e)); }).finally(() => { if (!stop) setBusy(false); });
    return () => { stop = true; };
  }, [id]);
  const apply = async () => {
    if (!res) return;
    setApplying(true);
    try { await api(`/api/tasks/${id}/heal`, { body: { apply: res.extract } }); toast.success("New selectors saved", "Saved as a new version. You can roll back on the Versions tab."); onApplied(); }
    catch (e) { toast.error("Could not save", errorText(e)); } finally { setApplying(false); }
  };
  return (
    <Dialog open onClose={onClose} xl title="Fix with AI" description="Your model looks at the page as it is today and proposes selectors for the same columns. Transforms and other settings stay."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{res && res.after > 0 && <Button variant={res.passed ? "primary" : "secondary"} icon={<Sparkles className="size-4" />} loading={applying} onClick={apply}>{res.passed ? "Use the new selectors" : "Use them anyway"}</Button>}</>}>
      {busy ? <div className="space-y-2"><p className="text-sm text-muted">Loading the page and asking your model. This takes 10 to 40 seconds.</p><LoadingRows rows={3} /></div>
        : err ? <Callout tone="danger" title="Could not fix">{err}</Callout>
        : res && (
          <div className="space-y-4">
            <HealReport r={res} />
            {res.extract.type === "selectors" && (
              <div className="rounded-lg bg-surface-2/60 p-3 font-mono text-xs">
                {res.extract.itemSelector && <p><span className="text-muted">item:</span> {res.extract.itemSelector}</p>}
                {res.extract.fields.map((f) => <p key={f.name}><span className="text-muted">{f.name}:</span> {f.selector}{f.attr !== "text" ? ` @${f.attr}` : ""}</p>)}
              </div>
            )}
            {res.sample.length > 0 && <div className="overflow-hidden rounded-xl border border-border"><DataTable dataset={{ name: "Sample", columns: Object.keys(res.sample[0]!), rows: res.sample }} compact /></div>}
          </div>
        )}
    </Dialog>
  );
}

/** A repair waiting for review: what broke, what the AI changed, and how the change tested. */
export function PendingRepair({ taskId, p, onDone, compact }: { taskId: string; p: HealProposal; onDone: () => void; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const decide = async (action: "apply" | "dismiss") => {
    setBusy(action);
    try {
      await api(`/api/tasks/${taskId}/repairs/${p.id}`, { body: { action, runAfter: true } });
      toast.success(action === "apply" ? "Repair applied" : "Repair dismissed", action === "apply" ? "Saved as a new version and the task is running." : undefined);
      onDone();
    } catch (e) { toast.error("Could not save", errorText(e)); } finally { setBusy(null); }
  };
  return (
    <section className="rounded-[var(--radius-card)] border border-accent/40 bg-accent-soft/30 p-4" aria-label="A repair is ready">
      <div className="flex flex-wrap items-start gap-3">
        <Bot className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Your AI prepared a repair</p>
          <p className="text-sm text-muted">{p.reason.replace(/\.$/, "")}. {p.report ? `New selectors find ${plural(p.report.after, "row")} (old: ${p.report.before}${p.report.baselineRows !== null ? `, last good run: ${p.report.baselineRows}` : ""}).` : ""} {p.report && !p.report.passed ? "It did not pass every check, so it waits for you." : ""}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<Check className="size-4" />} loading={busy === "apply"} onClick={() => void decide("apply")}>Apply and run</Button>
            {!compact && p.report && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>See the checks</Button>}
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} loading={busy === "dismiss"} onClick={() => void decide("dismiss")}>Dismiss</Button>
          </div>
        </div>
        <span className="text-xs text-muted">{timeAgo(p.created_at)}</span>
      </div>
      {open && p.report && (
        <Dialog open onClose={() => setOpen(false)} xl title="How the repair tested" footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
          <div className="space-y-4">
            <HealReport r={p.report} />
            {p.report.sample.length > 0 && <div className="overflow-hidden rounded-xl border border-border"><DataTable dataset={{ name: "Sample", columns: Object.keys(p.report.sample[0]!), rows: p.report.sample }} compact /></div>}
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** What a failure-report action does on the task page itself. */
export function diagnosisActions(task: Task, handlers: { heal: () => void; retry: () => void }) {
  const href = diagnosisHref(task.id, hostOf(task.url));
  return {
    actionHref: (k: DiagnosisAction) => (k === "heal" || k === "retry" ? undefined : href(k)),
    onAction: (k: DiagnosisAction) => { if (k === "heal") handlers.heal(); else if (k === "retry") handlers.retry(); },
  };
}

/** Health tab: is this task doing its job? Uptime strip, rows against the usual range, timings, issues and repairs. */
export function HealthTab({ task, onHeal, onRetry, onChanged }: { task: Task; onHeal: () => void; onRetry: () => void; onChanged: () => void }) {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<HealthData>(`/api/tasks/${task.id}/health`);
  const [metric, setMetric] = useState<"rows" | "ms" | "score">("rows");
  const actions = diagnosisActions(task, { heal: onHeal, retry: onRetry });
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  if (!data.runs.length) return <Card><EmptyState icon={<CircleDot className="size-5" />} title="No runs yet">Health appears after the first run: success rate, usual row count, timings and data checks.</EmptyState></Card>;
  const open = data.issues.filter((i) => i.status === "open");
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
  const hasScores = data.runs.some((r) => r.score !== null && r.score !== undefined);
  return (
    <div className="space-y-5">
      {data.pendingRepair && <PendingRepair taskId={task.id} p={data.pendingRepair} onDone={() => { void reload(); onChanged(); }} />}
      {data.latestDiagnosis && <DiagnosisCard d={data.latestDiagnosis} {...actions} />}
      {data.unhealthySince && !data.latestDiagnosis && <Callout tone="warning" title="Marked unhealthy">Since {dateTime(data.unhealthySince)}. You get one alert per problem and another when it recovers.</Callout>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Success, 7 days" value={pct(data.successRate7d)} />
        <Stat label="Success, 30 days" value={pct(data.successRate30d)} hint={plural(data.runs30d, "run")} />
        <Stat label="Failed in a row" value={<span className={data.failStreak ? "text-danger" : undefined}>{data.failStreak}</span>} hint={data.failStreak ? `alert after ${task.options.health.failStreak}` : "none"} />
        <Stat label="Time (p50 / p95)" value={<span className="text-lg">{duration(data.p50)} / {duration(data.p95)}</span>} hint={task.options.health.maxDurationSeconds ? `alert above ${task.options.health.maxDurationSeconds} s` : undefined} />
        <Stat label="Usual rows" value={<span className="text-lg">{data.expected ? `${data.expected.low.toLocaleString("en-IN")}–${data.expected.high.toLocaleString("en-IN")}` : "learning"}</span>} hint={data.expected ? `from ${data.expected.runs} good runs` : "needs 5 good runs"} />
      </div>

      <Card>
        <CardHeader title="Last 30 days" description="One bar per day. Green worked, amber mixed, red failed, empty no runs." />
        <div className="px-4 pb-4"><StatusStrip cells={dailyCells(data.daily)} label="Run outcomes per day for the last 30 days" /></div>
      </Card>

      <Card>
        <CardHeader title={metric === "rows" ? "Rows per run" : metric === "ms" ? "Time per run" : "Data score per run"}
          description={metric === "rows" ? "The shaded band is the usual range learned from recent good runs. A run below it raises a health alert." : metric === "ms" ? "Seconds per run. Slow runs often mean the site is struggling or a page waits too long." : "The share of data checks that passed, 0 to 100."}
          actions={<Segmented label="Metric" value={metric} onChange={setMetric} options={[{ value: "rows", label: "Rows" }, { value: "ms", label: "Time" }, ...(hasScores ? [{ value: "score" as const, label: "Score" }] : [])]} />} />
        <div className="p-4">
          <RunChart label={`Task ${metric} per run`} runs={data.runs} metric={metric} band={data.expected} onOpen={(r) => { if (r.id) router.push(`/history/${r.id}`); }} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Data issues" description="A failing check opens an issue; it closes on the first run where the check passes again." actions={<Link prefetch={false} href={`/tasks/${task.id}?view=checks`}><Button size="sm" variant="secondary">Checks</Button></Link>} />
          <IssueList issues={data.issues.slice(0, 8)} empty={task.options.validation.rules.length ? "No issues. Every check passes." : "No data checks yet. Add some on the Checks tab."} />
          {open.length > 8 && <p className="px-5 pb-4 text-xs text-muted">{open.length - 8} more on the Checks tab.</p>}
        </Card>
        <Card>
          <CardHeader title="Recent runs" />
          <ul className="divide-y divide-border">
            {data.runs.slice(-8).reverse().map((r) => (
              <li key={r.id}>
                <Link prefetch={false} href={`/history/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm hover:bg-surface-2/40">
                  <RunStatusBadge status={r.status} />
                  <span className="tabular-nums">{plural(r.rows, "row")}</span>
                  <span className="text-muted">{duration(r.ms)}</span>
                  {r.score !== null && r.score !== undefined && <ScoreBadge score={r.score} status={r.validation?.status} />}
                  {r.version ? <Badge>v{r.version}</Badge> : null}
                  <span className="ml-auto text-xs text-muted">{timeAgo(r.at)}</span>
                  {r.diagnosis && <span className={cn("w-full truncate text-xs", r.diagnosis.severity === "error" ? "text-danger" : "text-warning")}>{r.diagnosis.title}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export function IssueList({ issues, empty }: { issues: QualityIssue[]; empty: string }) {
  if (!issues.length) return <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted"><CheckCircle2 className="size-4 text-success" />{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {issues.map((i) => (
        <li key={i.id} className="flex gap-3 px-5 py-3">
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", i.status === "resolved" ? "bg-success" : i.severity === "fail" ? "bg-danger" : "bg-warning")} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{i.label}</p>
              <Badge tone={i.status === "resolved" ? "success" : i.severity === "fail" ? "danger" : "warning"}>{i.status === "resolved" ? "Resolved" : i.severity === "fail" ? "Failing" : "Warning"}</Badge>
            </div>
            <p className="text-xs text-muted">{i.detail}</p>
            <p className="mt-0.5 text-xs text-muted">
              {i.status === "resolved" ? `Resolved ${timeAgo(i.resolved_at)} after ${plural(i.runs, "run")}` : `Open since ${timeAgo(i.first_seen)} · ${plural(i.runs, "run")}`}
              {i.last_run_id && <> · <Link prefetch={false} href={`/history/${i.last_run_id}`} className="text-accent hover:underline">Latest run</Link></>}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const CHECK_LABEL: Record<ValidationRule["check"], string> = {
  not_empty: "is filled in", unique: "has no duplicates", pattern: "matches a pattern", range: "is a number between", one_of: "is one of",
  type: "is of type", length: "has a length between", row_count: "Row count between", duplicates: "Duplicate rows at most",
};
const WHOLE_RUN = new Set<ValidationRule["check"]>(["row_count", "duplicates"]);
const newRuleId = () => Math.random().toString(36).slice(2, 10);

function RuleRow({ rule, columns, onChange, onRemove, result }: {
  rule: ValidationRule; columns: string[]; onChange: (r: ValidationRule) => void; onRemove: () => void; result?: { status: string; percent: number; detail: string };
}) {
  const set = (patch: Partial<ValidationRule>) => onChange({ ...rule, ...patch });
  const num = (v: string) => (v.trim() === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const whole = WHOLE_RUN.has(rule.check);
  const needsArg = rule.check === "pattern" || rule.check === "one_of";
  const needsRange = rule.check === "range" || rule.check === "length" || rule.check === "row_count";
  return (
    <li className={cn("space-y-2 px-4 py-3", !rule.enabled && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        {!whole && (
          <Select aria-label="Column" className="h-9 w-auto min-w-[8rem] text-sm" value={rule.column} onChange={(e) => set({ column: e.target.value })}>
            {!columns.includes(rule.column) && <option value={rule.column}>{rule.column} (not in the latest data)</option>}
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}
        <Select aria-label="Check" className="h-9 w-auto text-sm" value={rule.check} onChange={(e) => {
          const check = e.target.value as ValidationRule["check"];
          set({ check, column: WHOLE_RUN.has(check) ? "*" : rule.column === "*" ? columns[0] ?? "" : rule.column, arg: check === "type" ? "number" : needsArg ? rule.arg : "", min: null, max: check === "duplicates" ? 5 : null });
        }}>
          {VALIDATION_CHECKS.map((c) => <option key={c} value={c}>{CHECK_LABEL[c]}</option>)}
        </Select>
        {needsArg && <Input aria-label={rule.check === "pattern" ? "Regular expression" : "Allowed values"} className="h-9 min-w-[10rem] flex-1 font-mono text-sm" value={rule.arg} placeholder={rule.check === "pattern" ? "^\\d+$" : "In stock | Out of stock"} onChange={(e) => set({ arg: e.target.value })} />}
        {rule.check === "type" && (
          <Select aria-label="Type" className="h-9 w-auto text-sm" value={rule.arg} onChange={(e) => set({ arg: e.target.value })}>
            {VALUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        )}
        {needsRange && <>
          <Input aria-label="Minimum" className="h-9 w-24 text-sm" inputMode="decimal" placeholder="min" value={rule.min ?? ""} onChange={(e) => set({ min: num(e.target.value) })} />
          <span className="text-sm text-muted">to</span>
          <Input aria-label="Maximum" className="h-9 w-24 text-sm" inputMode="decimal" placeholder="max" value={rule.max ?? ""} onChange={(e) => set({ max: num(e.target.value) })} />
        </>}
        {rule.check === "duplicates" && <><Input aria-label="Maximum duplicate percentage" className="h-9 w-20 text-sm" inputMode="decimal" value={rule.max ?? ""} onChange={(e) => set({ max: num(e.target.value) })} /><span className="text-sm text-muted">%</span></>}
        <div className="ml-auto flex items-center gap-1.5">
          <Select aria-label="Severity" className="h-9 w-auto text-sm" value={rule.severity} onChange={(e) => set({ severity: e.target.value as ValidationRule["severity"] })}>
            <option value="fail">Fail the run</option>
            <option value="warn">Warn only</option>
          </Select>
          <button type="button" onClick={() => set({ enabled: !rule.enabled })} className="h-9 rounded-lg px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text">{rule.enabled ? "On" : "Off"}</button>
          <button type="button" onClick={onRemove} aria-label="Remove check" className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {!whole && (
          <label className="inline-flex items-center gap-1.5">
            Must pass in
            <Input aria-label="Share of rows that must pass" className="h-7 w-16 px-2 text-xs" inputMode="numeric" value={rule.mostly} onChange={(e) => set({ mostly: Math.min(100, Math.max(1, Number(e.target.value) || 100)) })} />
            % of rows
          </label>
        )}
        {rule.note && <span>· {rule.note}</span>}
        {result && rule.enabled && (
          <span className={cn("ml-auto inline-flex items-center gap-1 font-medium", result.status === "pass" ? "text-success" : result.status === "warn" ? "text-warning" : "text-danger")}>
            {result.status === "pass" ? "Passes" : result.status === "warn" ? "Warns" : "Fails"} on the latest data · {result.detail || `${result.percent}%`}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Checks tab: expectations each run's data must meet. Suggested from a good run (by Scaper or your AI), previewed
 * live against the latest data, scored per run, and tracked as issues that open and resolve.
 */
export function ChecksTab({ task, dataset, onSaved }: { task: Task; dataset: Dataset | null; onSaved: () => void }) {
  const toast = useToast();
  const saved = task.options.validation;
  const [rules, setRules] = useState<ValidationRule[]>(saved.rules);
  const [alert, setAlert] = useState(saved.alert);
  const [suggested, setSuggested] = useState<ValidationRule[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const issues = useApi<{ items: QualityIssue[] }>(`/api/tasks/${task.id}/issues`);
  const [issueFilter, setIssueFilter] = useState<"open" | "resolved">("open");
  const columns = dataset?.columns ?? [];
  const preview = useMemo(() => (dataset ? runValidation(dataset, rules.filter((r) => r.enabled)) : null), [dataset, rules]);
  const byId = new Map(preview?.results.map((r) => [r.ruleId, r]) ?? []);
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved.rules) || alert !== saved.alert;

  const suggest = async (ai: boolean) => {
    setBusy(ai ? "ai" : "data");
    try {
      const res = await api<{ rules: ValidationRule[]; fromAi: number; rows: number; dropped?: string[] }>(`/api/tasks/${task.id}/rules/suggest`, { body: { ai } });
      const have = new Set(rules.map((r) => `${r.column}|${r.check}`));
      const fresh = res.rules.filter((r) => !have.has(`${r.column}|${r.check}`));
      setSuggested(fresh);
      toast.success(fresh.length ? `${plural(fresh.length, "check")} suggested` : "Nothing new to suggest", ai ? `${res.fromAi} written by your AI from ${plural(res.rows, "row")}.` : `Learned from ${plural(res.rows, "row")} of the last good run.`);
    } catch (e) { toast.error("Could not suggest checks", errorText(e)); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy("save");
    try { await api(`/api/tasks/${task.id}/rules`, { method: "PUT", body: { rules, alert } }); toast.success("Checks saved", "They run on every run from now on."); onSaved(); }
    catch (e) { toast.error("Could not save", errorText(e)); } finally { setBusy(null); }
  };
  const add = (r: ValidationRule[]) => { setRules((x) => [...x, ...r].slice(0, 40)); setSuggested((s) => s?.filter((y) => !r.includes(y)) ?? null); };
  const items = issues.data?.items.filter((i) => i.status === issueFilter) ?? [];
  const openCount = issues.data?.items.filter((i) => i.status === "open").length ?? 0;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Data checks" description="What good data from this task looks like. A run that breaks a check gets a lower score, opens an issue and can alert you."
          actions={<>
            <Button size="sm" variant="secondary" icon={<Wand2 className="size-4" />} loading={busy === "data"} onClick={() => void suggest(false)}>Suggest from data</Button>
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} loading={busy === "ai"} onClick={() => void suggest(true)}>Suggest with AI</Button>
          </>} />
        {preview && rules.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-y border-border bg-surface-2/40 px-5 py-2.5 text-sm">
            <span className="text-muted">On the latest data ({plural(dataset!.rows.length, "row")}):</span>
            <ScoreBadge score={preview.score} status={preview.status} />
            <span className="text-muted">{preview.counts.pass} pass · {preview.counts.warn} warn · {preview.counts.fail} fail</span>
          </div>
        )}
        {rules.length ? (
          <ul className="divide-y divide-border">
            {rules.map((r, i) => (
              <RuleRow key={r.id} rule={r} columns={columns} result={byId.get(r.id)}
                onChange={(nr) => setRules((x) => x.map((y, j) => (j === i ? nr : y)))} onRemove={() => setRules((x) => x.filter((_, j) => j !== i))} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<ShieldCheck className="size-5" />} title="No checks yet">
            {dataset ? "Let Scaper or your AI suggest checks from the latest good run, or add your own." : "Run the task once, then suggest checks from its data."}
          </EmptyState>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={rules.length >= 40}
            onClick={() => setRules((x) => [...x, { id: newRuleId(), column: columns[0] ?? "*", check: columns.length ? "not_empty" : "row_count", arg: "", min: columns.length ? null : 1, max: null, mostly: 100, severity: "fail", enabled: true, note: "" }])}>
            Add a check
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted">
            Alert me when
            <Select className="h-9 w-auto text-sm" value={alert} onChange={(e) => setAlert(e.target.value as typeof alert)}>
              <option value="fail">a check fails</option>
              <option value="warn">a check fails or warns</option>
              <option value="off">never</option>
            </Select>
          </label>
          <Button size="sm" loading={busy === "save"} disabled={!dirty} onClick={() => void save()}>Save checks</Button>
        </div>
      </Card>

      {suggested && suggested.length > 0 && (
        <Card>
          <CardHeader title={`Suggested (${suggested.length})`} description="Add the ones that describe data you expect every time. They are tested on the latest data below."
            actions={<><Button size="sm" variant="ghost" onClick={() => setSuggested(null)}>Clear</Button><Button size="sm" icon={<Plus className="size-4" />} onClick={() => add(suggested)}>Add all</Button></>} />
          <ul className="divide-y divide-border">
            {suggested.map((r) => {
              const res = dataset ? runValidation(dataset, [r]).results[0] : undefined;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">{describeRule(r)}{r.note && <span className="text-muted"> · {r.note}</span>}</span>
                  <Badge tone={r.severity === "fail" ? "danger" : "warning"}>{r.severity === "fail" ? "fail" : "warn"}</Badge>
                  {res && <span className={cn("text-xs", res.status === "pass" ? "text-success" : "text-warning")}>{res.status === "pass" ? "passes now" : "fails now"}</span>}
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => add([r])}>Add</Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {preview && rules.length > 0 && (
        <Card>
          <CardHeader title="Results on the latest data" description="Updates as you edit, before you save." />
          <div className="px-4 pb-4"><CheckResults results={preview.results} /></div>
        </Card>
      )}

      <Card>
        <CardHeader title="Issues" description="Followed across runs: new when a check starts failing, resolved when it passes again."
          actions={<Segmented label="Issues" value={issueFilter} onChange={setIssueFilter} options={[{ value: "open", label: `Open (${openCount})` }, { value: "resolved", label: "Resolved" }]} />} />
        {issues.loading ? <div className="p-4"><LoadingRows rows={2} /></div> : <IssueList issues={items} empty={issueFilter === "open" ? "No open issues." : "Nothing resolved yet."} />}
      </Card>
    </div>
  );
}

type VersionItem = { id: string; version: number; source: string; note: string; created_at: string; data: Record<string, unknown>; runs: number; okRuns: number };
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** Versions tab: every saved setup, who changed it, how runs went on it, a diff against the current one and a one-click rollback. */
export function VersionsTab({ task, kind = "task", onRestored }: { task: { id: string; version?: number }; kind?: "task" | "watcher"; onRestored: () => void }) {
  const toast = useToast();
  const base = kind === "task" ? `/api/tasks/${task.id}/versions` : `/api/watchers/${task.id}/versions`;
  const { data, error, loading, reload } = useApi<{ current: number; items: VersionItem[] }>(base);
  const [sel, setSel] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<VersionItem | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={4} /></Card>;
  const items = data.items;
  const current = items.find((v) => v.version === data.current) ?? items[0];
  const chosen = items.find((v) => v.version === sel) ?? items.find((v) => v !== current) ?? null;
  const prev = chosen ? items.find((v) => v.version < chosen.version) : null;
  const restore = async () => {
    if (!confirm) return;
    setBusy(true);
    try { await api(`${base}/${confirm.version}`, { method: "POST" }); toast.success(`Version ${confirm.version} restored`, "Saved as a new version, so you can undo this too."); setConfirm(null); setSel(null); void reload(); onRestored(); }
    catch (e) { toast.error("Could not restore", errorText(e)); } finally { setBusy(false); }
  };
  if (items.length < 2) return <Card><EmptyState icon={<History className="size-5" />} title="Only one version so far">Each time you, the AI repair or the agent changes the setup, the old one is kept here. You can compare and roll back.</EmptyState></Card>;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <Card className="self-start">
        <CardHeader title={`${items.length} versions`} />
        <ol className="max-h-[70vh] divide-y divide-border overflow-y-auto">
          {items.map((v) => {
            const s = SOURCE[v.source] ?? { label: v.source, tone: "neutral" as const };
            const isCurrent = v.version === data.current;
            return (
              <li key={v.id}>
                <button type="button" onClick={() => setSel(v.version)} aria-current={chosen?.version === v.version}
                  className={cn("w-full px-4 py-3 text-left hover:bg-surface-2/50", chosen?.version === v.version && "bg-accent-soft/40")}>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums">v{v.version}</span>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {isCurrent && <Badge tone="success">Current</Badge>}
                    <span className="ml-auto text-xs text-muted">{timeAgo(v.created_at)}</span>
                  </div>
                  {v.note && <p className="mt-0.5 truncate text-xs text-muted">{v.note}</p>}
                  {kind === "task" && <p className="mt-0.5 text-xs text-muted">{v.runs ? `${plural(v.runs, "run")}, ${Math.round((v.okRuns / v.runs) * 100)}% worked` : "no runs"}</p>}
                </button>
              </li>
            );
          })}
        </ol>
      </Card>
      {chosen && current && (
        <Card>
          <CardHeader title={`v${chosen.version} compared with ${chosen === current ? `v${prev?.version ?? "—"}` : `the current v${current.version}`}`}
            description={`${SOURCE[chosen.source]?.label ?? chosen.source} · ${dateTime(chosen.created_at)}`}
            actions={chosen !== current ? <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm(chosen)}>Restore v{chosen.version}</Button> : undefined} />
          <div className="px-4 pb-4">
            {chosen === current
              ? prev ? <DiffViewer before={pretty(prev.data)} after={pretty(chosen.data)} beforeLabel={`v${prev.version}`} afterLabel={`v${chosen.version} (current)`} /> : <p className="text-sm text-muted">The first version.</p>
              : <DiffViewer before={pretty(current.data)} after={pretty(chosen.data)} beforeLabel={`v${current.version} (current)`} afterLabel={`v${chosen.version}`} />}
          </div>
        </Card>
      )}
      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={restore} busy={busy}
        title={`Restore version ${confirm?.version}?`} confirmLabel="Restore"
        body="The setup goes back to this version. It is saved as a new version, so the current setup stays in the list and you can switch back." />
    </div>
  );
}

const REPAIR_STATUS: Record<HealProposal["status"], { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  pending: { label: "Waiting for you", tone: "accent" }, applied: { label: "Applied", tone: "success" }, dismissed: { label: "Dismissed", tone: "neutral" }, failed: { label: "Could not repair", tone: "danger" },
};

/** Repairs tab: every time the AI looked at a broken task, what it proposed, how it tested and what happened. */
export function RepairsTab({ task, onHeal, onChanged }: { task: Task; onHeal: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<{ items: HealProposal[] }>(`/api/tasks/${task.id}/repairs`);
  const [open, setOpen] = useState<HealProposal | null>(null);
  const toast = useToast();
  const setMode = async (mode: Task["options"]["heal"]["mode"]) => {
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { heal: mode } });
      toast.success(mode === "auto" ? "Automatic repair on" : mode === "ask" ? "Repairs wait for you" : "Repair off");
      onChanged();
    } catch (e) { toast.error("Could not change", errorText(e)); }
  };
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={3} /></Card>;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="When this task breaks" description="When selectors stop finding data, your AI proposes new ones and Scaper tests them against the page and the last good run."
          actions={task.extract.type === "selectors" ? <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} onClick={onHeal}>Fix with AI now</Button> : undefined} />
        <div className="px-5 pb-5">
          {task.extract.type !== "selectors" ? <p className="text-sm text-muted">This task uses {task.extract.type} extraction, which adapts to layout changes by itself.</p> : (
            <Segmented label="Repair mode" value={task.options.heal.mode} onChange={(m) => void setMode(m)} options={[
              { value: "off", label: "Off" }, { value: "ask", label: "Prepare, I decide" }, { value: "auto", label: "Apply if checks pass" },
            ]} />
          )}
          <p className="mt-2 text-xs text-muted">
            {task.options.heal.mode === "auto" ? "A repair that passes every check is applied and the task re-runs. Others wait for you. Each one is a version you can roll back."
              : task.options.heal.mode === "ask" ? "Repairs are prepared and tested, then wait here for you to apply or dismiss."
              : "Nothing happens automatically. You can still press Fix with AI."} At most one attempt every 6 hours, and only when AI is set up.
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader title="Repair history" />
        {!data.items.length ? <p className="px-5 pb-5 text-sm text-muted">No repairs yet.</p> : (
          <ul className="divide-y divide-border">
            {data.items.map((p) => (
              <li key={p.id} className="px-5 py-3">
                {p.status === "pending" ? <PendingRepair taskId={task.id} p={p} onDone={() => { void reload(); onChanged(); }} /> : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <Badge tone={REPAIR_STATUS[p.status].tone}>{REPAIR_STATUS[p.status].label}</Badge>
                    <span className="min-w-0 flex-1 truncate">{p.reason}</span>
                    {p.report && <span className="text-xs tabular-nums text-muted">{p.report.before} → {p.report.after} rows</span>}
                    {p.report && <Button size="sm" variant="ghost" onClick={() => setOpen(p)}>Checks</Button>}
                    <span className="text-xs text-muted">{timeAgo(p.created_at)}</span>
                    {p.error && <p className="w-full text-xs text-danger">{p.error}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open?.report && (
        <Dialog open onClose={() => setOpen(null)} xl title="How the repair tested" description={`${REPAIR_STATUS[open.status].label} · ${dateTime(open.created_at)}`} footer={<Button variant="secondary" onClick={() => setOpen(null)}>Close</Button>}>
          <HealReport r={open.report} />
        </Dialog>
      )}
    </div>
  );
}

