"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BadgePercent, Bot, CheckCircle2, ChevronRight, CornerDownRight, ListChecks, MessageSquarePlus, Radar, Search, Send, ShieldCheck, Square, Trash2, Wrench, XCircle } from "lucide-react";
import type { AgentRun, AgentStep } from "@/server/repo/agent";
import { CopyButton } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialog";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, IconButton, Kbd, PageHeader, SearchInput, Switch, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

const EXAMPLES: { group: string; icon: React.ReactNode; items: string[] }[] = [
  { group: "Scrape", icon: <Search className="size-4" />, items: [
    "Open https://news.ycombinator.com and list the top 10 stories with their points and links.",
    "Work out selectors for the name, price and link of each product on https://books.toscrape.com and extract the first page.",
  ] },
  { group: "Deals", icon: <BadgePercent className="size-4" />, items: [
    "Find the 10 highest-discount wireless earbuds on https://www.amazon.in/s?k=wireless+earbuds with at least 4 stars, and tell me which discounts look real.",
    "Compare my tracked products and tell me which one is the best buy today, using their price history.",
  ] },
  { group: "Watch", icon: <Radar className="size-4" />, items: [
    "Watch https://example.com/careers and alert me when a job with \"Backend\" in the title appears. Check every 3 hours.",
    "What changed on my watched pages in the last 24 hours? Summarise the important changes.",
  ] },
  { group: "Tasks", icon: <ListChecks className="size-4" />, items: [
    "List my saved tasks and tell me which ones are failing.",
    "Run my task with \"jobs\" in its name and summarise the new rows.",
  ] },
];

const TOOLS: { name: string; label: string; what: string; changes?: boolean }[] = [
  { name: "open_page", label: "Opened page", what: "Reads a page's text and links." },
  { name: "extract_items", label: "Extracted items", what: "Finds lists, product data and tables automatically." },
  { name: "suggest_selectors", label: "Worked out selectors", what: "Proposes CSS selectors and tests them on the page." },
  { name: "extract_with_selectors", label: "Extracted with selectors", what: "Pulls exact fields with CSS selectors." },
  { name: "scan_deals", label: "Scanned deals", what: "Ranks a shop listing by discount and deal score." },
  { name: "price_history", label: "Checked price history", what: "Reads Scaper's own price history for a product." },
  { name: "list_tracked_products", label: "Listed tracked products", what: "Sees your tracked products and scores." },
  { name: "list_watchers", label: "Listed watchers", what: "Sees your watchers and their status." },
  { name: "recent_changes", label: "Read recent changes", what: "Reads what your watchers saw change." },
  { name: "list_tasks", label: "Listed tasks", what: "Sees your saved tasks and last runs." },
  { name: "track_product", label: "Started tracking", what: "Tracks a product's price.", changes: true },
  { name: "create_watcher", label: "Created watcher", what: "Creates a watcher.", changes: true },
  { name: "run_task", label: "Ran task", what: "Runs one of your saved tasks.", changes: true },
  { name: "notify_user", label: "Sent alert", what: "Sends you an alert.", changes: true },
];
const TOOL_LABEL = Object.fromEntries(TOOLS.map((t) => [t.name, t.label]));

type Detail = { run: AgentRun; thread: AgentRun[] };

