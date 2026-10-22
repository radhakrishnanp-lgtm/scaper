"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCheck, ExternalLink, EyeOff, FileText, ImageIcon, Inbox, Newspaper, Send, Sparkles, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ChangeItem } from "@/server/repo/watchers";
import type { Briefing } from "@/server/ops/briefing";
import { Dialog } from "@/components/dialog";
import { useLive, useLiveEvents } from "@/components/live";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorNote, FilterChips, Kbd, LoadingRows, PageHeader, SearchInput, Segmented, Stat } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, hostOf, plural, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Status = "unreviewed" | "important" | "all" | "not_useful";
type Counts = { total: number; unreviewed: number; important: number; importantUnreviewed: number };
type Page = { items: ChangeItem[]; nextCursor: string | null; counts: Counts };
type Patch = Partial<Pick<ChangeItem, "reviewed_at" | "important" | "feedback">>;

const media = (p: string) => `/api/media/${p}`;

function headline(c: ChangeItem) {
  if (c.summary) return c.summary;
  const first = c.diff?.patch.find((p) => p.op !== " ");
  if (first) return `${first.op === "+" ? "Added" : "Removed"}: ${first.text}`;
  if (c.visual_change) return `${c.visual_change.toFixed(1)}% of the page looks different`;
  if (c.value !== null && c.value !== undefined) return `Value is now ${c.value}`;
  return "Changed";
}

