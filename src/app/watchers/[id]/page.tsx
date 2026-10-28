"use client";

import { AskAiButton } from "@/components/assistant";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, ChevronLeft, ChevronRight, CircleSlash, Eraser, ExternalLink, History, Image as ImageIcon, LineChart, ListChecks, MoreHorizontal, Pause, Pencil, Play, RefreshCw, Send, Settings2, Trash2, GitBranch } from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import type { Snapshot } from "@/server/repo/watchers";
import { PriceChart } from "@/components/charts";
import { CopyButton } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialog";
import { DiffViewer } from "@/components/diff-viewer";
import { Menu } from "@/components/menu";
import { JobStatusBadge, StatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, IconButton, KeyValue, LoadingRows, PageHeader, SearchInput, Select, Stat, Tabs } from "@/components/ui";
import { conditionText, DAYS, rulesText, targetInfo, type WatcherView } from "@/components/watcher-bits";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, duration, hostOf, interval, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";
import { VersionsTab } from "@/components/task-ops";

type Detail = { watcher: WatcherView; series: { value: number; created_at: string }[]; nextRuns: string[]; jobs: Job[]; current: { content: string; created_at: string; value: number | null; screenshot: string | null } | null };
type Side = { id: string; content: string; created_at: string; screenshot: string | null; visual_diff: string | null; visual_change: number | null; value: number | null; verdict: Snapshot["verdict"] };
type View = "changes" | "current" | "values" | "checks" | "setup" | "versions";

const media = (p: string) => `/api/media/${p}`;