function prettyResult(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function StepView({ step, n }: { step: AgentStep; n: number }) {
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
        <span className="min-w-0 truncate text-muted">{target}</span>
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2">
        {args.length > 0 && <p className="font-mono text-xs break-all text-muted">{args.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ")}</p>}
        {typeof step.args.url === "string" && <a href={step.args.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-accent hover:underline">{step.args.url}</a>}
        <pre className="scroll-thin max-h-72 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">{prettyResult(step.result)}</pre>
      </div>
    </details>
  );
}

function StatusIcon({ status }: { status: AgentRun["status"] }) {
  if (status === "running") return <span className="size-2 animate-pulse rounded-full bg-accent" aria-label="Working" />;
  if (status === "done") return <CheckCircle2 className="size-4 text-success" aria-label="Done" />;
  return <XCircle className="size-4 text-danger" aria-label="Failed" />;
}

/** One question and its answer; earlier turns of a conversation render compact. */
function Turn({ run, compact, onStop, stopping }: { run: AgentRun; compact?: boolean; onStop?: () => void; stopping?: boolean }) {
  const tools = run.steps.filter((s) => s.type === "tool");
  const failed = tools.filter((s) => s.type === "tool" && !s.ok).length;
  let n = 0;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm whitespace-pre-wrap text-accent-fg">{run.prompt}</p>
      </div>
      <div className="flex gap-3">
        <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Bot className="size-4" /></span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <StatusIcon status={run.status} />
            <span>{run.model}</span>
            <span>{tools.length} tool call{tools.length === 1 ? "" : "s"}{failed ? ` (${failed} failed)` : ""}</span>
            <span>{(run.tokens_in + run.tokens_out).toLocaleString("en-IN")} tokens</span>
            <time title={dateTime(run.created_at)}>{timeAgo(run.created_at)}</time>
            {run.status === "running" && onStop && <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} loading={stopping} onClick={onStop}>Stop</Button>}
          </div>
          {compact ? (
            tools.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">{tools.length === 1 ? "Show the step" : `Show the ${tools.length} steps`}</summary><div className="mt-2 space-y-1.5">{run.steps.map((s, i) => <StepView key={i} step={s} n={s.type === "tool" ? ++n : n} />)}</div></details>
          ) : (
            run.steps.length > 0 && <div className="space-y-1.5">{run.steps.map((s, i) => <StepView key={i} step={s} n={s.type === "tool" ? ++n : n} />)}</div>
          )}
          {run.status === "running" && <div className="flex items-center gap-2 text-sm text-muted" role="status"><span className="skeleton h-4 w-4 rounded-full" />Working: each page load waits for the site&apos;s polite delay.</div>}
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

function Composer({ value, onChange, onSubmit, busy, disabled, followUp, fast, setFast, fastModel }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean; disabled: boolean; followUp: boolean; fast: boolean; setFast: (v: boolean) => void; fastModel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, [followUp]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-3 p-4">
      <Textarea ref={ref} aria-label={followUp ? "Follow-up question" : "Task for the agent"} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-24"
        placeholder={followUp ? "Ask a follow-up, e.g. “Now track the top 3 and alert me below ₹2,000”" : "Find the best real deals on 55-inch TVs on Amazon India…"}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled) { e.preventDefault(); onSubmit(); } }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-72 max-w-full"><Switch checked={fast} onChange={setFast} label="Fast model" description={`Use ${fastModel || "the fast model"} for quick, cheap jobs.`} /></div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline"><Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd></span>
          <Button type="submit" loading={busy} disabled={disabled} icon={<Send className="size-4" />}>{followUp ? "Ask" : "Run"}</Button>
        </div>
      </div>
    </form>
  );
}

function AgentPage() {
  const toast = useToast();
  const [selected, setSelected] = useQueryState<string>("run", "");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const history = useApi<{ runs: AgentRun[] }>(`/api/agent/runs?limit=50${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`);
  const settings = useApi<{ settings: { ai: { baseUrl: string; model: string; fastModel: string } } }>("/api/settings");
  const [running, setRunning] = useState(false);
  const detail = useApi<Detail>(selected ? `/api/agent/runs/${selected}` : null, { pollMs: running ? 1200 : undefined });
  const [prompt, setPrompt] = useState("");
  const [fast, setFast] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [del, setDel] = useState<AgentRun | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const ai = settings.data?.settings.ai;
  const configured = Boolean(ai?.baseUrl && (ai.model || ai.fastModel));
  const run = detail.data?.run.id === selected ? detail.data.run : null;
  const isRunning = run?.status === "running";
  if (isRunning !== running) setRunning(isRunning);
  const { reload: reloadHistory } = history;
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    if (lastStatus.current === "running" && run.status !== "running") void reloadHistory();
    lastStatus.current = run.status;
  }, [run, reloadHistory]);
  const stepCount = run?.steps.length ?? 0;
  useEffect(() => { if (isRunning) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [stepCount, isRunning]);

  const start = async () => {
    if (prompt.trim().length < 3 || !configured) return;
    setStarting(true);
    try {
      const r = await api<{ run: AgentRun }>("/api/agent", { body: { prompt, useFastModel: fast, followUpOf: run && run.status !== "running" ? run.id : undefined } });
      setPrompt("");
      setSelected(r.run.id);
      void history.reload();
    } catch (e) { toast.error("The agent could not start", errorText(e)); } finally { setStarting(false); }
  };
  const stop = async () => {
    if (!run) return;
    setStopping(true);
    try { await api(`/api/agent/runs/${run.id}/stop`, { method: "POST" }); void detail.reload(); toast.info("Stopping", "It finishes the step it is on, then stops."); }
    catch (e) { toast.error("Could not stop", errorText(e)); } finally { setStopping(false); }
  };
  const remove = async (r: AgentRun) => {
    try {
      await api(`/api/agent/runs/${r.id}`, { method: "DELETE" });
      toast.success("Deleted");
      if (selected === r.id) setSelected("");
      setDel(null);
      void history.reload();
    } catch (e) { toast.error("Could not delete", errorText(e)); }
  };

  const today = useMemo(() => {
    const day = new Date().toDateString();
    const runs = (history.data?.runs ?? []).filter((r) => new Date(r.created_at).toDateString() === day);
    return { runs: runs.length, tokens: runs.reduce((a, r) => a + r.tokens_in + r.tokens_out, 0) };
  }, [history.data]);

  return (
    <>
      <PageHeader title="Agent" description="Ask in plain words. It scrapes, compares prices, tracks products and sets up watchers with your own AI model, and shows every step it takes."
        actions={selected ? <Button variant="secondary" icon={<MessageSquarePlus className="size-4" />} onClick={() => { setSelected(""); setPrompt(""); }}>New conversation</Button> : undefined} />
      {settings.data && !configured && (
        <div className="mb-6"><Callout tone="warning" title="Connect a model first" action={<Link href="/settings?tab=ai"><Button size="sm">Open AI settings</Button></Link>}>Any OpenAI-compatible endpoint works: OpenAI, OpenRouter, Groq, Together, DeepSeek, or Ollama and LM Studio on this computer. The model must support tool calling.</Callout></div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          {!selected ? (
            <>
              <Card>
                <Composer value={prompt} onChange={setPrompt} onSubmit={start} busy={starting} disabled={!configured || prompt.trim().length < 3} followUp={false} fast={fast} setFast={setFast} fastModel={ai?.fastModel} />
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                {EXAMPLES.map((g) => (
                  <Card key={g.group}>
                    <div className="space-y-2 p-4">
                      <p className="flex items-center gap-2 text-sm font-semibold"><span className="text-accent">{g.icon}</span>{g.group}</p>
                      {g.items.map((ex) => (
                        <button type="button" key={ex} onClick={() => setPrompt(ex)} className="block w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted hover:border-accent hover:text-text">{ex}</button>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
              <Card>
                <CardHeader title="What it can do" description="The agent only acts through these tools. The ones marked “changes things” run only when you ask for that." />
                <ul className="grid gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-2">
                  {TOOLS.map((t) => (
                    <li key={t.name} className="flex items-start gap-2">
                      <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                      <span><span className="font-medium">{t.label}</span> <span className="text-muted">{t.what}</span>{t.changes && <Badge tone="warning" className="ml-1.5">changes things</Badge>}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Callout icon={<ShieldCheck className="size-4 text-accent" />} title="Safety">Page content is passed to the model as data, and instructions found on pages are ignored. It never runs code the model writes and never tries to get past bot checks or logins. Every run counts towards your daily AI limit in Settings.</Callout>
            </>
          ) : detail.error && !run ? (
            <ErrorNote message={detail.error} onRetry={detail.reload} />
          ) : !run ? (
            <Card><div className="space-y-3 p-5"><div className="skeleton h-10 rounded-lg" /><div className="skeleton h-24 rounded-lg" /></div></Card>
          ) : (
            <Card>
              <CardHeader title={detail.data!.thread.length ? `Conversation · ${detail.data!.thread.length + 1} turns` : "Conversation"}
                actions={<IconButton label="Delete this turn" onClick={() => setDel(run)}><Trash2 className="size-4" /></IconButton>} />
              <div className="space-y-8 p-5">
                {detail.data!.thread.map((t) => (
                  <div key={t.id} className="opacity-90"><Turn run={t} compact /></div>
                ))}
                <Turn run={run} onStop={stop} stopping={stopping} />
                <div ref={bottom} />
              </div>
              <div className="border-t border-border">
                {isRunning ? (
                  <p className="p-4 text-sm text-muted">You can ask a follow-up once this answer is finished.</p>
                ) : (
                  <Composer value={prompt} onChange={setPrompt} onSubmit={start} busy={starting} disabled={!configured || prompt.trim().length < 3} followUp fast={fast} setFast={setFast} fastModel={ai?.fastModel} />
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title="History" description={history.data ? `${today.runs} run${today.runs === 1 ? "" : "s"} today · ${today.tokens.toLocaleString("en-IN")} tokens` : undefined} />
          <div className="border-b border-border p-3"><SearchInput value={q} onChange={setQ} placeholder="Search questions" className="w-full" /></div>
          {history.error ? <div className="p-4"><ErrorNote message={history.error} onRetry={history.reload} /></div> : !history.data ? (
            <div className="space-y-2 p-4"><div className="skeleton h-12 rounded-lg" /><div className="skeleton h-12 rounded-lg" /></div>
          ) : !history.data.runs.length ? (
            <EmptyState icon={<Bot className="size-5" />} title={debounced ? "No matches" : "No runs yet"}>{debounced ? "Try other words." : "Your questions and answers are kept here."}</EmptyState>
          ) : (
            <ul className="scroll-thin max-h-[70vh] divide-y divide-border overflow-y-auto">
              {history.data.runs.map((r) => (
                <li key={r.id} className={cn("group relative", selected === r.id && "bg-accent-soft/40")}>
                  <button type="button" onClick={() => setSelected(r.id)} className="w-full px-4 py-3 pr-10 text-left hover:bg-surface-2/50">
                    <p className="line-clamp-2 text-sm">{r.parent_id && <CornerDownRight className="mr-1 inline size-3.5 text-muted" aria-label="Follow-up" />}{r.prompt}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <Badge tone={r.status === "done" ? "success" : r.status === "error" ? (r.error === "Stopped by you." ? "neutral" : "danger") : "accent"}>{r.status === "error" && r.error === "Stopped by you." ? "stopped" : r.status}</Badge>
                      {timeAgo(r.created_at)}
                    </p>
                  </button>
                  <button type="button" aria-label="Delete" onClick={() => setDel(r)} className="absolute top-3 right-3 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"><Trash2 className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && void remove(del)} confirmLabel="Delete" title="Delete this question and answer?"
        body={del?.status === "running" ? "It is still working; it will be stopped first." : "Follow-up questions after it are kept."} />
    </>
  );
}

export default function Page() {
  return <Suspense><AgentPage /></Suspense>;
}