/** "Not useful": pick the lines that shouldn't count as a change on this watcher again. */
function NotUsefulDialog({ change, onClose, onDone }: { change: ChangeItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const lines = useMemo(() => [...new Set((change.diff?.patch ?? []).filter((p) => p.op !== " ").map((p) => p.text.trim()).filter((t) => t.length > 1 && t.length <= 200))].slice(0, 20), [change]);
  const [pick, setPick] = useState<Set<string>>(() => new Set(lines.slice(0, 6)));
  const [busy, setBusy] = useState(false);
  const submit = async (ignore: boolean) => {
    setBusy(true);
    try {
      if (ignore && pick.size) await api(`/api/changes/${change.id}/ignore`, { body: { lines: [...pick] } });
      else await api("/api/changes", { body: { ids: [change.id], feedback: "not_useful", reviewed: true, important: false } });
      toast.success(ignore && pick.size ? `${plural(pick.size, "line")} ignored from now on` : "Marked not useful", "Your AI also learns from this when it judges this watcher's changes.");
      onDone();
    } catch (e) { toast.error("Could not save", errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} wide title="Not useful" description={`Tell ${change.watcher_name} what to ignore. History stays; only future checks are affected.`}
      footer={<>
        <Button variant="secondary" onClick={() => void submit(false)} loading={busy}>Just mark it</Button>
        <Button icon={<EyeOff className="size-4" />} disabled={!pick.size} loading={busy} onClick={() => void submit(true)}>Ignore {pick.size ? plural(pick.size, "line") : "lines"}</Button>
      </>}>
      {!lines.length ? <p className="text-sm text-muted">This change has no text lines to ignore. It is marked not useful, and the AI uses it as an example.</p> : (
        <div className="space-y-2">
          <p className="text-sm text-muted">Lines that contain these texts won&apos;t count as a change any more. Good for timestamps, counters, rotating ads and &quot;people are viewing this&quot;.</p>
          <ul className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {lines.map((l) => (
              <li key={l}>
                <Checkbox label={l} checked={pick.has(l)} onChange={(v) => setPick((s) => { const n = new Set(s); if (v) n.add(l); else n.delete(l); return n; })} className="w-full rounded-lg px-2 py-1.5 font-mono text-xs hover:bg-surface-2" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

/** Preview a briefing for any period, then send it to your channels or download it. */
function BriefingDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [ai, setAi] = useState(false);
  const [b, setB] = useState<Briefing | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [err, setErr] = useState<string | null>(null);
  const fetchBriefing = useCallback((send: boolean) => api<{ briefing: Briefing }>("/api/briefing", { body: { days: Number(days), ai, send } }), [days, ai]);
  // Preview whenever the period or the AI switch changes.
  useEffect(() => {
    let stop = false;
    void Promise.resolve().then(() => { if (!stop) setBusy("load"); return fetchBriefing(false); })
      .then((r) => { if (!stop) { setB(r.briefing); setErr(null); } }, (e) => { if (!stop) setErr(errorText(e)); })
      .finally(() => { if (!stop) setBusy(null); });
    return () => { stop = true; };
  }, [fetchBriefing]);
  const send = async () => {
    setBusy("send");
    try { const r = await fetchBriefing(true); setB(r.briefing); toast.success("Briefing sent", "To every alert channel you set up."); }
    catch (e) { toast.error("Could not send", errorText(e)); } finally { setBusy(null); }
  };
  return (
    <Dialog open onClose={onClose} xl title="Briefing" description="Everything your watchers saw, tasks that need attention and price alerts, in one page. Schedule it daily or weekly in Settings → Alerts."
      footer={<>
        <a href={`/api/briefing/export?days=${days}${ai ? "&ai=1" : ""}&format=md`}><Button variant="ghost" icon={<FileText className="size-4" />}>Markdown</Button></a>
        <a href={`/api/briefing/export?days=${days}${ai ? "&ai=1" : ""}`}><Button variant="secondary" icon={<FileText className="size-4" />}>Download page</Button></a>
        <Button icon={<Send className="size-4" />} loading={busy === "send"} disabled={!b} onClick={() => void send()}>Send now</Button>
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Period" value={days} onChange={setDays} options={[{ value: "1", label: "Last day" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }]} />
          <Checkbox label="AI summary" checked={ai} onChange={setAi} />
        </div>
        {err ? <Callout tone="danger" title="Could not build the briefing">{err}</Callout> : busy === "load" && !b ? <LoadingRows rows={5} /> : b && (
          <div className={cn("space-y-4", busy === "load" && "opacity-60")}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Changes" value={b.stats.changes} hint={`${b.stats.important} important`} />
              <Stat label="Task runs" value={b.stats.runs} hint={`${b.stats.failedRuns} failed`} />
              <Stat label="Need attention" value={b.stats.tasksNeedingAttention} hint={`${b.stats.openIssues} data issues`} />
              <Stat label="Price alerts" value={b.stats.priceAlerts} />
            </div>
            <div className="prose-sm rounded-xl border border-border p-4"><Markdown text={b.markdown} /></div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ChangeDetail({ c, onTriage, onNotUseful }: { c: ChangeItem; onTriage: (p: Patch & { feedback?: "useful" | "not_useful" | null }) => void; onNotUseful: () => void }) {
  const changed = c.diff?.patch ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link prefetch={false} href={`/watchers/${c.watcher_id}`} className="text-lg font-semibold hover:text-accent">{c.watcher_name}</Link>
            {c.important && <Badge tone="warning"><Star className="size-3" />Important</Badge>}
            {c.feedback === "not_useful" && <Badge>Not useful</Badge>}
            {c.feedback === "useful" && <Badge tone="success">Useful</Badge>}
          </div>
          <a href={c.watcher_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">{hostOf(c.watcher_url)}<ExternalLink className="size-3" /></a>
          <p className="text-xs text-muted">{dateTime(c.created_at)} · {c.target_type}{c.reviewed_at ? ` · reviewed ${timeAgo(c.reviewed_at)}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={c.important ? "primary" : "secondary"} icon={<Star className="size-4" />} onClick={() => onTriage({ important: !c.important })}>{c.important ? "Important" : "Mark important"}</Button>
          <Button size="sm" variant="secondary" icon={<ThumbsUp className="size-4" />} onClick={() => onTriage({ feedback: c.feedback === "useful" ? null : "useful" })} aria-pressed={c.feedback === "useful"}>Useful</Button>
          <Button size="sm" variant="secondary" icon={<ThumbsDown className="size-4" />} onClick={onNotUseful}>Not useful</Button>
        </div>
      </div>
      {c.summary && (
        <div className="rounded-xl border border-accent/30 bg-accent-soft/30 p-3 text-sm">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-accent"><Sparkles className="size-3.5" />Summary by your AI</p>
          {c.summary}
        </div>
      )}
      {c.diff && (
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">What changed <Badge tone="success">+{c.diff.added}</Badge><Badge tone="danger">−{c.diff.removed}</Badge></p>
          <div className="scroll-thin max-h-[50vh] overflow-auto rounded-xl border border-border font-mono text-xs">
            {changed.slice(0, 400).map((p, i) => (
              <div key={i} className={cn("flex gap-2 px-3 py-0.5", p.op === "+" ? "diff-add" : p.op === "-" ? "bg-danger-soft/40" : "text-muted")}>
                <span className="w-3 shrink-0 select-none">{p.op === " " ? "" : p.op === "+" ? "+" : "−"}</span>
                <span className="break-words whitespace-pre-wrap">{p.text}</span>
              </div>
            ))}
            {changed.length > 400 && <p className="px-3 py-1 text-muted">{changed.length - 400} more lines on the watcher page.</p>}
          </div>
        </div>
      )}
      {(c.visual_diff || c.screenshot) && (
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4 text-muted" />Screenshot{c.visual_change !== null && c.visual_change !== undefined && <Badge tone="accent">{c.visual_change.toFixed(2)}% changed</Badge>}</p>
          <a href={media(c.visual_diff ?? c.screenshot!)} target="_blank" rel="noreferrer noopener">
            {/* eslint-disable-next-line @next/next/no-img-element -- local screenshots served by the app */}
            <img src={media(c.visual_diff ?? c.screenshot!)} alt={c.visual_diff ? "Differences in red" : "Screenshot"} className="w-full rounded-xl border border-border" loading="lazy" />
          </a>
        </div>
      )}
      {c.value !== null && c.value !== undefined && !c.diff && <p className="text-sm">Value: <span className="font-semibold tabular-nums">{c.value}</span></p>}
      <Link prefetch={false} href={`/watchers/${c.watcher_id}`} className="inline-flex text-sm font-medium text-accent hover:underline">Open the watcher, its history and settings</Link>
    </div>
  );
}

function Changes() {
  const toast = useToast();
  const { setInbox } = useLive();
  const [status, setStatus] = useQueryState<Status>("status", "unreviewed");
  const [q, setQ] = useQueryState<string>("q", "");
  const [tag] = useQueryState<string>("tag", "");
  const [limit, setLimit] = useState(40);
  const path = `/api/changes?status=${status}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;
  const { data, error, loading, reload } = useApi<Page>(path);
  useLiveEvents((e) => { if (e.type === "notification") void reload(); });
  const [patches, setPatches] = useState<Record<string, Patch>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notUseful, setNotUseful] = useState<ChangeItem | null>(null);
  const [briefing, setBriefing] = useState(false);
  const items = useMemo(() => (data?.items ?? []).map((c) => ({ ...c, ...patches[c.id] })), [data, patches]);
  const current = items.find((c) => c.id === openId) ?? items[0] ?? null;
  const counts = data?.counts;
  useEffect(() => { if (counts) setInbox(counts.unreviewed); }, [counts, setInbox]);

  const triage = useCallback(async (ids: string[], p: Patch & { feedback?: "useful" | "not_useful" | null; reviewed?: boolean }) => {
    const local: Patch = {};
    if (p.reviewed !== undefined) local.reviewed_at = p.reviewed ? new Date().toISOString() : null;
    if (p.important !== undefined) local.important = p.important;
    if (p.feedback !== undefined) local.feedback = p.feedback;
    setPatches((x) => { const n = { ...x }; for (const id of ids) n[id] = { ...n[id], ...local }; return n; });
    try {
      const r = await api<{ counts: Counts }>("/api/changes", { body: { ids, reviewed: p.reviewed, important: p.important, feedback: p.feedback } });
      setInbox(r.counts.unreviewed);
    } catch (e) { toast.error("Could not save", errorText(e)); void reload(); }
  }, [reload, setInbox, toast]);

  const open = useCallback((c: ChangeItem) => {
    setOpenId(c.id);
    if (!c.reviewed_at) void triage([c.id], { reviewed: true });
  }, [triage]);

  // j / k to move, i important, e reviewed, x select: an inbox you can work through without the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable], dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = current ? items.findIndex((c) => c.id === current.id) : -1;
      if (e.key === "j" || e.key === "ArrowDown") { const n = items[Math.min(items.length - 1, i + 1)]; if (n) { e.preventDefault(); open(n); document.getElementById(`chg-${n.id}`)?.scrollIntoView({ block: "nearest" }); } }
      if (e.key === "k" || e.key === "ArrowUp") { const n = items[Math.max(0, i - 1)]; if (n) { e.preventDefault(); open(n); document.getElementById(`chg-${n.id}`)?.scrollIntoView({ block: "nearest" }); } }
      if (e.key === "i" && current) void triage([current.id], { important: !current.important });
      if (e.key === "e" && current) void triage([current.id], { reviewed: !current.reviewed_at });
      if (e.key === "x" && current) setSelected((s) => { const n = new Set(s); if (n.has(current.id)) n.delete(current.id); else n.add(current.id); return n; });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, current, open, triage]);

  const reviewAll = async () => {
    try {
      const r = await api<{ updated: number; counts: Counts }>("/api/changes/review-all", { method: "POST" });
      setInbox(r.counts.unreviewed);
      toast.success(`${plural(r.updated, "change")} marked reviewed`);
      setPatches({}); void reload();
    } catch (e) { toast.error("Could not save", errorText(e)); }
  };
  const bulk = (p: Patch & { reviewed?: boolean }) => { void triage([...selected], p); setSelected(new Set()); };

  return (
    <>
      <PageHeader title="Changes" description="Everything your watchers saw, in one inbox. Triage what matters; “Not useful” teaches the watcher what to ignore."
        actions={<>
          <Button variant="secondary" icon={<Newspaper className="size-4" />} onClick={() => setBriefing(true)}>Briefing</Button>
          <Button variant="secondary" icon={<CheckCheck className="size-4" />} disabled={!counts?.unreviewed} onClick={() => void reviewAll()}>Mark all reviewed</Button>
        </>} />
      {error ? <ErrorNote message={error} onRetry={reload} /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips label="Show" value={status} onChange={(v) => { setStatus(v); setOpenId(null); setSelected(new Set()); setLimit(40); }} options={[
              { value: "unreviewed", label: "To review", count: counts?.unreviewed },
              { value: "important", label: "Important", count: counts?.important },
              { value: "all", label: "All", count: counts?.total },
              { value: "not_useful", label: "Not useful" },
            ]} />
            <SearchInput value={q} onChange={setQ} placeholder="Search changes" className="ml-auto w-full sm:w-64" />
          </div>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/30 px-4 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <Button size="sm" variant="secondary" onClick={() => bulk({ reviewed: true })}>Mark reviewed</Button>
              <Button size="sm" variant="secondary" onClick={() => bulk({ reviewed: false })}>Mark to review</Button>
              <Button size="sm" variant="secondary" icon={<Star className="size-4" />} onClick={() => bulk({ important: true })}>Important</Button>
              <Button size="sm" variant="ghost" onClick={() => bulk({ important: false })}>Not important</Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}
          {loading && !data ? <Card><LoadingRows rows={8} /></Card> : !items.length ? (
            <Card>
              <EmptyState icon={<Inbox className="size-5" />} title={status === "unreviewed" ? "All caught up" : "No changes here"}>
                {status === "unreviewed" ? "Every change is reviewed. New ones land here as your watchers find them." : q ? "Nothing matches your search." : "Changes your watchers find show up here."}
              </EmptyState>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(300px,420px)_1fr]">
              <Card className="self-start overflow-hidden">
                <ul className="scroll-thin max-h-[calc(100vh-260px)] divide-y divide-border overflow-y-auto" aria-label="Changes">
                  {items.map((c) => {
                    const active = current?.id === c.id;
                    return (
                      <li key={c.id} id={`chg-${c.id}`} className={cn("flex gap-2 px-3 py-2.5", active ? "bg-accent-soft/40" : "hover:bg-surface-2/40")}>
                        <Checkbox hideLabel label={`Select ${c.watcher_name}`} checked={selected.has(c.id)} onChange={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(c.id); else n.delete(c.id); return n; })} className="mt-0.5" />
                        <button type="button" onClick={() => open(c)} className="min-w-0 flex-1 text-left" aria-current={active}>
                          <div className="flex items-center gap-1.5">
                            {!c.reviewed_at && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Not reviewed" />}
                            <span className={cn("truncate text-sm", !c.reviewed_at ? "font-semibold" : "font-medium")}>{c.watcher_name}</span>
                            {c.important && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Important" />}
                            <span className="ml-auto shrink-0 text-[11px] text-muted">{timeAgo(c.created_at)}</span>
                          </div>
                          <p className={cn("mt-0.5 line-clamp-2 text-xs", c.feedback === "not_useful" ? "text-muted line-through" : "text-muted")}>{headline(c)}</p>
                          {c.diff && <p className="mt-0.5 text-[11px] tabular-nums text-muted"><span className="text-success">+{c.diff.added}</span> <span className="text-danger">−{c.diff.removed}</span></p>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {data?.nextCursor && limit < 200 && <div className="border-t border-border p-2"><Button size="sm" variant="ghost" className="w-full" loading={loading} onClick={() => setLimit((l) => Math.min(200, l + 40))}>Show more</Button></div>}
              </Card>
              <Card className="p-5">
                {current && <ChangeDetail c={current} onTriage={(p) => void triage([current.id], p)} onNotUseful={() => setNotUseful(current)} />}
                <p className="mt-6 hidden flex-wrap gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted md:flex">
                  <span><Kbd>j</Kbd> <Kbd>k</Kbd> next / previous</span><span><Kbd>i</Kbd> important</span><span><Kbd>e</Kbd> reviewed</span><span><Kbd>x</Kbd> select</span>
                </p>
              </Card>
            </div>
          )}
        </div>
      )}
      {notUseful && <NotUsefulDialog change={notUseful} onClose={() => setNotUseful(null)} onDone={() => { setNotUseful(null); setPatches({}); void reload(); }} />}
      {briefing && <BriefingDialog onClose={() => setBriefing(false)} />}
    </>
  );
}

export default function Page() {
  return <Suspense><Changes /></Suspense>;
}