function Changes({ id, watcher }: { id: string; watcher: WatcherView }) {
  const list = useApi<{ items: Snapshot[]; nextCursor: string | null }>(`/api/watchers/${id}/snapshots?limit=50&changed=1`);
  const [sid, setSid] = useQueryState<string>("change", "");
  const [against, setAgainst] = useState("");
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const selected = sid || items[0]?.id || "";
  const cmp = useApi<{ a: Side | null; b: Side }>(selected ? `/api/watchers/${id}/compare?b=${selected}${against ? `&a=${against}` : ""}` : null);
  const idx = items.findIndex((s) => s.id === selected);
  // A new selection compares with its own previous check again.
  const [lastSel, setLastSel] = useState(selected);
  if (lastSel !== selected) { setLastSel(selected); setAgainst(""); }

  if (list.loading && !list.data) return <Card><LoadingRows /></Card>;
  if (list.error) return <ErrorNote message={list.error} onRetry={list.reload} />;
  if (!items.length) {
    return (
      <Card>
        <EmptyState icon={<History className="size-5" />} title="No changes yet">
          {watcher.check_count ? `Checked ${watcher.check_count} time${watcher.check_count === 1 ? "" : "s"}; the content has stayed the same since the first check saved a baseline.` : "The first check saves a baseline. Changes after that appear here."}
        </EmptyState>
      </Card>
    );
  }

  const v = cmp.data?.b.verdict;
  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="h-fit overflow-hidden">
        <p className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted">{list.data?.nextCursor ? `${items.length}+ changes` : plural(items.length, "change")}, newest first</p>
        <ul className="scroll-thin max-h-[70vh] divide-y divide-border overflow-auto">
          {items.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setSid(s.id)} aria-current={s.id === selected} className={cn("block w-full px-4 py-3 text-left hover:bg-surface-2/50", s.id === selected && "bg-accent-soft/40")}>
                <p className="text-sm font-medium">{dateTime(s.created_at)}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                  {s.diff && <><span className="text-success">+{s.diff.added}</span><span className="text-danger">−{s.diff.removed}</span></>}
                  {s.visual_change !== null && <span className="text-muted">{s.visual_change.toFixed(1)}% pixels</span>}
                  {s.value !== null && <span className="text-muted">value {s.value.toLocaleString("en-IN")}</span>}
                  {s.triggered && <Badge tone="accent"><BellRing className="size-3" />alerted</Badge>}
                </p>
                {s.verdict?.reason && <p className="mt-1 line-clamp-2 text-xs text-muted">{s.verdict.reason}</p>}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <IconButton size="sm" label="Newer change" disabled={idx <= 0} onClick={() => setSid(items[idx - 1]!.id)}><ChevronLeft className="size-4" /></IconButton>
              <IconButton size="sm" label="Older change" disabled={idx < 0 || idx >= items.length - 1} onClick={() => setSid(items[idx + 1]!.id)}><ChevronRight className="size-4" /></IconButton>
              <span className="ml-1 text-sm">{cmp.data ? dateTime(cmp.data.b.created_at) : "…"}</span>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              Compare with
              <Select aria-label="Compare with" className="h-9 w-56" value={against} onChange={(e) => setAgainst(e.target.value)}>
                <option value="">the check before it</option>
                {items.filter((s) => s.id !== selected).map((s) => <option key={s.id} value={s.id}>{dateTime(s.created_at)}</option>)}
              </Select>
            </label>
          </div>
          {v && v.results.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
              {v.results.map((r, i) => <li key={i} className={r.met ? "text-text" : "text-muted"}>{r.met ? "✓" : "✗"} {r.reason || r.type}</li>)}
              {v.suppressed && <li className="text-warning">Alert held back: {v.suppressed}</li>}
            </ul>
          )}
        </Card>

        {cmp.loading && !cmp.data ? <Card><LoadingRows /></Card> : cmp.error ? <ErrorNote message={cmp.error} onRetry={cmp.reload} /> : cmp.data && (
          <>
            {(cmp.data.b.visual_diff || cmp.data.b.screenshot) && (
              <Card className="p-4">
                <p className="mb-3 flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4 text-muted" />Screenshots{cmp.data.b.visual_change !== null && <Badge tone="accent">{cmp.data.b.visual_change.toFixed(2)}% changed</Badge>}</p>
                <div className="grid gap-3 md:grid-cols-3">
                  {[{ src: cmp.data.a?.screenshot, label: "Before" }, { src: cmp.data.b.screenshot, label: "After" }, { src: cmp.data.b.visual_diff, label: "Differences in red" }].filter((x) => x.src).map((x) => (
                    <a key={x.label} href={media(x.src!)} target="_blank" rel="noreferrer noopener" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local screenshots served by the app */}
                      <img src={media(x.src!)} alt={x.label} className="w-full rounded-lg border border-border" loading="lazy" />
                      <p className="mt-1 text-xs text-muted">{x.label}</p>
                    </a>
                  ))}
                </div>
              </Card>
            )}
            <Card className="p-4">
              {cmp.data.a ? (
                <DiffViewer before={cmp.data.a.content} after={cmp.data.b.content} beforeLabel={dateTime(cmp.data.a.created_at)} afterLabel={dateTime(cmp.data.b.created_at)} />
              ) : <p className="text-sm text-muted">This is the first saved version, so there is nothing earlier to compare with.</p>}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Current({ d }: { d: Detail }) {
  const [q, setQ] = useState("");
  if (!d.current) return <Card><EmptyState icon={<History className="size-5" />} title="Not checked yet">Press Check now to read the page.</EmptyState></Card>;
  const lines = d.current.content.split("\n");
  const shown = q.trim() ? lines.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase())) : lines;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
          <p className="text-sm text-muted">What Scaper compares, after filters · saved {timeAgo(d.current.created_at)} · {lines.length} lines</p>
          <div className="flex items-center gap-2"><SearchInput value={q} onChange={setQ} placeholder="Find lines" className="w-52" /><CopyButton text={d.current.content} /></div>
        </div>
        <pre className="scroll-thin max-h-[65vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{shown.join("\n") || (q ? "No line contains that." : "(empty)")}</pre>
      </Card>
      {d.current.screenshot && (
        <Card className="h-fit p-3 lg:w-80">
          {/* eslint-disable-next-line @next/next/no-img-element -- local screenshot */}
          <a href={media(d.current.screenshot)} target="_blank" rel="noreferrer noopener"><img src={media(d.current.screenshot)} alt="Latest screenshot" className="w-full rounded-lg border border-border" /></a>
        </Card>
      )}
    </div>
  );
}

function WatcherDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Detail>(`/api/watchers/${id}`);
  const [view, setView] = useQueryState<View>("tab", "changes");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  void tick;

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  const w = data.watcher;
  const info = targetInfo(w.target.type);
  const o = w.options;

  const call = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error("Something went wrong", errorText(e)); } finally { setBusy(null); }
  };
  const checkNow = () => call("check", async () => {
    const r = await api<{ outcome: { status: string; message: string; changed: boolean; triggered: boolean } }>(`/api/watchers/${id}/check`, { method: "POST" });
    const o2 = r.outcome;
    if (o2.status === "ok") toast.success(o2.triggered ? "Changed, alert sent" : o2.changed ? "Changed (no alert: rules not met)" : "No change", o2.message);
    else if (o2.status === "queued") toast.info("Still running", o2.message);
    else toast.error(o2.status === "blocked" ? "The site blocked the check" : "The check failed", o2.message);
    void reload();
  });
  const toggle = () => call("toggle", async () => { await api(`/api/watchers/${id}`, { method: "PATCH", body: { enabled: !w.enabled } }); toast.success(w.enabled ? "Paused" : "Resumed"); void reload(); });
  const testAlert = () => call("test", async () => { const r = await api<{ message: string }>(`/api/watchers/${id}/test-alert`, { method: "POST" }); toast.success("Test alert sent", r.message); });
  const clearError = () => call("clear", async () => { await api(`/api/watchers/${id}/clear-error`, { method: "POST" }); toast.success("Error cleared", "Checks are back to the normal schedule."); void reload(); });
  const remove = () => call("delete", async () => { await api(`/api/watchers/${id}`, { method: "DELETE" }); toast.success("Watcher deleted"); router.push("/watchers"); });
  const channels = Object.entries(w.notify).filter(([, on]) => on).map(([c]) => (c === "desktop" ? "inbox" : c));

  return (
    <>
      <PageHeader
        title={w.name}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={w.last_status} enabled={w.enabled} failCount={w.fail_count} /><a href={w.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">{hostOf(w.url)}<ExternalLink className="size-3" /></a><span>· {info.label} · {rulesText(w)}</span>{w.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span>}
        actions={<>
          <Button icon={<RefreshCw className="size-4" />} loading={busy === "check"} onClick={checkNow}>Check now</Button>
          <AskAiButton session={{ key: `watcher:${id}`, name: w.name, focus: { kind: "watcher", id, title: `${w.name} (watcher ${id}; recent_changes and check_watcher work on it)`, url: w.url } }} />
          <Link prefetch={false} href={`/watchers/${id}/edit`}><Button variant="secondary" icon={<Pencil className="size-4" />}>Edit</Button></Link>
          <Menu label="More watcher actions" trigger={(p) => <IconButton {...p} label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: w.enabled ? "Pause" : "Resume", icon: w.enabled ? <Pause /> : <Play />, onSelect: () => void toggle() },
            { label: "Send a test alert", icon: <Send />, onSelect: () => void testAlert() },
            ...(w.fail_count ? [{ label: "Clear error", icon: <Eraser />, onSelect: () => void clearError() }] : []),
            { separator: true as const },
            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
          ]} />
        </>}
      />

      <div className="space-y-6">
        {!w.enabled && <Callout tone="warning" icon={<CircleSlash className="size-4 text-warning" />} title="Paused" action={<Button size="sm" variant="secondary" onClick={toggle}>Resume</Button>}>No checks run until you resume.</Callout>}
        {w.fail_count > 0 && w.last_error && (
          <Callout tone={w.fail_count >= 3 ? "danger" : "warning"} title={`The last ${w.fail_count > 1 ? `${w.fail_count} checks` : "check"} failed`} action={<Button size="sm" variant="secondary" onClick={clearError} loading={busy === "clear"}>Clear</Button>}>
            {w.last_error}{w.last_status === "blocked" && " Scaper does not get around blocks. Try a longer interval, Fast mode, or the site's API or feed."}
          </Callout>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Last check" value={<span className="text-base">{timeAgo(w.last_checked_at)}</span>} hint={dateTime(w.last_checked_at)} />
          <Stat label="Last change" value={<span className="text-base">{timeAgo(w.last_change_at)}</span>} hint={w.last_notified_at ? `alerted ${timeAgo(w.last_notified_at)}` : "no alerts yet"} />
          <Stat label="Changes" value={w.change_count} hint={plural(w.check_count, "check")} />
          <Stat label={w.target.type === "status" ? "Response" : "Value"} value={w.last_value !== null ? (w.target.type === "status" ? `${w.last_value} ms` : w.last_value.toLocaleString("en-IN")) : "—"} />
          <Stat label="Next check" value={<span className="text-base">{w.enabled ? timeAgo(data.nextRuns[0] ?? w.next_check_at) : "paused"}</span>} hint={o.cron ? `cron ${o.cron}` : `every ${interval(w.interval_minutes)}`} />
        </div>

        <Tabs value={view} onChange={setView} tabs={[
          { value: "changes", label: "Changes", icon: <History className="size-4" />, count: w.change_count },
          { value: "current", label: "Current content" },
          { value: "values", label: w.target.type === "status" ? "Response times" : "Values", icon: <LineChart className="size-4" />, hidden: data.series.length === 0 },
          { value: "checks", label: "Checks", icon: <ListChecks className="size-4" />, count: data.jobs.length },
          { value: "setup", label: "Setup", icon: <Settings2 className="size-4" /> },
          { value: "versions", label: "Versions", icon: <GitBranch className="size-4" /> },
        ]} />
        {view === "versions" && <VersionsTab kind="watcher" task={{ id }} onRestored={() => void reload()} />}

        {view === "changes" && <Changes id={id} watcher={w} />}
        {view === "current" && <Current d={data} />}
        {view === "values" && (
          <Card className="p-4">
            <PriceChart points={data.series.map((s) => ({ t: s.created_at, v: s.value }))} step={w.target.type === "price"} label={w.target.type === "status" ? "Response time" : "Value over time"}
              format={(v) => (w.target.type === "status" ? `${Math.round(v)} ms` : v.toLocaleString("en-IN"))}
              target={w.condition.type === "below" || w.condition.type === "above" ? w.condition.value : null} />
          </Card>
        )}
        {view === "checks" && (
          <Card>
            {!data.jobs.length ? <p className="p-5 text-sm text-muted">No checks yet.</p> : (
              <ul className="divide-y divide-border">
                {data.jobs.map((j) => {
                  const r = (j.result ?? {}) as { message?: string; changed?: boolean; triggered?: boolean };
                  return (
                    <li key={j.id}>
                      <Link prefetch={false} href={`/runs/${j.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 hover:bg-surface-2/40">
                        <JobStatusBadge status={j.status} />
                        <span className="text-sm">{dateTime(j.created_at)}</span>
                        <Badge>{j.trigger}</Badge>
                        {r.triggered ? <Badge tone="accent">alerted</Badge> : r.changed ? <Badge tone="warning">changed</Badge> : null}
                        <span className="text-xs text-muted">{duration(j.duration_ms)}</span>
                        {(j.error || r.message) && <span className={cn("w-full truncate text-xs", j.error ? "text-danger" : "text-muted")}>{j.error ?? r.message}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
        {view === "setup" && (
          <Card className="p-5">
            <KeyValue items={[
              { label: "URL", value: <a href={w.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">{w.url}</a> },
              { label: "Watches", value: `${info.label}${"selector" in w.target && w.target.selector ? ` · ${w.target.selector}` : ""}${w.target.type === "json" && w.target.path ? ` · ${w.target.path}` : ""}` },
              { label: "Loaded with", value: info.forcedMode ?? w.mode },
              { label: "Rules", value: <ul>{[w.condition, ...o.moreConditions].map((c, i) => <li key={i}>{conditionText(c, w.target.type)}</li>)}{o.moreConditions.length > 0 && <li className="text-muted">match {o.match}</li>}</ul> },
              { label: "Changes that count", value: o.triggerOn === "any" ? "additions and removals" : `only ${o.triggerOn === "added" ? "additions" : "removals"}` },
              { label: "Filters", value: [w.ignore_lines.length && `${w.ignore_lines.length} ignored phrases`, o.ignoreRegex && `ignore /${o.ignoreRegex}/`, o.onlyMatching && `keep /${o.onlyMatching}/`, o.ignoreNumbers && "numbers ignored", o.ignoreCase && "case ignored"].filter(Boolean).join(" · ") || "none" },
              { label: "Schedule", value: `${o.cron ? `cron ${o.cron}` : `every ${interval(w.interval_minutes)}`}${o.activeHours.enabled ? `, ${o.activeHours.start}–${o.activeHours.end} on ${o.activeHours.days.map((d) => DAYS[d]).join(", ")}` : ""}` },
              { label: "Page actions", value: o.steps.length ? `${o.steps.length} step${o.steps.length === 1 ? "" : "s"}` : "none" },
              { label: "Alerts to", value: channels.join(", ") || "inbox only" },
              { label: "Quiet period", value: o.cooldownMinutes ? interval(o.cooldownMinutes) : "none" },
              { label: "Extras", value: [o.aiSummary && "AI summary", o.screenshot && "screenshots"].filter(Boolean).join(", ") || "—" },
              { label: "Created", value: dateTime(w.created_at) },
            ]} />
          </Card>
        )}
      </div>

      <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={remove} busy={busy === "delete"} title={`Delete “${w.name}”?`} body="Its snapshots, screenshots and change history are deleted too." />
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><WatcherDetail id={id} /></Suspense>;
}
